import { Editor, getHTMLFromFragment, type JSONContent } from '@tiptap/core';
import { extensions } from './setup';

export type AssistMode = 'chat' | 'edit' | 'write' | 'continue';

/** Model replies sometimes wrap Markdown in a code fence; the editor wants the Markdown itself. */
export function unfence(text: string): string {
    return text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n?```$/i, '$1').trim();
}

/** HTML cards that could run code in the admin or on the site; model output never adds these. */
const UNSAFE = /<(?:script|iframe|object|embed|style)\b|\son[a-z]+\s*=|javascript:/i;

/**
 * Model output as editor content: Markdown parsed by the editor's own schema,
 * so it can only become blocks the editor knows, minus any unsafe HTML card.
 */
export function aiContent(editor: Editor, text: string): JSONContent[] {
    const md = unfence(text);
    const clean = (nodes: JSONContent[] = []): JSONContent[] =>
        nodes.filter(n => !(n.type === 'htmlCard' && UNSAFE.test(String(n.attrs?.html ?? '')))).map(n => (n.content ? { ...n, content: clean(n.content) } : n));
    try {
        const doc = editor.markdown?.parse(md);
        if (doc?.content) return clean(doc.content);
    } catch {
        // falls through to plain paragraphs
    }
    return md
        .split(/\n{2,}/)
        .filter(Boolean)
        .map(p => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }));
}

/** How model output will look once inserted, rendered with the editor's schema. */
export function previewHtml(editor: Editor, text: string): string {
    try {
        const doc = editor.schema.nodeFromJSON({ type: 'doc', content: aiContent(editor, text) });
        return getHTMLFromFragment(doc.content, editor.schema);
    } catch {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    }
}

let offscreen: Editor | null = null;

/** Markdown as the editor would show it, for pages without an editor (an editor off screen does the parsing). */
export function renderMarkdown(text: string): string {
    offscreen ??= new Editor({ element: document.createElement('div'), extensions: extensions(), editable: false });
    return previewHtml(offscreen, text);
}

/**
 * Puts model output into the post. A one-paragraph answer inside a paragraph
 * goes in as text, so rewriting a sentence doesn't split its paragraph; whole
 * paragraphs are replaced as blocks; at the end of a paragraph new blocks follow it.
 */
export function insertAi(editor: Editor, text: string, range: { from: number; to: number }, how: 'replace' | 'below' | 'at'): boolean {
    const content = aiContent(editor, text);
    if (!content.length) return false;
    const { doc } = editor.state;
    const $from = doc.resolve(range.from);
    const $to = doc.resolve(range.to);
    const chain = editor.chain().focus();
    if (how === 'below') return chain.insertContentAt($to.depth ? $to.after(1) : range.to, content).run();
    const inText = $from.parent.isTextblock && $from.sameParent($to) && $from.parent.content.size > 0;
    const oneParagraph = content.length === 1 && content[0].type === 'paragraph';
    const wholeBlocks = $from.parent.isTextblock && $to.parent.isTextblock && $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size;
    if (inText && oneParagraph && !(how === 'at' && $from.parentOffset === $from.parent.content.size)) return chain.insertContentAt(range, content[0].content ?? []).run();
    if (how === 'replace' && wholeBlocks) return chain.insertContentAt({ from: $from.before(), to: $to.after() }, content).run();
    if (how === 'at' && inText && $from.parentOffset === $from.parent.content.size) return chain.insertContentAt($from.after(), content).run();
    return chain.insertContentAt(range, content).run();
}
