/**
 * House-style checks as you type: a TipTap extension that runs the rules
 * (style-rules.ts) on every paragraph and underlines what they find. A
 * paragraph is checked again only when it changes, so long posts stay quick.
 * What it finds is published in signals for the editor bar, the panel and the
 * fix menu (pages/checks.tsx).
 */
import { effect, signal } from '@preact/signals';
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { base, session } from '../api';
import { loadStyle, styleRules } from '../house-style';
import { checkText, LEAF, orderEdits, type CompiledRules, type Finding, type Fix } from './style-rules';

export interface BodyIssue extends Finding {
    /** The rule and where it starts: stable until text before it changes. */
    id: string;
    /** Where the paragraph's text starts in the document; the finding's offsets count from here. */
    base: number;
}

/** A post needs a link to another post from this many words on. */
export const LINK_WORDS = 150;

/** The editor being checked (one at a time). */
export const checkedEditor = signal<Editor | null>(null);
export const bodyIssues = signal<BodyIssue[]>([]);
/** The post is long enough to link to others and links to none. */
export const missingLink = signal(false);
/** The issue whose fix menu is open. */
export const openIssue = signal<string | null>(null);
/** Findings someone chose to leave, by key (loaded per post). */
export const ignoredKeys = signal<ReadonlySet<string>>(new Set());

interface BlockCheck {
    findings: Finding[];
    words: number;
    internalLinks: number;
}

interface CheckState {
    issues: BodyIssue[];
    missingLink: boolean;
    decorations: DecorationSet;
}

const key = new PluginKey<CheckState>('styleCheck');

// Unchanged paragraphs are the same node objects from one change to the next: their findings are kept.
let cache = new WeakMap<PMNode, BlockCheck>();
let cachedFor: CompiledRules | null = null;

/** A link into this blog, as the search checklist counts them (post-tools.tsx). */
function internal(href: string): boolean {
    const site = session.value?.site.url;
    return href.startsWith(base) || (!!site && href.startsWith(site));
}

function checkBlock(block: PMNode, rules: CompiledRules): BlockCheck {
    let text = '';
    let internalLinks = 0;
    block.forEach(child => {
        if (!child.isText) text += LEAF.repeat(child.nodeSize);
        // Code is quoted, not written: it keeps its offsets but is never checked.
        else text += child.marks.some(m => m.type.name === 'code') ? LEAF.repeat(child.text!.length) : child.text!;
        if (child.marks.some(m => m.type.name === 'link' && internal(String(m.attrs.href ?? '')))) internalLinks++;
    });
    const words = text.replaceAll(LEAF, ' ').split(/\s+/).filter(Boolean).length;
    return { findings: checkText(text, rules), words, internalLinks };
}

function compute(doc: PMNode): CheckState {
    const rules = styleRules.peek();
    if (rules !== cachedFor) {
        cache = new WeakMap();
        cachedFor = rules;
    }
    const ignored = ignoredKeys.peek();
    const open = openIssue.peek();
    const issues: BodyIssue[] = [];
    const decorations: Decoration[] = [];
    let words = 0;
    let internalLinks = 0;
    if (rules)
        doc.descendants((node, pos) => {
            if (!node.isTextblock) return true;
            if (node.type.spec.code) return false;
            let c = cache.get(node);
            if (!c) cache.set(node, (c = checkBlock(node, rules)));
            words += c.words;
            internalLinks += c.internalLinks;
            const start = pos + 1;
            for (const f of c.findings) {
                if (ignored.has(f.key)) continue;
                const id = `${f.rule}:${start + f.from}`;
                issues.push({ ...f, id, base: start });
                decorations.push(Decoration.inline(start + f.from, start + f.to, { class: `style-issue style-${f.rule}${id === open ? ' is-open' : ''}` }));
            }
            return false;
        });
    return { issues, missingLink: !!rules?.links && words >= LINK_WORDS && internalLinks === 0, decorations: DecorationSet.create(doc, decorations) };
}

function publish(state: CheckState | undefined) {
    if (!state) return;
    if (bodyIssues.peek() !== state.issues) bodyIssues.value = state.issues;
    if (missingLink.peek() !== state.missingLink) missingLink.value = state.missingLink;
}

function checkPlugin(): Plugin<CheckState> {
    return new Plugin<CheckState>({
        key,
        state: {
            init: (_config, state) => compute(state.doc),
            apply: (tr, prev, _old, state) => (tr.docChanged || tr.getMeta(key) ? compute(state.doc) : prev)
        },
        props: {
            decorations: state => key.getState(state)?.decorations,
            // A click on an underline opens its fix menu; anywhere else closes it. The click still places the cursor.
            handleClick: (view, pos) => {
                const hit = key.getState(view.state)?.issues.find(i => pos >= i.base + i.from && pos <= i.base + i.to);
                queueMicrotask(() => (openIssue.value = hit?.id ?? null));
                return false;
            }
        },
        view: view => {
            publish(key.getState(view.state));
            return { update: v => publish(key.getState(v.state)) };
        }
    });
}

const stops = new WeakMap<Editor, () => void>();

export const StyleCheck = Extension.create({
    name: 'styleCheck',
    addProseMirrorPlugins() {
        return [checkPlugin()];
    },
    onCreate() {
        const editor = this.editor;
        checkedEditor.value = editor;
        loadStyle();
        // New rules, an ignored finding or an opened menu: check again (unchanged paragraphs come from the cache).
        let first = true;
        const stop = effect(() => {
            styleRules.value;
            ignoredKeys.value;
            openIssue.value;
            if (first) {
                first = false;
                return;
            }
            queueMicrotask(() => !editor.isDestroyed && editor.view.dispatch(editor.state.tr.setMeta(key, true)));
        });
        stops.set(editor, stop);
    },
    onDestroy() {
        stops.get(this.editor)?.();
        if (checkedEditor.peek() !== this.editor) return;
        checkedEditor.value = null;
        bodyIssues.value = [];
        missingLink.value = false;
        openIssue.value = null;
    }
});

/** Makes fixes as one change, so one undo takes them all back. Returns how many issues it fixed. */
export function applyFixes(editor: Editor, items: { issue: BodyIssue; fix: Fix }[]): number {
    const edits = orderEdits(items.flatMap(({ issue, fix }) => fix.edits.map(e => ({ from: issue.base + e.from, to: issue.base + e.to, text: e.text }))));
    if (!edits.length) return 0;
    const tr = editor.state.tr;
    for (const e of edits) (e.text ? tr.insertText(e.text, e.from, e.to) : tr.delete(e.from, e.to));
    editor.view.dispatch(tr);
    return items.length;
}

/** Puts the cursor at an issue, scrolls to it and opens its fix menu. */
export function revealIssue(editor: Editor, issue: BodyIssue) {
    editor.chain().focus().setTextSelection(issue.base + issue.from).scrollIntoView().run();
    openIssue.value = issue.id;
}
