import { Editor } from '@tiptap/core';
import { TableKit } from '@tiptap/extension-table';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { Bookmark, ButtonCard, Callout, Embed, Figure, HtmlCard, prepareHtml, publishHtml, Video, type MediaBridge } from './nodes';

export interface SlashState {
    query: string;
    from: number;
    to: number;
    top: number;
    left: number;
}

export interface SelectionState {
    from: number;
    to: number;
    top: number;
    left: number;
    text: string;
}

export interface EditorHooks extends MediaBridge {
    onChange: () => void;
    upload: (file: File) => Promise<string>;
    /** A link on its own line: the page decides whether it becomes an embed. */
    unfurl: (url: string) => Promise<{ type: 'embed' | 'bookmark'; html?: string; provider?: string; url: string; title?: string; description?: string; image?: string | null; icon?: string | null; publisher?: string | null } | null>;
    onSlash: (s: SlashState | null) => void;
    onSelection: (s: SelectionState | null) => void;
    /** ⌘J: ask the AI to write here, or to rewrite the selection. */
    onAiPrompt: () => void;
}

const EMBEDDABLE = /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/|vimeo\.com\/\d|loom\.com\/share\/|(?:x|twitter)\.com\/[^/]+\/status\/\d)/i;

/** The editor's blocks and marks. Without a bridge, image and HTML cards have no edit buttons (fine for rendering). */
export function extensions(bridge: MediaBridge | null = null) {
    return [
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, link: { openOnClick: false, autolink: true } }),
        Placeholder.configure({ placeholder: 'Write, or press / for blocks, ⌘J for AI' }),
        Markdown,
        TableKit.configure({ table: { resizable: false } }),
        Figure.configure({ bridge }),
        Video,
        Embed,
        Bookmark,
        Callout,
        ButtonCard,
        HtmlCard.configure({ bridge })
    ];
}

/** The editor. It edits a document and hands back publishable HTML and a Markdown copy. */
export function createEditor(element: HTMLElement, content: { html?: string | null; markdown?: string | null }, hooks: EditorHooks): Editor {
    const insertFiles = (editor: Editor, files: File[], pos?: number) => {
        for (const file of files) {
            const isImage = file.type.startsWith('image/');
            const isVideo = file.type.startsWith('video/');
            if (!isImage && !isVideo) continue;
            hooks.upload(file).then(src => {
                const node = isImage ? { type: 'figure', attrs: { src, alt: file.name.replace(/\.[^.]+$/, '') } } : { type: 'video', attrs: { src } };
                const chain = editor.chain().focus();
                (pos != null ? chain.insertContentAt(pos, node) : chain.insertContent(node)).run();
            });
        }
    };

    const useHtml = content.html != null && content.html !== '';
    const editor: Editor = new Editor({
        element,
        extensions: extensions(hooks),
        content: useHtml ? prepareHtml(content.html!) : content.markdown ?? '',
        contentType: useHtml ? 'html' : 'markdown',
        editorProps: {
            attributes: { class: 'prose', spellcheck: 'true' },
            handlePaste: (view, event) => {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (files.some(f => f.type.startsWith('image/') || f.type.startsWith('video/'))) {
                    insertFiles(editor, files);
                    return true;
                }
                // A bare video or post link pasted on an empty line becomes an embed.
                const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
                const { $from, empty } = view.state.selection;
                if (empty && $from.parent.textContent === '' && EMBEDDABLE.test(text) && !/\s/.test(text)) {
                    hooks.unfurl(text).then(u => {
                        if (u?.type === 'embed') editor.chain().focus().insertContent({ type: 'embed', attrs: { html: u.html, url: u.url, provider: u.provider } }).run();
                        else editor.chain().focus().insertContent(`<p><a href="${text}">${text}</a></p>`).run();
                    });
                    return true;
                }
                return false;
            },
            handleDrop: (view, event) => {
                const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
                if (!files.some(f => f.type.startsWith('image/') || f.type.startsWith('video/'))) return false;
                const pos = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
                insertFiles(editor, files, pos);
                return true;
            },
            handleKeyDown: (_view, event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
                    event.preventDefault();
                    hooks.onAiPrompt();
                    return true;
                }
                return false;
            }
        },
        onUpdate: ({ editor: e }) => {
            hooks.onChange();
            detect(e);
        },
        onSelectionUpdate: ({ editor: e }) => detect(e),
        onBlur: () => setTimeout(() => hooks.onSelection(null), 150)
    });

    function detect(e: Editor) {
        const { $from, empty, from, to } = e.state.selection;
        const box = element.getBoundingClientRect();
        if (empty) {
            hooks.onSelection(null);
            const text = $from.parent.textContent;
            const before = text.slice(0, $from.parentOffset);
            // "/", then up to a few words to filter by, e.g. "/generate a v".
            const m = before.match(/(?:^|\s)\/((?:[\w-][\w -]{0,29})?)$/);
            if (m && $from.parent.type.name === 'paragraph') {
                const coords = e.view.coordsAtPos(from);
                hooks.onSlash({ query: m[1].toLowerCase(), from: from - m[1].length - 1, to: from, top: coords.bottom - box.top + 6, left: coords.left - box.left });
            } else hooks.onSlash(null);
            return;
        }
        hooks.onSlash(null);
        const text = e.state.doc.textBetween(from, to, '\n');
        if (!text.trim()) return hooks.onSelection(null);
        const start = e.view.coordsAtPos(from);
        hooks.onSelection({ from, to, text, top: start.top - box.top - 46, left: Math.max(0, start.left - box.left) });
    }

    return editor;
}

/** What gets saved: publishable HTML and a Markdown copy of the same document. */
export function snapshot(editor: Editor): { html: string; markdown: string } {
    return { html: publishHtml(editor.getHTML()), markdown: editor.getMarkdown() };
}

/** The document around the cursor, as Markdown, for the AI. */
export function around(editor: Editor): { before: string; after: string } {
    const { from, to } = editor.state.selection;
    const before = editor.state.doc.textBetween(0, from, '\n\n');
    const after = editor.state.doc.textBetween(to, editor.state.doc.content.size, '\n\n');
    return { before, after };
}

/** The selection as Markdown, so the AI sees links and emphasis. */
export function selectionMarkdown(editor: Editor): string {
    const { from, to } = editor.state.selection;
    const slice = editor.state.doc.slice(from, to);
    try {
        return editor.markdown?.serialize({ type: 'doc', content: slice.content.toJSON() ?? [] }) ?? editor.state.doc.textBetween(from, to, '\n\n');
    } catch {
        return editor.state.doc.textBetween(from, to, '\n\n');
    }
}

export interface SlashItem {
    id: string;
    label: string;
    hint: string;
    group: 'Write' | 'Media' | 'AI';
    run: (editor: Editor) => void;
}

export function slashItems(actions: {
    pickImage: () => void;
    pickVideo: () => void;
    aiImage: () => void;
    aiVideo: () => void;
    embed: () => void;
    aiWrite: () => void;
    aiContinue: () => void;
}): SlashItem[] {
    return [
        { id: 'ai-write', label: 'Ask AI to write…', hint: '⌘J', group: 'AI', run: () => actions.aiWrite() },
        { id: 'ai-continue', label: 'Continue writing', hint: 'from here', group: 'AI', run: () => actions.aiContinue() },
        { id: 'ai-image', label: 'Generate an image', hint: 'AI', group: 'AI', run: () => actions.aiImage() },
        { id: 'ai-video', label: 'Generate a video', hint: 'AI', group: 'AI', run: () => actions.aiVideo() },
        { id: 'h2', label: 'Heading', hint: '##', group: 'Write', run: e => e.chain().focus().toggleHeading({ level: 2 }).run() },
        { id: 'h3', label: 'Subheading', hint: '###', group: 'Write', run: e => e.chain().focus().toggleHeading({ level: 3 }).run() },
        { id: 'bullets', label: 'Bulleted list', hint: '- item', group: 'Write', run: e => e.chain().focus().toggleBulletList().run() },
        { id: 'numbers', label: 'Numbered list', hint: '1. item', group: 'Write', run: e => e.chain().focus().toggleOrderedList().run() },
        { id: 'quote', label: 'Quote', hint: '> text', group: 'Write', run: e => e.chain().focus().toggleBlockquote().run() },
        { id: 'code', label: 'Code block', hint: '```', group: 'Write', run: e => e.chain().focus().toggleCodeBlock().run() },
        { id: 'callout', label: 'Callout', hint: 'highlighted note', group: 'Write', run: e => e.chain().focus().insertContent({ type: 'callout', attrs: { emoji: '💡', color: 'grey' } }).run() },
        { id: 'button', label: 'Button', hint: 'call to action', group: 'Write', run: e => e.chain().focus().insertContent({ type: 'buttonCard', attrs: { label: 'Get started', url: '' } }).run() },
        { id: 'table', label: 'Table', hint: '3 × 3', group: 'Write', run: e => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
        { id: 'divider', label: 'Divider', hint: '---', group: 'Write', run: e => e.chain().focus().setHorizontalRule().run() },
        { id: 'html', label: 'HTML', hint: 'raw block', group: 'Write', run: e => e.chain().focus().insertContent({ type: 'htmlCard', attrs: { html: '<div>\n  \n</div>' } }).run() },
        { id: 'image', label: 'Image', hint: 'upload', group: 'Media', run: () => actions.pickImage() },
        { id: 'video', label: 'Video', hint: 'upload', group: 'Media', run: () => actions.pickVideo() },
        { id: 'embed', label: 'Embed or link card', hint: 'YouTube, X, any URL', group: 'Media', run: () => actions.embed() }
    ];
}
