/**
 * Comment anchors. A thread on a passage is a mark on its text, so it moves with the text while
 * people write. The mark is the editor's alone: nothing parses it from HTML, saved HTML leaves it out
 * (withoutCommentAnchors), Markdown has no syntax for it, and adding or removing one is not an edit
 * (it neither marks the post changed nor enters undo). The comments keep where it sits, and find the
 * passage again by its words when the text changed some other way.
 *
 * Highlights are decorations over the marks of open threads, the selected one brighter, so a
 * resolved thread keeps its place without showing.
 */
import { Mark, type Editor } from '@tiptap/core';
import type { Node as PMNode, MarkType } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface CommentStorage {
    /** A click on highlighted text, with the open threads under it. */
    onOpen: ((ids: string[]) => void) | null;
    /** ⌘⌥M: comment on the selection. */
    onShortcut: (() => void) | null;
}

declare module '@tiptap/core' {
    interface Storage {
        comment: CommentStorage;
    }
}

export interface CommentsView {
    /** Threads to highlight. */
    open: string[];
    active: string | null;
    /** A passage someone is writing a new comment on, highlighted until the thread exists. */
    pending: { from: number; to: number } | null;
}

interface State extends CommentsView {
    deco: DecorationSet;
}

export const commentsKey = new PluginKey<State>('mh-comments');

export const CommentMark = Mark.create<Record<string, never>, CommentStorage>({
    name: 'comment',
    // Typing at either edge does not grow a comment, and threads may overlap.
    inclusive: false,
    excludes: '',
    spanning: true,
    addStorage: () => ({ onOpen: null, onShortcut: null }),
    addAttributes: () => ({ thread: { default: null, parseHTML: () => null, renderHTML: attrs => ({ 'data-mh-comment': attrs.thread }) } }),
    parseHTML: () => [],
    renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
    addKeyboardShortcuts() {
        return {
            'Mod-Alt-m': () => {
                if (!this.storage.onShortcut) return false;
                this.storage.onShortcut();
                return true;
            }
        };
    },
    addProseMirrorPlugins() {
        const type = this.type;
        const storage = this.storage;
        return [
            new Plugin<State>({
                key: commentsKey,
                state: {
                    init: () => ({ open: [], active: null, pending: null, deco: DecorationSet.empty }),
                    apply(tr, value, _old, state) {
                        const meta = tr.getMeta(commentsKey) as Partial<CommentsView> | undefined;
                        if (!meta && !tr.docChanged) return value;
                        const next = { ...value, ...meta };
                        if (next.pending && tr.docChanged && !(meta && 'pending' in meta)) {
                            const from = tr.mapping.map(next.pending.from, 1);
                            const to = tr.mapping.map(next.pending.to, -1);
                            next.pending = to > from ? { from, to } : null;
                        }
                        return { ...next, deco: highlights(state.doc, type, next) };
                    }
                },
                props: {
                    decorations: state => commentsKey.getState(state)?.deco,
                    handleClick(view, pos) {
                        const s = commentsKey.getState(view.state);
                        if (!s?.open.length) return false;
                        const ids = threadsAt(view.state.doc, pos, type).filter(id => s.open.includes(id));
                        if (ids.length) storage.onOpen?.(ids);
                        return false;
                    }
                }
            })
        ];
    }
});

function highlights(doc: PMNode, type: MarkType, view: CommentsView): DecorationSet {
    const open = new Set(view.open);
    const decos: Decoration[] = [];
    if (open.size) {
        doc.descendants((node, pos) => {
            if (!node.isText) return true;
            const ids = node.marks.filter(m => m.type === type && open.has(m.attrs.thread)).map(m => m.attrs.thread as string);
            if (ids.length) decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: `mh-comment${view.active && ids.includes(view.active) ? ' is-active' : ''}${ids.length > 1 ? ' is-stacked' : ''}` }));
            return false;
        });
    }
    if (view.pending) decos.push(Decoration.inline(view.pending.from, view.pending.to, { class: 'mh-comment is-pending' }));
    return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty;
}

function threadsAt(doc: PMNode, pos: number, type: MarkType): string[] {
    const $pos = doc.resolve(pos);
    const pick = (n: PMNode | null | undefined) => (n?.isText ? n.marks.filter(m => m.type === type).map(m => m.attrs.thread as string) : []);
    const after = pick($pos.nodeAfter);
    return after.length ? after : pick($pos.nodeBefore);
}

// ------------------------------------------------------------------ marking threads

function dispatch(editor: Editor, build: (tr: Editor['state']['tr']) => void) {
    if (editor.isDestroyed) return;
    const tr = editor.state.tr;
    build(tr);
    // Not an edit: nothing to save, nothing to undo.
    tr.setMeta('addToHistory', false).setMeta('preventUpdate', true);
    editor.view.dispatch(tr);
}

export function markThread(editor: Editor, id: string, from: number, to: number): void {
    const size = editor.state.doc.content.size;
    if (from < 0 || to > size || to <= from) return;
    dispatch(editor, tr => tr.addMark(from, to, editor.schema.marks.comment.create({ thread: id })));
}

export function unmarkThread(editor: Editor, id: string): void {
    dispatch(editor, tr => tr.removeMark(0, tr.doc.content.size, editor.schema.marks.comment.create({ thread: id })));
}

export function setCommentsView(editor: Editor, view: Partial<CommentsView>): void {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(commentsKey, view).setMeta('addToHistory', false));
}

/** Where each thread's mark sits now: from its first marked character to its last. */
export function markedRanges(doc: PMNode): Map<string, { from: number; to: number }> {
    const out = new Map<string, { from: number; to: number }>();
    doc.descendants((node, pos) => {
        if (!node.isText) return true;
        for (const m of node.marks) {
            if (m.type.name !== 'comment' || !m.attrs.thread) continue;
            const r = out.get(m.attrs.thread);
            out.set(m.attrs.thread, r ? { from: Math.min(r.from, pos), to: Math.max(r.to, pos + node.nodeSize) } : { from: pos, to: pos + node.nodeSize });
        }
        return false;
    });
    return out;
}

// ------------------------------------------------------------------ finding passages by their words

/** The document's text, one line per block, with where each piece of text sits in the document. */
interface TextIndex {
    text: string;
    segs: { pos: number; off: number; len: number }[];
}

export function textIndex(doc: PMNode): TextIndex {
    let text = '';
    const segs: TextIndex['segs'] = [];
    let blocks = 0;
    doc.descendants((node, pos) => {
        if (node.isTextblock && blocks++) text += '\n';
        if (node.isText) {
            segs.push({ pos, off: text.length, len: node.text!.length });
            text += node.text;
        }
        return true;
    });
    return { text, segs };
}

/** Text offset of a document position; `end` for the end of a range. Null outside any text. */
function offsetAt(ix: TextIndex, pos: number, end = false): number | null {
    for (const s of ix.segs) {
        if (end ? pos > s.pos && pos <= s.pos + s.len : pos >= s.pos && pos < s.pos + s.len) return s.off + (pos - s.pos);
    }
    return null;
}

function posAt(ix: TextIndex, off: number, end = false): number | null {
    for (const s of ix.segs) {
        if (end ? off > s.off && off <= s.off + s.len : off >= s.off && off < s.off + s.len) return s.pos + (off - s.off);
    }
    return null;
}

const CONTEXT = 32;

export interface Anchor {
    from: number;
    to: number;
    quote: string;
    prefix: string;
    suffix: string;
}

/** A range as an anchor: positions, its words, and a few words either side. */
export function anchorFor(doc: PMNode, from: number, to: number, ix = textIndex(doc)): Anchor | null {
    const a = offsetAt(ix, from);
    const b = offsetAt(ix, to, true);
    if (a == null || b == null || b <= a) return null;
    return { from, to, quote: ix.text.slice(a, b), prefix: ix.text.slice(Math.max(0, a - CONTEXT), a), suffix: ix.text.slice(b, b + CONTEXT) };
}

/**
 * Finds a saved passage in the document: where it was, if its words are still there; otherwise the
 * place its words appear whose surroundings match best, nearest the old place on a tie.
 */
export function findAnchor(doc: PMNode, saved: { quote: string; anchor: { from: number; to: number; prefix: string | null; suffix: string | null } | null }, ix = textIndex(doc)): { from: number; to: number } | null {
    const quote = saved.quote;
    if (!quote) return null;
    const at = saved.anchor;
    if (at && at.to <= doc.content.size) {
        const a = offsetAt(ix, at.from);
        const b = offsetAt(ix, at.to, true);
        if (a != null && b != null && ix.text.slice(a, b) === quote) return { from: at.from, to: at.to };
    }
    let best: { off: number; score: number; distance: number } | null = null;
    for (let off = ix.text.indexOf(quote), n = 0; off >= 0 && n < 2000; off = ix.text.indexOf(quote, off + 1), n++) {
        const score = common(ix.text.slice(Math.max(0, off - CONTEXT), off), at?.prefix ?? '', true) + common(ix.text.slice(off + quote.length, off + quote.length + CONTEXT), at?.suffix ?? '', false);
        const distance = at ? Math.abs((posAt(ix, off) ?? 0) - at.from) : off;
        if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { off, score, distance };
    }
    if (!best) return null;
    const from = posAt(ix, best.off);
    const to = posAt(ix, best.off + quote.length, true);
    return from != null && to != null && to > from ? { from, to } : null;
}

/** How many characters two strings share at their ends (`fromEnd`) or starts. */
function common(a: string, b: string, fromEnd: boolean): number {
    let n = 0;
    while (n < a.length && n < b.length && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++;
    return n;
}

/** Saved HTML without comment anchors (they belong to the comments, never to the post). */
export function withoutCommentAnchors(html: string): string {
    if (!html.includes('data-mh-comment')) return html;
    const t = document.createElement('template');
    t.innerHTML = html;
    for (const el of Array.from(t.content.querySelectorAll('span[data-mh-comment]'))) el.replaceWith(...Array.from(el.childNodes));
    return t.innerHTML;
}
