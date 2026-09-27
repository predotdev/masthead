import { Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

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

export interface EditorHooks {
    onChange: (markdown: string) => void;
    upload: (file: File) => Promise<string>;
    onSlash: (s: SlashState | null) => void;
    onSelection: (s: SelectionState | null) => void;
}

/** A Markdown-native rich text editor: what you type is what gets published. */
export function createEditor(element: HTMLElement, markdown: string, hooks: EditorHooks): Editor {
    const insertFiles = (editor: Editor, files: File[], pos?: number) => {
        for (const file of files.filter(f => f.type.startsWith('image/'))) {
            hooks.upload(file).then(src => {
                const chain = editor.chain().focus();
                (pos != null ? chain.insertContentAt(pos, { type: 'image', attrs: { src, alt: file.name.replace(/\.[^.]+$/, '') } }) : chain.setImage({ src, alt: file.name.replace(/\.[^.]+$/, '') })).run();
            });
        }
    };

    const editor: Editor = new Editor({
        element,
        extensions: [
            StarterKit.configure({ heading: { levels: [2, 3, 4] }, link: { openOnClick: false, autolink: true } }),
            Image.configure({ inline: false }),
            Placeholder.configure({ placeholder: 'Write, or type / for headings, lists, images and more' }),
            Markdown
        ],
        content: markdown,
        contentType: 'markdown',
        editorProps: {
            attributes: { class: 'prose', spellcheck: 'true' },
            handlePaste: (_view, event) => {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (!files.some(f => f.type.startsWith('image/'))) return false;
                insertFiles(editor, files);
                return true;
            },
            handleDrop: (view, event) => {
                const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
                if (!files.some(f => f.type.startsWith('image/'))) return false;
                const pos = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
                insertFiles(editor, files, pos);
                return true;
            }
        },
        onUpdate: ({ editor: e }) => {
            hooks.onChange(e.getMarkdown());
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
            if ($from.parent.type.name === 'paragraph' && text.startsWith('/') && $from.parentOffset === text.length && !/\s/.test(text)) {
                const c = e.view.coordsAtPos($from.pos);
                hooks.onSlash({ query: text.slice(1).toLowerCase(), from: $from.start(), to: $from.pos, top: c.bottom - box.top + 6, left: c.left - box.left });
            } else hooks.onSlash(null);
            return;
        }
        hooks.onSlash(null);
        if ($from.parent.type.name === 'codeBlock') return hooks.onSelection(null);
        const start = e.view.coordsAtPos(from);
        hooks.onSelection({ from, to, top: start.top - box.top - 46, left: Math.max(0, start.left - box.left), text: e.state.doc.textBetween(from, to, '\n\n') });
    }

    return editor;
}

export interface SlashItem {
    id: string;
    label: string;
    hint: string;
    run: (e: Editor) => void;
}

export function slashItems(pickImage: () => void): SlashItem[] {
    return [
        { id: 'h2', label: 'Heading', hint: 'Section title', run: e => e.chain().focus().setNode('heading', { level: 2 }).run() },
        { id: 'h3', label: 'Subheading', hint: 'Smaller title', run: e => e.chain().focus().setNode('heading', { level: 3 }).run() },
        { id: 'bullet', label: 'Bulleted list', hint: '- item', run: e => e.chain().focus().toggleBulletList().run() },
        { id: 'numbered', label: 'Numbered list', hint: '1. item', run: e => e.chain().focus().toggleOrderedList().run() },
        { id: 'quote', label: 'Quote', hint: '> text', run: e => e.chain().focus().toggleBlockquote().run() },
        { id: 'code', label: 'Code block', hint: '```', run: e => e.chain().focus().toggleCodeBlock().run() },
        { id: 'divider', label: 'Divider', hint: '---', run: e => e.chain().focus().setHorizontalRule().run() },
        { id: 'image', label: 'Image', hint: 'Upload a picture', run: () => pickImage() }
    ];
}
