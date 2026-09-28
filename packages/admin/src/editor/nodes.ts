/**
 * Rich blocks for the editor. Each writes Ghost-compatible card markup, so
 * imported posts and new ones share one theme, and each reads that markup
 * back, so imported posts open as editable content instead of raw HTML.
 * Anything unrecognized becomes an HTML card that is kept byte for byte.
 */
import { Node, type Editor } from '@tiptap/core';

export interface MediaBridge {
    /** Opens the AI image tool on an image, to edit or regenerate it in place. */
    editImage(pos: number, src: string): void;
    /** Opens the HTML editor for an HTML card. */
    editHtml(pos: number, html: string): void;
}

const escAttr = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One element from an HTML string, for renderHTML. */
function dom(html: string): HTMLElement {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return (t.content.firstElementChild as HTMLElement) ?? document.createElement('div');
}

const widthClass = (w: string) => (w === 'wide' ? ' kg-width-wide' : w === 'full' ? ' kg-width-full' : '');
const widthOf = (el: Element) => (el.classList.contains('kg-width-wide') ? 'wide' : el.classList.contains('kg-width-full') ? 'full' : 'regular');

/** A small toolbar shown on a selected block. */
function toolbar(buttons: { label: string; title?: string; on?: boolean; run: () => void }[]): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'block-toolbar';
    bar.contentEditable = 'false';
    for (const b of buttons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = b.label;
        if (b.title) btn.title = b.title;
        if (b.on) btn.className = 'on';
        btn.addEventListener('mousedown', e => e.preventDefault());
        btn.addEventListener('click', e => (e.preventDefault(), b.run()));
        bar.appendChild(btn);
    }
    return bar;
}

function captionInput(value: string, placeholder: string, onChange: (v: string) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'block-caption';
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener('keydown', e => e.stopPropagation());
    input.addEventListener('change', () => onChange(input.value));
    return input;
}

function setAttrs(editor: Editor, getPos: () => number | undefined, attrs: Record<string, unknown>) {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...editor.state.doc.nodeAt(pos)!.attrs, ...attrs }));
}

function remove(editor: Editor, getPos: () => number | undefined) {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const node = editor.state.doc.nodeAt(pos);
    if (node) editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
}

const plainCaption = (html: string) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent ?? '';
};
/** A caption edited as text keeps its HTML (links) until the words change. */
const nextCaption = (oldHtml: string, text: string) => (plainCaption(oldHtml) === text ? oldHtml : escText(text));

// ------------------------------------------------------------------ image

function figureHTML(a: Record<string, any>): string {
    const img = `<img src="${escAttr(a.src)}" class="kg-image" alt="${escAttr(a.alt)}" loading="lazy"${a.w ? ` width="${escAttr(a.w)}"` : ''}${a.h ? ` height="${escAttr(a.h)}"` : ''}${a.srcset ? ` srcset="${escAttr(a.srcset)}"` : ''}${a.sizes ? ` sizes="${escAttr(a.sizes)}"` : ''}>`;
    const body = a.href ? `<a href="${escAttr(a.href)}">${img}</a>` : img;
    return `<figure class="kg-card kg-image-card${widthClass(a.width)}${a.caption ? ' kg-card-hascaption' : ''}">${body}${a.caption ? `<figcaption>${a.caption}</figcaption>` : ''}</figure>`;
}

function figureAttrs(fig: HTMLElement) {
    const img = fig.querySelector('img');
    if (!img) return false;
    return {
        src: img.getAttribute('src'),
        alt: img.getAttribute('alt') ?? '',
        srcset: img.getAttribute('srcset'),
        sizes: img.getAttribute('sizes'),
        w: img.getAttribute('width'),
        h: img.getAttribute('height'),
        href: img.parentElement?.tagName === 'A' ? img.parentElement.getAttribute('href') : null,
        caption: fig.querySelector('figcaption')?.innerHTML.trim() ?? '',
        width: widthOf(fig)
    };
}

export const Figure = Node.create<{ bridge: MediaBridge | null }>({
    name: 'figure',
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addOptions: () => ({ bridge: null }),
    addAttributes: () => ({ src: { default: '' }, alt: { default: '' }, caption: { default: '' }, width: { default: 'regular' }, srcset: { default: null }, sizes: { default: null }, w: { default: null }, h: { default: null }, href: { default: null } }),
    parseHTML: () => [
        { tag: 'figure.kg-image-card', getAttrs: el => figureAttrs(el as HTMLElement) },
        { tag: 'figure', priority: 40, getAttrs: el => ((el as HTMLElement).querySelector('video, iframe, .kg-gallery-container') || /kg-(?!image)/.test((el as HTMLElement).className) ? false : figureAttrs(el as HTMLElement)) },
        {
            tag: 'img[src]',
            getAttrs: el => {
                const img = el as HTMLElement;
                // A linked image keeps its link (a mark can't wrap a block).
                const href = img.parentElement?.tagName === 'A' ? img.parentElement.getAttribute('href') : null;
                return { src: img.getAttribute('src'), alt: img.getAttribute('alt') ?? '', w: img.getAttribute('width'), h: img.getAttribute('height'), href };
            }
        }
    ],
    renderHTML: ({ node }) => ({ dom: dom(figureHTML(node.attrs)) }),
    renderMarkdown: (node: any) => `${figureHTML(node.attrs ?? {})}\n\n`,
    addNodeView() {
        const bridge = this.options.bridge;
        return ({ node, getPos, editor }) => {
            let current = node;
            const wrap = document.createElement('div');
            wrap.className = 'block block-figure';
            const img = document.createElement('img');
            const caption = captionInput(plainCaption(node.attrs.caption), 'Add a caption', v => setAttrs(editor, getPos, { caption: nextCaption(current.attrs.caption, v) }));
            const render = () => {
                wrap.dataset.width = current.attrs.width;
                img.src = current.attrs.src;
                img.alt = current.attrs.alt;
                bar.replaceWith((bar = makeBar()));
            };
            const makeBar = () =>
                toolbar([
                    { label: 'Regular', on: current.attrs.width === 'regular', run: () => setAttrs(editor, getPos, { width: 'regular' }) },
                    { label: 'Wide', on: current.attrs.width === 'wide', run: () => setAttrs(editor, getPos, { width: 'wide' }) },
                    { label: 'Full', on: current.attrs.width === 'full', run: () => setAttrs(editor, getPos, { width: 'full' }) },
                    {
                        label: 'Alt text',
                        run: () => {
                            const alt = window.prompt('Describe the image for people who cannot see it', current.attrs.alt ?? '');
                            if (alt !== null) setAttrs(editor, getPos, { alt });
                        }
                    },
                    { label: '✦ Edit with AI', run: () => bridge?.editImage(getPos() ?? 0, current.attrs.src) },
                    { label: 'Remove', run: () => remove(editor, getPos) }
                ]);
            let bar = makeBar();
            wrap.append(bar, img, caption);
            render();
            return {
                dom: wrap,
                update: next => {
                    if (next.type !== current.type) return false;
                    current = next;
                    render();
                    if (document.activeElement !== caption) caption.value = plainCaption(next.attrs.caption);
                    return true;
                },
                stopEvent: e => e.target === caption,
                ignoreMutation: () => true
            };
        };
    }
});

// ------------------------------------------------------------------ video

function videoHTML(a: Record<string, any>): string {
    return `<figure class="kg-card kg-video-card${widthClass(a.width)}${a.caption ? ' kg-card-hascaption' : ''}"><video src="${escAttr(a.src)}"${a.poster ? ` poster="${escAttr(a.poster)}"` : ''} controls playsinline preload="metadata"${a.loop ? ' loop muted autoplay' : ''}></video>${a.caption ? `<figcaption>${a.caption}</figcaption>` : ''}</figure>`;
}

export const Video = Node.create({
    name: 'video',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes: () => ({ src: { default: '' }, poster: { default: null }, caption: { default: '' }, width: { default: 'regular' }, loop: { default: false } }),
    parseHTML: () => [
        {
            tag: 'figure.kg-video-card',
            getAttrs: el => {
                const v = (el as HTMLElement).querySelector('video');
                return v ? { src: v.getAttribute('src'), poster: v.getAttribute('poster'), caption: (el as HTMLElement).querySelector('figcaption')?.innerHTML.trim() ?? '', width: widthOf(el as HTMLElement), loop: v.hasAttribute('loop') } : false;
            }
        },
        { tag: 'video[src]', getAttrs: el => ({ src: (el as HTMLElement).getAttribute('src'), poster: (el as HTMLElement).getAttribute('poster') }) }
    ],
    renderHTML: ({ node }) => ({ dom: dom(videoHTML(node.attrs)) }),
    renderMarkdown: (node: any) => `${videoHTML(node.attrs ?? {})}\n\n`,
    addNodeView() {
        return ({ node, getPos, editor }) => {
            let current = node;
            const wrap = document.createElement('div');
            wrap.className = 'block block-video';
            const video = document.createElement('video');
            video.controls = true;
            video.preload = 'metadata';
            const caption = captionInput(plainCaption(node.attrs.caption), 'Add a caption', v => setAttrs(editor, getPos, { caption: nextCaption(current.attrs.caption, v) }));
            const makeBar = () =>
                toolbar([
                    { label: 'Regular', on: current.attrs.width === 'regular', run: () => setAttrs(editor, getPos, { width: 'regular' }) },
                    { label: 'Wide', on: current.attrs.width === 'wide', run: () => setAttrs(editor, getPos, { width: 'wide' }) },
                    { label: current.attrs.loop ? 'Loop: on' : 'Loop: off', title: 'Loop silently, like a GIF', run: () => setAttrs(editor, getPos, { loop: !current.attrs.loop }) },
                    { label: 'Remove', run: () => remove(editor, getPos) }
                ]);
            let bar = makeBar();
            const render = () => {
                wrap.dataset.width = current.attrs.width;
                if (video.getAttribute('src') !== current.attrs.src) video.src = current.attrs.src;
                if (current.attrs.poster) video.poster = current.attrs.poster;
                bar.replaceWith((bar = makeBar()));
            };
            wrap.append(bar, video, caption);
            render();
            return {
                dom: wrap,
                update: next => (next.type === current.type ? ((current = next), render(), true) : false),
                stopEvent: e => e.target === caption || e.target === video,
                ignoreMutation: () => true
            };
        };
    }
});

// ------------------------------------------------------------------ embeds and bookmarks

function embedHTML(a: Record<string, any>): string {
    return `<figure class="kg-card kg-embed-card${a.caption ? ' kg-card-hascaption' : ''}" data-url="${escAttr(a.url)}">${a.html}${a.caption ? `<figcaption>${a.caption}</figcaption>` : ''}</figure>`;
}

export const Embed = Node.create({
    name: 'embed',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes: () => ({ html: { default: '' }, url: { default: '' }, provider: { default: '' }, caption: { default: '' } }),
    parseHTML: () => [
        {
            tag: 'figure.kg-embed-card',
            getAttrs: el => {
                const f = (el as HTMLElement).cloneNode(true) as HTMLElement;
                const cap = f.querySelector('figcaption');
                const caption = cap?.innerHTML.trim() ?? '';
                cap?.remove();
                return { html: f.innerHTML.trim(), url: f.getAttribute('data-url') ?? f.querySelector('iframe')?.getAttribute('src') ?? '', caption };
            }
        }
    ],
    renderHTML: ({ node }) => ({ dom: dom(embedHTML(node.attrs)) }),
    renderMarkdown: (node: any) => `${embedHTML(node.attrs ?? {})}\n\n`,
    addNodeView() {
        return ({ node, getPos, editor }) => {
            const wrap = document.createElement('div');
            wrap.className = 'block block-embed';
            const view = document.createElement('div');
            view.className = 'embed-view';
            // Scripts never run here; a post embed shows its link until published.
            view.innerHTML = node.attrs.html;
            const caption = captionInput(plainCaption(node.attrs.caption), 'Add a caption', v => setAttrs(editor, getPos, { caption: escText(v) }));
            wrap.append(toolbar([{ label: node.attrs.provider || 'Embed', run: () => window.open(node.attrs.url, '_blank') }, { label: 'Remove', run: () => remove(editor, getPos) }]), view, caption);
            return { dom: wrap, stopEvent: e => e.target === caption, ignoreMutation: () => true };
        };
    }
});

function bookmarkHTML(a: Record<string, any>): string {
    return `<figure class="kg-card kg-bookmark-card"><a class="kg-bookmark-container" href="${escAttr(a.url)}"><div class="kg-bookmark-content"><div class="kg-bookmark-title">${escText(a.title)}</div><div class="kg-bookmark-description">${escText(a.description)}</div><div class="kg-bookmark-metadata">${a.icon ? `<img class="kg-bookmark-icon" src="${escAttr(a.icon)}" alt="">` : ''}<span class="kg-bookmark-author">${escText(a.publisher)}</span></div></div>${a.image ? `<div class="kg-bookmark-thumbnail"><img src="${escAttr(a.image)}" alt="" loading="lazy"></div>` : ''}</a></figure>`;
}

export const Bookmark = Node.create({
    name: 'bookmark',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes: () => ({ url: { default: '' }, title: { default: '' }, description: { default: '' }, image: { default: null }, icon: { default: null }, publisher: { default: '' } }),
    parseHTML: () => [
        {
            tag: 'figure.kg-bookmark-card',
            getAttrs: el => {
                const f = el as HTMLElement;
                return {
                    url: f.querySelector('a.kg-bookmark-container')?.getAttribute('href') ?? '',
                    title: f.querySelector('.kg-bookmark-title')?.textContent?.trim() ?? '',
                    description: f.querySelector('.kg-bookmark-description')?.textContent?.trim() ?? '',
                    image: f.querySelector('.kg-bookmark-thumbnail img')?.getAttribute('src') ?? null,
                    icon: f.querySelector('.kg-bookmark-icon')?.getAttribute('src') ?? null,
                    publisher: (f.querySelector('.kg-bookmark-publisher') ?? f.querySelector('.kg-bookmark-author'))?.textContent?.trim() ?? ''
                };
            }
        }
    ],
    renderHTML: ({ node }) => ({ dom: dom(bookmarkHTML(node.attrs)) }),
    renderMarkdown: (node: any) => `${bookmarkHTML(node.attrs ?? {})}\n\n`,
    addNodeView() {
        return ({ node, getPos, editor }) => {
            const wrap = document.createElement('div');
            wrap.className = 'block block-bookmark';
            wrap.append(toolbar([{ label: 'Open link', run: () => window.open(node.attrs.url, '_blank') }, { label: 'Remove', run: () => remove(editor, getPos) }]), dom(bookmarkHTML(node.attrs)));
            return { dom: wrap, ignoreMutation: () => true };
        };
    }
});

// ------------------------------------------------------------------ callout and button

const CALLOUT_COLORS = ['grey', 'white', 'blue', 'green', 'yellow', 'red', 'pink', 'purple', 'accent'];

export const Callout = Node.create({
    name: 'callout',
    group: 'block',
    content: 'inline*',
    defining: true,
    addAttributes: () => ({ emoji: { default: '💡' }, color: { default: 'grey' } }),
    parseHTML: () => [
        {
            tag: 'div.kg-callout-card',
            contentElement: '.kg-callout-text',
            getAttrs: el => {
                const e = el as HTMLElement;
                const color = CALLOUT_COLORS.find(c => e.classList.contains(`kg-callout-card-${c}`)) ?? 'grey';
                return { emoji: e.querySelector('.kg-callout-emoji')?.textContent?.trim() || '', color };
            }
        }
    ],
    renderHTML: ({ node }) => [
        'div',
        { class: `kg-card kg-callout-card kg-callout-card-${node.attrs.color}` },
        ...(node.attrs.emoji ? [['div', { class: 'kg-callout-emoji' }, node.attrs.emoji] as any] : []),
        ['div', { class: 'kg-callout-text' }, 0]
    ],
    renderMarkdown: (node: any, h: any) =>
        `<div class="kg-card kg-callout-card kg-callout-card-${escAttr(node.attrs?.color)}">${node.attrs?.emoji ? `<div class="kg-callout-emoji">${escText(node.attrs.emoji)}</div>` : ''}<div class="kg-callout-text">${escText(h.renderChildren(node.content ?? []))}</div></div>\n\n`,
    addNodeView() {
        return ({ node, getPos, editor }) => {
            let current = node;
            const wrap = document.createElement('div');
            const emoji = document.createElement('button');
            emoji.type = 'button';
            emoji.className = 'callout-emoji';
            emoji.contentEditable = 'false';
            emoji.addEventListener('mousedown', e => e.preventDefault());
            emoji.addEventListener('click', () => {
                const next = window.prompt('Emoji (leave empty for none)', current.attrs.emoji ?? '');
                if (next !== null) setAttrs(editor, getPos, { emoji: next.trim() });
            });
            const color = document.createElement('select');
            color.className = 'callout-color';
            color.contentEditable = 'false';
            for (const c of CALLOUT_COLORS) color.append(new Option(c, c));
            color.addEventListener('change', () => setAttrs(editor, getPos, { color: color.value }));
            const text = document.createElement('div');
            text.className = 'callout-text';
            const render = () => {
                wrap.className = `block-callout kg-callout-card-${current.attrs.color}`;
                emoji.textContent = current.attrs.emoji || '＋';
                color.value = current.attrs.color;
            };
            wrap.append(emoji, text, color);
            render();
            return {
                dom: wrap,
                contentDOM: text,
                update: next => (next.type === current.type ? ((current = next), render(), true) : false),
                stopEvent: e => e.target === color || e.target === emoji,
                ignoreMutation: m => m.target === color || m.target === emoji || (m as any).type === 'attributes'
            };
        };
    }
});

function buttonHTML(a: Record<string, any>): string {
    return `<div class="kg-card kg-button-card kg-align-${escAttr(a.align)}"><a href="${escAttr(a.url)}" class="kg-btn kg-btn-accent">${escText(a.label)}</a></div>`;
}

export const ButtonCard = Node.create({
    name: 'buttonCard',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes: () => ({ url: { default: '' }, label: { default: 'Get started' }, align: { default: 'center' } }),
    parseHTML: () => [
        {
            tag: 'div.kg-button-card',
            getAttrs: el => {
                const a = (el as HTMLElement).querySelector('a');
                return { url: a?.getAttribute('href') ?? '', label: a?.textContent?.trim() ?? '', align: (el as HTMLElement).classList.contains('kg-align-left') ? 'left' : 'center' };
            }
        }
    ],
    renderHTML: ({ node }) => ({ dom: dom(buttonHTML(node.attrs)) }),
    renderMarkdown: (node: any) => `${buttonHTML(node.attrs ?? {})}\n\n`,
    addNodeView() {
        return ({ node, getPos, editor }) => {
            let current = node;
            const wrap = document.createElement('div');
            wrap.className = 'block block-button';
            const preview = document.createElement('span');
            preview.className = 'button-preview';
            const label = captionInput(node.attrs.label, 'Button text', v => setAttrs(editor, getPos, { label: v }));
            const url = captionInput(node.attrs.url, 'https://', v => setAttrs(editor, getPos, { url: v }));
            const fields = document.createElement('div');
            fields.className = 'button-fields';
            fields.append(label, url);
            const render = () => {
                preview.textContent = current.attrs.label || 'Button';
                wrap.dataset.align = current.attrs.align;
            };
            wrap.append(toolbar([{ label: 'Left', run: () => setAttrs(editor, getPos, { align: 'left' }) }, { label: 'Center', run: () => setAttrs(editor, getPos, { align: 'center' }) }, { label: 'Remove', run: () => remove(editor, getPos) }]), preview, fields);
            render();
            return {
                dom: wrap,
                update: next => (next.type === current.type ? ((current = next), render(), true) : false),
                stopEvent: e => e.target === label || e.target === url,
                ignoreMutation: () => true
            };
        };
    }
});

// ------------------------------------------------------------------ anything else, kept exactly

export const HtmlCard = Node.create<{ bridge: MediaBridge | null }>({
    name: 'htmlCard',
    group: 'block',
    atom: true,
    draggable: true,
    addOptions: () => ({ bridge: null }),
    addAttributes: () => ({ html: { default: '' } }),
    parseHTML: () => [
        // The source rides in the attribute (kept verbatim); pasted cards carry it as children instead.
        { tag: 'div[data-mh-html]', getAttrs: el => ({ html: (el as HTMLElement).getAttribute('data-mh-html') || (el as HTMLElement).innerHTML.trim() }) },
        ...['figure.kg-gallery-card', 'div.kg-cta-card', 'div.kg-toggle-card', 'div.kg-header-card', 'div.kg-product-card', 'div.kg-file-card', 'div.kg-audio-card', 'div.kg-signup-card', 'div.kg-card', 'figure.kg-card', 'iframe', 'blockquote.twitter-tweet', 'script', 'style'].map(tag => ({
            tag,
            priority: 30,
            getAttrs: (el: HTMLElement | string) => ({ html: (el as HTMLElement).outerHTML })
        }))
    ],
    renderHTML: ({ node }) => ({ dom: dom(`<div data-mh-html>${node.attrs.html}</div>`) }),
    renderMarkdown: (node: any) => `${node.attrs?.html ?? ''}\n\n`,
    addNodeView() {
        const bridge = this.options.bridge;
        return ({ node, getPos, editor }) => {
            const wrap = document.createElement('div');
            wrap.className = 'block block-html';
            const view = document.createElement('div');
            view.className = 'html-view';
            // A shadow root keeps the card's own <style> from restyling the editor; scripts never run here.
            view.attachShadow({ mode: 'open' }).innerHTML = `<style>:host{display:block;overflow-x:auto}img,video,iframe{max-width:100%;height:auto}</style>${node.attrs.html}`;
            wrap.append(toolbar([{ label: 'Edit HTML', run: () => bridge?.editHtml(getPos() ?? 0, node.attrs.html) }, { label: 'Remove', run: () => remove(editor, getPos) }]), view);
            return { dom: wrap, ignoreMutation: () => true };
        };
    }
});

/**
 * Serializing a document drops an HTML card's wrapper: the card's own HTML is
 * what gets published. Ghost's "HTML card" comments mark raw HTML blocks; they
 * become HTML cards here, with the source in an attribute so it survives
 * parsing byte for byte (the HTML parser drops whitespace between tags).
 */
export function prepareHtml(html: string): string {
    const t = document.createElement('template');
    t.innerHTML = html.replace(/<!--kg-card-begin: html-->([\s\S]*?)<!--kg-card-end: html-->/g, (_m, inner) => `<div data-mh-html="${escAttr(inner)}"></div>`);
    // The editor's parser drops text nodes that are only a line break. In code that loses lines, so each
    // code block becomes one text node (it keeps text only anyway); between inline elements it joins two
    // words, so there the break becomes the space it renders as.
    for (const pre of Array.from(t.content.querySelectorAll('pre'))) {
        const code = pre.querySelector(':scope > code') ?? pre;
        code.textContent = code.textContent;
    }
    const inline = (n: ChildNode | null) => !!n && (n.nodeType === 3 ? /\S/.test(n.nodeValue ?? '') : INLINE.has((n as Element).tagName));
    const walker = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT);
    const breaks: Text[] = [];
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        if (/^(\n\s\s|\n)$/.test(n.nodeValue ?? '') && (inline(n.previousSibling) || inline(n.nextSibling))) breaks.push(n);
    }
    for (const n of breaks) n.nodeValue = ' ';
    return t.innerHTML;
}

const INLINE = new Set(['A', 'ABBR', 'B', 'CITE', 'CODE', 'DEL', 'DFN', 'EM', 'I', 'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR']);

/** The published HTML: each HTML card's wrapper becomes Ghost's comment markers around its exact contents. */
export function publishHtml(html: string): string {
    const t = document.createElement('template');
    t.innerHTML = html;
    for (const card of Array.from(t.content.querySelectorAll('div[data-mh-html]'))) {
        card.replaceWith(document.createComment('kg-card-begin: html'), ...Array.from(card.childNodes), document.createComment('kg-card-end: html'));
    }
    return t.innerHTML;
}
