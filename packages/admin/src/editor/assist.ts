import { getHTMLFromFragment, type Editor, type JSONContent } from '@tiptap/core';
import { base } from '../api';

export type AssistMode = 'chat' | 'edit' | 'write' | 'continue';

export interface AssistRequest {
    mode: AssistMode;
    instruction?: string;
    selection?: string;
    before?: string;
    after?: string;
    title?: string;
    post?: string;
    messages?: { role: 'user' | 'assistant'; content: string }[];
}

export interface Source {
    title: string;
    url: string | null;
}

/** Streams the writing assistant: calls back with each piece of text and the sources it drew on; resolves with the whole reply. */
export async function streamAssist(req: AssistRequest, on: { delta: (text: string) => void; sources?: (s: Source[]) => void }, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${base}admin/api/ai/assist`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-masthead': '1' },
        body: JSON.stringify(req),
        signal
    });
    if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The assistant is unavailable (${res.status}).`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let full = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            const payload = JSON.parse(data);
            if (event === 'sources') on.sources?.((payload as Source[]).filter((x, i, all) => all.findIndex(y => (y.url ?? y.title) === (x.url ?? x.title)) === i));
            else if (event === 'error') throw new Error(payload.message);
            else if (event === 'done') return full;
            else if (typeof payload.t === 'string') {
                full += payload.t;
                on.delta(payload.t);
            }
        }
    }
    return full;
}

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
