/**
 * A post's HTML, rewritten for email.
 *
 * Mail clients run no scripts, show no iframes, forms or video, and many ignore
 * <style>, so the body is parsed and written out again with inline styles:
 * Ghost cards become tables, embeds and videos become linked thumbnails, pasted
 * styles are dropped, and nothing can grow wider than the column.
 */

// ------------------------------------------------------------------ colors and type

/** Light colors, written inline. The dark scheme swaps them through the classes in email.ts. */
export const INK = '#0a0a0a';
export const TEXT = '#2c2c2c';
export const MUTED = '#666666';
export const FAINT = '#767676';
export const LINE = '#eaeaeb';
export const LINE2 = '#dcdcde';
export const SURFACE = '#f6f6f7';
export const TINT = '#f0f6fe';
export const TINT_LINE = '#cfe0fd';
export const FONT = `Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
export const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;

// ------------------------------------------------------------------ parsing

export interface El {
    tag: string;
    attrs: Record<string, string>;
    kids: Node[];
}

/** Text is kept as written in the source, entities and all. */
export type Node = El | string;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements whose content is not markup. Only iframes are kept (for their attributes). */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'iframe', 'xmp', 'noembed', 'noframes']);
const CLOSES_P = new Set('address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul'.split(' '));
/** Start tags that end an open element of the same kind, within a scope, as browsers do. */
const IMPLIED: Record<string, { ends: string[]; scope: string[] }> = {
    li: { ends: ['li'], scope: ['ul', 'ol'] },
    dt: { ends: ['dt', 'dd'], scope: ['dl'] },
    dd: { ends: ['dt', 'dd'], scope: ['dl'] },
    tr: { ends: ['tr'], scope: ['table', 'thead', 'tbody', 'tfoot'] },
    td: { ends: ['td', 'th'], scope: ['tr', 'table'] },
    th: { ends: ['td', 'th'], scope: ['tr', 'table'] },
    thead: { ends: ['thead', 'tbody', 'tfoot'], scope: ['table'] },
    tbody: { ends: ['thead', 'tbody', 'tfoot'], scope: ['table'] },
    tfoot: { ends: ['thead', 'tbody', 'tfoot'], scope: ['table'] },
    option: { ends: ['option'], scope: ['select'] }
};

/** A forgiving HTML parser: good enough for post bodies, never throws, always balanced. */
export function parseHtml(src: string): El {
    const root: El = { tag: '#root', attrs: {}, kids: [] };
    const stack = [root];
    const lower = src.toLowerCase();
    const openAt = (tag: string, scope: string[] = []) => {
        for (let k = stack.length - 1; k > 0; k--) {
            if (stack[k].tag === tag) return k;
            if (scope.includes(stack[k].tag)) break;
        }
        return -1;
    };
    const closeFrom = (k: number) => {
        if (k > 0) stack.length = k;
    };
    let pos = 0;
    let textFrom = 0;
    const flush = (end: number) => {
        if (end > textFrom) stack[stack.length - 1].kids.push(src.slice(textFrom, end));
    };
    while (pos < src.length) {
        const lt = src.indexOf('<', pos);
        if (lt < 0) break;
        const next = src[lt + 1] ?? '';
        if (next === '!' || next === '?') {
            // Comments, doctypes and processing instructions are dropped.
            flush(lt);
            const comment = src.startsWith('<!--', lt);
            const end = comment ? src.indexOf('-->', lt + 4) : src.indexOf('>', lt + 2);
            pos = textFrom = end < 0 ? src.length : end + (comment ? 3 : 1);
            continue;
        }
        if (next === '/') {
            const m = /^<\/([a-zA-Z][^\s/>]*)[^>]*>/.exec(src.slice(lt, lt + 200));
            if (!m) {
                pos = lt + 1;
                continue;
            }
            flush(lt);
            pos = textFrom = lt + m[0].length;
            closeFrom(openAt(m[1].toLowerCase()));
            continue;
        }
        if (!/[a-zA-Z]/.test(next)) {
            pos = lt + 1;
            continue;
        }
        let j = lt + 1;
        while (j < src.length && !/[\s/>]/.test(src[j])) j++;
        const tag = src.slice(lt + 1, j).toLowerCase();
        const attrs: Record<string, string> = {};
        let selfClosing = false;
        while (j < src.length) {
            while (j < src.length && /\s/.test(src[j])) j++;
            if (j >= src.length) break;
            if (src[j] === '>') {
                j++;
                break;
            }
            if (src[j] === '/') {
                selfClosing = src[j + 1] === '>';
                j++;
                continue;
            }
            const start = j;
            while (j < src.length && !/[\s/>=]/.test(src[j])) j++;
            const name = src.slice(start, j).toLowerCase();
            while (j < src.length && /\s/.test(src[j])) j++;
            let value = '';
            if (src[j] === '=') {
                j++;
                while (j < src.length && /\s/.test(src[j])) j++;
                const q = src[j];
                if (q === '"' || q === "'") {
                    const end = src.indexOf(q, j + 1);
                    value = src.slice(j + 1, end < 0 ? src.length : end);
                    j = end < 0 ? src.length : end + 1;
                } else {
                    const s = j;
                    while (j < src.length && !/[\s>]/.test(src[j])) j++;
                    value = src.slice(s, j);
                }
            } else if (j === start) j++;
            // Values stay escaped as in the source; a quote from a single-quoted value is escaped for re-use in double quotes.
            if (name && !(name in attrs)) attrs[name] = value.replace(/"/g, '&quot;');
        }
        flush(lt);
        pos = textFrom = j;
        const implied = IMPLIED[tag];
        if (implied) closeFrom(Math.max(...implied.ends.map(t => openAt(t, implied.scope))));
        if (CLOSES_P.has(tag)) closeFrom(openAt('p', ['button', 'table', 'td', 'th', 'caption', 'template', 'object']));
        const el: El = { tag, attrs, kids: [] };
        stack[stack.length - 1].kids.push(el);
        if (RAW.has(tag) && !selfClosing) {
            const end = lower.indexOf(`</${tag}`, j);
            const stop = end < 0 ? -1 : src.indexOf('>', end);
            pos = textFrom = stop < 0 ? src.length : stop + 1;
            continue;
        }
        // Past a sane depth, content flows into the parent, so rendering never recurses too deep.
        if (!VOID.has(tag) && !selfClosing && stack.length < 400) stack.push(el);
    }
    flush(src.length);
    return root;
}

// ------------------------------------------------------------------ tree helpers

const isEl = (n: Node | undefined | null): n is El => !!n && typeof n !== 'string';
const has = (e: El, cls: string) => ` ${e.attrs.class ?? ''} `.includes(` ${cls} `);

function find(e: El | null | undefined, test: (x: El) => boolean): El | null {
    if (!e) return null;
    for (const k of e.kids) {
        if (!isEl(k)) continue;
        if (test(k)) return k;
        const hit = find(k, test);
        if (hit) return hit;
    }
    return null;
}

function findAll(e: El | null | undefined, test: (x: El) => boolean, out: El[] = []): El[] {
    for (const k of e?.kids ?? []) {
        if (!isEl(k)) continue;
        if (test(k)) out.push(k);
        else findAll(k, test, out);
    }
    return out;
}

const byClass = (e: El | null | undefined, cls: string) => find(e, x => has(x, cls));
const byTag = (e: El | null | undefined, tag: string) => find(e, x => x.tag === tag);

/** The raw text inside a node. */
function text(n: Node | null | undefined): string {
    if (!n) return '';
    if (!isEl(n)) return n;
    if (n.tag === 'br') return ' ';
    return n.kids.map(text).join('');
}

const squash = (raw: string) => raw.replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
/** Raw text made safe inside a double-quoted attribute. */
const attr = (raw: string) => squash(raw).replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Raw text cut at a word boundary, so an entity is never split. */
function clip(raw: string, max: number): string {
    const s = squash(raw);
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).replace(/[,;:.\s]+$/, '')}…`;
}

const num = (v: string | undefined) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/** An attribute value as a plain URL, for fetching or taking apart. */
const unescapeUrl = (raw: string) => raw.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ------------------------------------------------------------------ rendering

export interface EmailAssets {
    /** Known image sizes by src as written in the post, for width and height attributes. */
    images: Record<string, { width: number; height: number }>;
    /** A video embed's thumbnail and title, by the iframe's src as written. */
    videos: Record<string, { image: string; width: number; height: number; title?: string }>;
    /** The markup of X posts that were embedded as a bare link, by the link as written. */
    tweets: Record<string, string>;
}

export interface BodyOptions {
    /** Origin that relative links and images are resolved against. */
    origin: string;
    /** The post on the web, where videos and audio play. */
    postUrl: string;
    /** The column width in pixels. */
    width: number;
    assets?: Partial<EmailAssets>;
}

interface Ctx {
    o: BodyOptions;
    /** Pixels available to the current block. */
    width: number;
    /** First and last block of a container: their outer margins are dropped. */
    first: boolean;
    last: boolean;
    /** Inside a paragraph-like element: images stay inline. */
    inline: boolean;
    /** Inside a box (quote, callout, cell): tighter paragraph spacing. */
    tight: boolean;
    lists: number;
}

/** Renders a post body for email. */
export function emailBody(html: string, o: BodyOptions): string {
    const root = parseHtml(html);
    return blocks(root.kids, { o, width: o.width, first: true, last: true, inline: false, tight: false, lists: 0 });
}

/** Renders HTML meant to sit inside a line (a caption, a title) for email. */
export function emailInline(html: string, o: BodyOptions): string {
    const root = parseHtml(html);
    return inline(root, { o, width: o.width, first: true, last: true, inline: true, tight: true, lists: 0 });
}

function blocks(nodes: Node[], ctx: Ctx): string {
    let first = -1;
    let last = -1;
    nodes.forEach((n, i) => {
        if (isEl(n) ? n.tag === 'br' : !squash(n)) return;
        if (first < 0) first = i;
        last = i;
    });
    return nodes.map((n, i) => node(n, { ...ctx, first: ctx.first && i === first, last: ctx.last && i === last })).join('');
}

const inline = (e: El, ctx: Ctx) => e.kids.map(k => node(k, { ...ctx, inline: true })).join('');
const box = (ctx: Ctx, width: number): Ctx => ({ ...ctx, width, first: true, last: true, inline: false, tight: true });
const gap = (ctx: Ctx, px: number) => (ctx.last ? 0 : px);
const top = (ctx: Ctx, px: number) => (ctx.first ? 0 : px);

function align(e: El): string {
    const m = /text-align\s*:\s*(center|right|justify)/i.exec(e.attrs.style ?? '')?.[1] ?? (/^(center|right)$/i.test(e.attrs.align ?? '') ? e.attrs.align : '');
    return m ? `;text-align:${m.toLowerCase()}` : '';
}

const dir = (e: El) => (e.attrs.dir === 'rtl' ? ' dir="rtl"' : '');

/** Absolute, safe URLs; in-page anchors point at the post on the web. */
function href(raw: string | undefined, ctx: Ctx): string | null {
    const u = (raw ?? '').trim();
    // Checked with entities decoded and control characters dropped, as a browser would read it.
    const char = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');
    const probe = u
        .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => char(Number.parseInt(h, 16)))
        .replace(/&#(\d+);?/g, (_m, d: string) => char(Number(d)))
        .replace(/&colon;/gi, ':')
        .replace(/[\s\u0000-\u001f]|&(tab|newline);/gi, '');
    if (!u || /^(javascript|vbscript|data):/i.test(probe)) return null;
    if (u.startsWith('//')) return `https:${u}`;
    if (u.startsWith('/')) return `${ctx.o.origin}${u}`;
    if (u.startsWith('#')) return `${ctx.o.postUrl.split('#')[0]}${u}`;
    return u;
}

/** Long unbroken runs (URLs, paths) get break opportunities so they can't push the layout wider. */
function breakable(raw: string): string {
    return raw.replace(/[^\s<>]{30,}/g, run => run.replace(/([/._?=-]+)(?=[^\s/._?=-])/g, '$1&#8203;'));
}

function node(n: Node, ctx: Ctx): string {
    if (!isEl(n)) return breakable(n);
    if (DROP.has(n.tag)) return '';
    const card = cardFor(n, ctx);
    if (card !== undefined) return card;
    const e = n;
    switch (e.tag) {
        case 'p': {
            // Inside a caption or a title a paragraph is just its words.
            if (ctx.inline) return inline(e, ctx);
            const sole = soleImage(e);
            if (sole) return imageBlock(sole.img, ctx, { link: sole.link });
            if (!squash(text(e)) && !byTag(e, 'img')) return '';
            return `<p${dir(e)} style="margin:0 0 ${gap(ctx, ctx.tight ? 12 : 22)}px${align(e)}">${inline(e, ctx)}</p>`;
        }
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
            if (!squash(text(e))) return '';
            const [size, space] = HEADINGS[e.tag];
            return `<${e.tag}${dir(e)} class="ink" style="margin:${top(ctx, space)}px 0 ${gap(ctx, 12)}px;font-size:${size}px;line-height:1.3;font-weight:650;letter-spacing:-0.01em;color:${INK}${align(e)}">${inline(e, ctx)}</${e.tag}>`;
        }
        case 'a': {
            const url = href(e.attrs.href, ctx);
            const inner = inline(e, ctx);
            if (!url) return inner;
            const bare = !squash(text(e)) && !!byTag(e, 'img');
            return bare
                ? `<a href="${url}" style="text-decoration:none">${inner}</a>`
                : `<a href="${url}" class="ink" style="color:${INK};text-decoration:underline;text-decoration-color:#bdbdc2;text-underline-offset:3px">${inner}</a>`;
        }
        case 'strong':
        case 'b':
            return `<strong>${inline(e, ctx)}</strong>`;
        case 'em':
        case 'i':
        case 'cite':
            return `<em>${inline(e, ctx)}</em>`;
        case 'u':
        case 'ins':
            return `<u>${inline(e, ctx)}</u>`;
        case 's':
        case 'strike':
        case 'del':
            return `<s>${inline(e, ctx)}</s>`;
        case 'sup':
        case 'sub':
        case 'small':
            return `<${e.tag}>${inline(e, ctx)}</${e.tag}>`;
        case 'mark':
            return `<mark class="mk" style="background-color:#fdf0b0;color:inherit;padding:0 2px">${inline(e, ctx)}</mark>`;
        case 'code':
        case 'kbd':
        case 'samp':
            return `<code class="srf ink" style="font-family:${MONO};font-size:0.86em;background-color:${SURFACE};border:1px solid ${LINE};border-radius:5px;padding:1px 5px;color:${INK}">${inline(e, ctx)}</code>`;
        case 'span':
            return styled(e, inline(e, ctx));
        case 'br':
            return '<br>';
        case 'pre':
            return code(e, ctx);
        case 'blockquote':
            return quote(e, ctx);
        case 'ul':
        case 'ol':
            return list(e, ctx);
        case 'li':
            return `<li style="margin:0 0 8px">${blocks(e.kids, { ...ctx, tight: true, first: true, last: true })}</li>`;
        case 'hr':
            return rule(ctx);
        case 'table':
            return table(e, ctx);
        case 'img':
            return ctx.inline ? inlineImage(e, ctx) : imageBlock(e, ctx);
        case 'picture': {
            const img = byTag(e, 'img');
            return img ? node(img, ctx) : '';
        }
        case 'figure': {
            const img = byTag(e, 'img');
            if (img && !byTag(e, 'iframe') && !byTag(e, 'video')) return imageBlock(img, ctx, { link: find(e, x => x.tag === 'a' && !!x.attrs.href), caption: byTag(e, 'figcaption') });
            return blocks(e.kids, ctx);
        }
        case 'figcaption':
            return caption(e, ctx);
        case 'iframe':
            return embed(e, ctx);
        case 'video':
            return video(e, e, ctx);
        case 'audio':
            return audio(e, ctx);
        case 'details':
            return toggle(byTag(e, 'summary'), e, ctx);
        case 'dl':
            return `<dl style="margin:0 0 ${gap(ctx, 22)}px">${blocks(e.kids, ctx)}</dl>`;
        case 'dt':
            return `<dt class="ink" style="margin:12px 0 4px;font-weight:600;color:${INK}">${inline(e, ctx)}</dt>`;
        case 'dd':
            return `<dd style="margin:0 0 0 20px">${blocks(e.kids, { ...ctx, tight: true, first: true, last: true })}</dd>`;
        case 'div':
        case 'section':
        case 'article':
        case 'header':
        case 'footer':
        case 'main':
        case 'aside':
        case 'nav':
        case 'hgroup':
        case 'center':
        case 'summary': {
            const a = e.tag === 'center' ? ';text-align:center' : align(e);
            if (ctx.inline) return inline(e, ctx);
            // A container holding only words and inline markup is a paragraph (pasted HTML often uses divs for lines).
            const words = e.kids.some(k => (isEl(k) ? INLINE.has(k.tag) : !!squash(k))) && e.kids.every(k => !isEl(k) || INLINE.has(k.tag));
            if (words) return `<div style="margin:0 0 ${gap(ctx, ctx.tight ? 12 : 22)}px${a}">${inline(e, ctx)}</div>`;
            const inner = blocks(e.kids, ctx);
            return a ? `<div style="${a.slice(1)}">${inner}</div>` : inner;
        }
        default:
            return ctx.inline ? inline(e, ctx) : blocks(e.kids, ctx);
    }
}

const HEADINGS: Record<string, [number, number]> = { h1: [28, 40], h2: [24, 38], h3: [20, 32], h4: [18, 28], h5: [16, 24], h6: [15, 24] };

/** Nothing a mail client can use: scripts, forms, vector art, plugins and document chrome. */
const DROP = new Set('area base button canvas col colgroup dialog embed form frame frameset head input link map math meta noscript object option param script select source style svg template textarea title track'.split(' '));

const INLINE = new Set('a abbr b bdi bdo br cite code data del dfn em font i img ins kbd label mark q s samp small span strike strong sub sup time u var wbr'.split(' '));

/** Pasted spans (Google Docs and the like) keep their bold and italics as markup, not styles. */
function styled(e: El, inner: string): string {
    const s = e.attrs.style ?? '';
    if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(s)) inner = `<strong>${inner}</strong>`;
    if (/font-style\s*:\s*italic/i.test(s)) inner = `<em>${inner}</em>`;
    if (/text-decoration[^;]*underline/i.test(s)) inner = `<u>${inner}</u>`;
    if (/text-decoration[^;]*line-through/i.test(s)) inner = `<s>${inner}</s>`;
    return inner;
}

/** A paragraph that only holds an image (Markdown's ![]()), optionally linked. */
function soleImage(p: El): { img: El; link: El | null } | null {
    const kids = p.kids.filter(k => isEl(k) || squash(k));
    if (kids.length !== 1 || !isEl(kids[0])) return null;
    const only = kids[0];
    if (only.tag === 'img') return { img: only, link: null };
    if (only.tag !== 'a') return null;
    const inner = only.kids.filter(k => isEl(k) || squash(k));
    return inner.length === 1 && isEl(inner[0]) && inner[0].tag === 'img' ? { img: inner[0], link: only } : null;
}

// ------------------------------------------------------------------ blocks

function rule(ctx: Ctx): string {
    return `<div style="margin:${top(ctx, 36)}px 0 ${gap(ctx, 36)}px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="ln2" style="border-top:1px solid ${LINE2};font-size:0;line-height:0;height:1px">&nbsp;</td></tr></table></div>`;
}

function code(e: El, ctx: Ctx): string {
    const raw = preText(e).replace(/^\n/, '').replace(/\s+$/, '');
    return `<div style="margin:0 0 ${gap(ctx, 24)}px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed"><tr><td class="srf" bgcolor="${SURFACE}" style="background-color:${SURFACE};border:1px solid ${LINE};border-radius:10px;padding:16px 18px"><div style="overflow-x:auto"><pre class="ink" style="margin:0;font-family:${MONO};font-size:13.5px;line-height:1.6;color:${INK};white-space:pre-wrap;word-wrap:break-word">${raw}</pre></div></td></tr></table></div>`;
}

/** Code as written: line breaks from <br>, other markup dropped. */
function preText(n: Node): string {
    if (!isEl(n)) return n;
    if (n.tag === 'br') return '\n';
    return n.kids.map(preText).join('');
}

function quote(e: El, ctx: Ctx): string {
    if (has(e, 'kg-blockquote-alt')) {
        return `<div class="ink" style="margin:${top(ctx, 8)}px 0 ${gap(ctx, 30)}px;padding:0 12px;text-align:center;font-size:21px;line-height:1.5;font-style:italic;color:${INK}">${blocks(e.kids, box(ctx, ctx.width - 24))}</div>`;
    }
    return `<div style="margin:0 0 ${gap(ctx, 26)}px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="bink ink" style="border-left:3px solid ${INK};padding:2px 0 2px 18px;font-size:18px;line-height:1.6;color:${INK}">${blocks(e.kids, box(ctx, ctx.width - 21))}</td></tr></table></div>`;
}

function list(e: El, ctx: Ctx): string {
    const start = e.tag === 'ol' && num(e.attrs.start) > 1 ? ` start="${num(e.attrs.start)}"` : '';
    const items = e.kids.filter(isEl);
    const inner = items
        .map((li, i) => {
            const body = li.tag === 'li' ? li : { ...li, kids: [li] };
            const last = i === items.length - 1;
            return `<li style="margin:0 0 ${last ? 0 : 8}px">${blocks(body.kids, { ...ctx, width: ctx.width - 26, tight: true, first: true, last: true, inline: false, lists: ctx.lists + 1 })}</li>`;
        })
        .join('');
    const margin = ctx.lists ? '8px 0 0' : `0 0 ${gap(ctx, 22)}px`;
    return `<${e.tag}${start} style="margin:${margin};padding:0 0 0 26px">${inner}</${e.tag}>`;
}

function table(e: El, ctx: Ctx): string {
    const trs = findAll(e, x => x.tag === 'tr').map(tr => tr.kids.filter(isEl).filter(c => c.tag === 'td' || c.tag === 'th'));
    const columns = Math.max(0, ...trs.map(r => r.length));
    if (!columns) return '';
    // Wide tables get smaller type and tighter cells, so they fit the column before they have to scroll.
    const [font, pad] = columns >= 7 ? [12.5, '8px 6px'] : columns >= 5 ? [13.5, '9px 8px'] : [14.5, '10px 12px'];
    const width = Math.floor(ctx.width / columns);
    const cell = (c: El) => {
        const span = `${num(c.attrs.colspan) > 1 ? ` colspan="${num(c.attrs.colspan)}"` : ''}${num(c.attrs.rowspan) > 1 ? ` rowspan="${num(c.attrs.rowspan)}"` : ''}`;
        const inner = blocks(c.kids, { ...ctx, width, tight: true, first: true, last: true, inline: false });
        return c.tag === 'th'
            ? `<th${span} class="ink ln2" style="padding:${pad};text-align:left;vertical-align:bottom;font-weight:600;color:${INK};border-bottom:1px solid ${LINE2}${align(c)}">${inner}</th>`
            : `<td${span} class="ln" style="padding:${pad};text-align:left;vertical-align:top;border-bottom:1px solid ${LINE}${align(c)}">${inner}</td>`;
    };
    const rows = trs.map(r => `<tr>${r.map(cell).join('')}</tr>`).join('');
    // The fixed outer table holds the column width; a table that is still too wide scrolls inside it where clients allow, instead of widening the email.
    return `<div style="margin:0 0 ${gap(ctx, 26)}px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed"><tr><td><div style="overflow-x:auto"><table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;font-size:${font}px;line-height:1.5">${rows}</table></div></td></tr></table></div>`;
}

// ------------------------------------------------------------------ images

function size(img: El, ctx: Ctx): { width: number; height: number } {
    const known = ctx.o.assets?.images?.[img.attrs.src ?? ''];
    const width = num(img.attrs.width) || known?.width || 0;
    const height = num(img.attrs.height) || known?.height || 0;
    return width && height ? { width, height } : { width, height: 0 };
}

/** An <img> sized to fit the column, with the width and height attributes Outlook needs. */
function imgTag(img: El, ctx: Ctx, o: { alt?: string; radius?: number; frame?: boolean; width?: number } = {}): string {
    const src = href(img.attrs.src, ctx);
    if (!src) return '';
    const max = o.width ?? ctx.width;
    const natural = size(img, ctx);
    const width = natural.width ? Math.min(natural.width, max) : max;
    const height = natural.width && natural.height ? Math.round((width * natural.height) / natural.width) : 0;
    const fill = !natural.width || natural.width >= max;
    const alt = attr(img.attrs.alt || o.alt || '');
    const frame = o.frame ? `;border:1px solid ${LINE};box-sizing:border-box` : ';border:0';
    // Unknown sizes keep their own width (capped) everywhere but Outlook, which needs a number.
    const w = natural.width ? (fill ? 'width:100%' : `width:${width}px;max-width:100%`) : 'width:auto;max-width:100%';
    return `<img src="${src}" width="${width}"${height ? ` height="${height}"` : ''} alt="${alt}"${o.frame ? ' class="ln"' : ''} style="display:block;${w};height:auto;margin:0 auto;border-radius:${o.radius ?? 10}px${frame}">`;
}

function imageBlock(img: El, ctx: Ctx, o: { link?: El | null; caption?: El | null } = {}): string {
    const cap = o.caption && squash(text(o.caption)) ? o.caption : null;
    let tag = imgTag(img, ctx, { alt: cap ? text(cap) : '', frame: true });
    if (!tag) return '';
    const url = o.link ? href(o.link.attrs.href, ctx) : null;
    if (url) tag = `<a href="${url}" style="text-decoration:none">${tag}</a>`;
    return `<div align="center" style="margin:${top(ctx, 6)}px 0 ${gap(ctx, 28)}px">${tag}${cap ? caption(cap, ctx) : ''}</div>`;
}

function inlineImage(img: El, ctx: Ctx): string {
    const src = href(img.attrs.src, ctx);
    if (!src) return '';
    const natural = size(img, ctx);
    const width = natural.width ? Math.min(natural.width, ctx.width) : 0;
    const height = width && natural.height ? Math.round((width * natural.height) / natural.width) : 0;
    return `<img src="${src}"${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''} alt="${attr(img.attrs.alt ?? '')}" style="max-width:100%;height:auto;border:0;vertical-align:middle">`;
}

function caption(e: El, ctx: Ctx): string {
    return `<div class="fnt" style="padding-top:10px;font-size:13.5px;line-height:1.5;color:${FAINT};text-align:center">${inline(e, { ...ctx, tight: true })}</div>`;
}

// ------------------------------------------------------------------ cards

function cardFor(e: El, ctx: Ctx): string | undefined {
    const c = ` ${e.attrs.class ?? ''} `;
    if (!/ (kg-|twitter-tweet |instagram-media |tiktok-embed )/.test(c)) return undefined;
    const cap = () => byTag(e, 'figcaption');
    if (has(e, 'kg-image-card')) {
        const img = byTag(e, 'img');
        return img ? imageBlock(img, ctx, { link: find(e, x => x.tag === 'a' && !!x.attrs.href), caption: cap() }) : '';
    }
    if (has(e, 'kg-gallery-card')) return gallery(e, ctx);
    if (has(e, 'kg-embed-card')) return embed(e, ctx);
    if (has(e, 'kg-bookmark-card')) return bookmark(e, ctx);
    if (has(e, 'kg-video-card')) return video(e, byTag(e, 'video'), ctx);
    if (has(e, 'kg-audio-card')) return audio(e, ctx);
    if (has(e, 'kg-file-card')) return file(e, ctx);
    if (has(e, 'kg-callout-card')) return callout(e, ctx);
    if (has(e, 'kg-button-card')) return buttonCard(e, ctx);
    if (has(e, 'kg-cta-card')) return cta(e, ctx);
    if (has(e, 'kg-toggle-card')) return toggle(byClass(e, 'kg-toggle-heading-text') ?? byClass(e, 'kg-toggle-heading'), byClass(e, 'kg-toggle-content'), ctx);
    if (has(e, 'kg-header-card')) return header(e, ctx);
    if (has(e, 'kg-product-card')) return product(e, ctx);
    // Sign-up forms can't work in an email, and the reader is already subscribed.
    if (has(e, 'kg-signup-card')) return '';
    if (has(e, 'kg-code-card')) {
        const pre = byTag(e, 'pre');
        const note = cap();
        if (!pre) return '';
        if (!note || !squash(text(note))) return code(pre, ctx);
        return `<div style="margin:0 0 ${gap(ctx, 24)}px">${code(pre, { ...ctx, last: true })}${caption(note, ctx)}</div>`;
    }
    if (e.tag === 'blockquote' && (has(e, 'twitter-tweet') || has(e, 'instagram-media') || has(e, 'tiktok-embed'))) return embed({ tag: 'figure', attrs: {}, kids: [e] }, ctx);
    return undefined;
}

/** A bordered or tinted box around card content. */
function panel(inner: string, ctx: Ctx, o: { tone?: 'surface' | 'tint' | 'line'; padding?: string; center?: boolean } = {}): string {
    const tone = o.tone ?? 'line';
    const bg = tone === 'surface' ? SURFACE : tone === 'tint' ? TINT : '';
    const border = tone === 'tint' ? TINT_LINE : LINE;
    const cls = tone === 'surface' ? 'srf' : tone === 'tint' ? 'tnt' : 'ln';
    return `<div style="margin:${top(ctx, 4)}px 0 ${gap(ctx, 28)}px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="${cls}"${bg ? ` bgcolor="${bg}"` : ''} style="${bg ? `background-color:${bg};` : ''}border:1px solid ${border};border-radius:14px;padding:${o.padding ?? '20px 22px'}${o.center ? ';text-align:center' : ''}">${inner}</td></tr></table></div>`;
}

/** A pill button. `invert` is the light button used on dark cards. */
export function button(url: string, label: string, o: { align?: 'left' | 'center'; invert?: boolean } = {}): string {
    const bg = o.invert ? '#ffffff' : INK;
    const fg = o.invert ? INK : '#ffffff';
    const cls = o.invert ? '' : ' class="btn"';
    const acls = o.invert ? '' : ' class="btt"';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${o.align ?? 'center'}"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td${cls} bgcolor="${bg}" style="background-color:${bg};border-radius:999px;mso-padding-alt:12px 26px"><a href="${url}"${acls} style="display:inline-block;padding:12px 26px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:${fg};text-decoration:none;border-radius:999px">${label}</a></td></tr></table></td></tr></table>`;
}

function buttonCard(e: El, ctx: Ctx): string {
    const a = byTag(e, 'a');
    const url = a ? href(a.attrs.href, ctx) : null;
    if (!a || !url) return '';
    return `<div style="margin:${top(ctx, 6)}px 0 ${gap(ctx, 28)}px">${button(url, squash(text(a)), { align: has(e, 'kg-align-left') ? 'left' : 'center' })}</div>`;
}

function callout(e: El, ctx: Ctx): string {
    const emoji = squash(text(byClass(e, 'kg-callout-emoji')));
    const body = byClass(e, 'kg-callout-text') ?? e;
    const neutral = has(e, 'kg-callout-card-grey') || has(e, 'kg-callout-card-white');
    const width = ctx.width - 46 - (emoji ? 34 : 0);
    const content = blocks(body.kids, box(ctx, width));
    const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${emoji ? `<td width="34" valign="top" style="font-size:18px;line-height:26px">${emoji}</td>` : ''}<td valign="top" class="ink" style="font-size:16px;line-height:26px;color:${INK}">${content}</td></tr></table>`;
    return panel(inner, ctx, { tone: neutral ? 'surface' : 'tint', padding: '18px 22px' });
}

function cta(e: El, ctx: Ctx): string {
    const label = squash(text(byClass(e, 'kg-cta-sponsor-label')));
    const img = byTag(byClass(e, 'kg-cta-image-container'), 'img');
    const body = byClass(e, 'kg-cta-text');
    const a = find(e, x => x.tag === 'a' && has(x, 'kg-cta-button'));
    const url = a ? href(a.attrs.href, ctx) : null;
    const center = has(e, 'kg-cta-centered') || has(e, 'kg-cta-immersive');
    const width = ctx.width - 48;
    const tone = has(e, 'kg-cta-bg-none') || has(e, 'kg-cta-bg-white') ? 'line' : has(e, 'kg-cta-bg-grey') ? 'surface' : 'tint';
    const parts = [
        label ? `<div class="fnt" style="margin:0 0 12px;font-size:11.5px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${FAINT}">${label}</div>` : '',
        img ? `<div style="margin:0 0 16px">${imgTag(img, ctx, { width, radius: 10 })}</div>` : '',
        body ? `<div class="ink" style="font-size:16px;line-height:1.65;color:${INK}">${blocks(body.kids, box(ctx, width))}</div>` : '',
        a && url ? `<div style="margin-top:18px">${button(url, squash(text(a)), { align: center ? 'center' : 'left' })}</div>` : ''
    ];
    return panel(parts.join(''), ctx, { tone, padding: '22px 24px', center });
}

function toggle(heading: El | null, content: El | null, ctx: Ctx): string {
    const title = heading ? `<div class="ink" style="margin:0 0 6px;font-size:16px;line-height:1.45;font-weight:600;color:${INK}">${inline(heading, ctx)}</div>` : '';
    const skip = (k: Node) => !(isEl(k) && (k.tag === 'summary' || k === heading));
    const body = content ? `<div style="font-size:16px;line-height:1.65">${blocks(content.kids.filter(skip), box(ctx, ctx.width - 44))}</div>` : '';
    return panel(`${title}${body}`, ctx, { padding: '16px 20px' });
}

function header(e: El, ctx: Ctx): string {
    const heading = byClass(e, 'kg-header-card-header') ?? byClass(e, 'kg-header-card-heading');
    const sub = byClass(e, 'kg-header-card-subheader') ?? byClass(e, 'kg-header-card-subheading');
    const a = find(e, x => x.tag === 'a' && has(x, 'kg-header-card-button'));
    const url = a ? href(a.attrs.href, ctx) : null;
    const light = has(e, 'kg-style-light') || /^#f/i.test(e.attrs['data-background-color'] ?? '');
    if (light) {
        const inner = `${heading ? `<div class="ink" style="font-size:26px;line-height:1.25;font-weight:650;letter-spacing:-0.02em;color:${INK}">${inline(heading, ctx)}</div>` : ''}${sub ? `<div class="mut" style="margin-top:10px;font-size:16px;line-height:1.55;color:${MUTED}">${inline(sub, ctx)}</div>` : ''}${a && url ? `<div style="margin-top:22px">${button(url, squash(text(a)))}</div>` : ''}`;
        return panel(inner, ctx, { tone: 'surface', padding: '36px 28px', center: true });
    }
    // Dark cards stay dark in every scheme, so their colors carry no dark-mode classes.
    const inner = `${heading ? `<div style="font-size:26px;line-height:1.25;font-weight:650;letter-spacing:-0.02em;color:#ffffff">${inline(heading, ctx)}</div>` : ''}${sub ? `<div style="margin-top:10px;font-size:16px;line-height:1.55;color:#b4b4b8">${inline(sub, ctx)}</div>` : ''}${a && url ? `<div style="margin-top:22px">${button(url, squash(text(a)), { invert: true })}</div>` : ''}`;
    return `<div style="margin:${top(ctx, 4)}px 0 ${gap(ctx, 28)}px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="drk" bgcolor="${INK}" style="background-color:${INK};border-radius:14px;padding:40px 28px;text-align:center">${inner}</td></tr></table></div>`;
}

function product(e: El, ctx: Ctx): string {
    const img = find(e, x => x.tag === 'img' && has(x, 'kg-product-card-image'));
    const title = byClass(e, 'kg-product-card-title');
    const stars = findAll(e, x => has(x, 'kg-product-card-rating-star'));
    const lit = stars.filter(s => has(s, 'kg-product-card-rating-active')).length;
    const desc = byClass(e, 'kg-product-card-description');
    const a = find(e, x => x.tag === 'a' && has(x, 'kg-product-card-button'));
    const url = a ? href(a.attrs.href, ctx) : null;
    const width = ctx.width - 48;
    const inner = [
        img ? `<div style="margin:0 0 18px">${imgTag(img, ctx, { width, radius: 10 })}</div>` : '',
        title ? `<div class="ink" style="font-size:19px;line-height:1.35;font-weight:650;color:${INK}">${inline(title, ctx)}</div>` : '',
        stars.length ? `<div class="ink" style="margin-top:6px;font-size:15px;letter-spacing:2px;color:${INK}">${'★'.repeat(lit)}<span class="fnt" style="color:#c4c4c8">${'★'.repeat(Math.max(stars.length - lit, 0))}</span></div>` : '',
        desc ? `<div style="margin-top:10px;font-size:15.5px;line-height:1.6">${blocks(desc.kids, box(ctx, width))}</div>` : '',
        a && url ? `<div style="margin-top:20px">${button(url, squash(text(a)), { align: 'left' })}</div>` : ''
    ];
    return panel(inner.join(''), ctx, { padding: '22px 24px' });
}

function file(e: El, ctx: Ctx): string {
    const a = find(e, x => x.tag === 'a' && !!x.attrs.href);
    const url = a ? href(a.attrs.href, ctx) : null;
    if (!url) return '';
    const title = squash(text(byClass(e, 'kg-file-card-title')));
    const note = squash(text(byClass(e, 'kg-file-card-caption')));
    const name = squash(text(byClass(e, 'kg-file-card-filename')));
    const bytes = squash(text(byClass(e, 'kg-file-card-filesize')));
    const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle"><div style="font-size:15.5px;line-height:1.4;font-weight:600"><a href="${url}" class="ink" style="color:${INK};text-decoration:none">${title || name || 'Download the file'}</a></div>${note ? `<div class="mut" style="margin-top:3px;font-size:14px;line-height:1.5;color:${MUTED}">${note}</div>` : ''}${name || bytes ? `<div class="fnt" style="margin-top:5px;font-size:13px;color:${FAINT}">${[name, bytes].filter(Boolean).join(' · ')}</div>` : ''}</td><td width="96" align="right" valign="middle"><a href="${url}" class="ink" style="color:${INK};font-size:14px;font-weight:600;text-decoration:none">Download&nbsp;&#8595;</a></td></tr></table>`;
    return panel(inner, ctx, { padding: '16px 20px' });
}

function bookmark(e: El, ctx: Ctx): string {
    const a = find(e, x => x.tag === 'a' && !!x.attrs.href);
    const url = a ? href(a.attrs.href, ctx) : null;
    if (!url) return '';
    const title = clip(text(byClass(e, 'kg-bookmark-title')), 110);
    const desc = clip(text(byClass(e, 'kg-bookmark-description')), 150);
    const icon = find(e, x => x.tag === 'img' && has(x, 'kg-bookmark-icon'));
    const iconSrc = icon ? href(icon.attrs.src, ctx) : null;
    const meta = [text(byClass(e, 'kg-bookmark-publisher')), text(byClass(e, 'kg-bookmark-author'))].map(squash).filter(Boolean);
    let host = '';
    try {
        host = new URL(unescapeUrl(url)).hostname.replace(/^www\./, '');
    } catch {
        // Not a web address: no host line.
    }
    const thumb = byTag(byClass(e, 'kg-bookmark-thumbnail'), 'img');
    const thumbSrc = thumb ? href(thumb.attrs.src, ctx) : null;
    const line = [...new Set([...meta, host].filter(Boolean))].slice(0, 2).join(' · ');
    const content = `<div style="font-size:15.5px;line-height:1.4;font-weight:600"><a href="${url}" class="ink" style="color:${INK};text-decoration:none">${title || host || url}</a></div>${desc ? `<div class="mut" style="margin-top:5px;font-size:14px;line-height:1.5;color:${MUTED}">${desc}</div>` : ''}${line ? `<div class="fnt" style="margin-top:10px;font-size:13px;line-height:18px;color:${FAINT}">${iconSrc ? `<img src="${iconSrc}" width="16" height="16" alt="" style="display:inline-block;width:16px;height:16px;border:0;border-radius:3px;vertical-align:-3px;margin-right:6px">` : ''}${line}</div>` : ''}`;
    const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="padding:16px 18px">${content}</td>${thumbSrc ? `<td class="bmt" width="140" valign="top" style="padding:12px 12px 12px 0"><a href="${url}" style="text-decoration:none"><img src="${thumbSrc}" width="128" alt="" style="display:block;width:128px;max-width:100%;height:auto;border:0;border-radius:8px"></a></td>` : ''}</tr></table>`;
    return panel(inner, ctx, { padding: '0' });
}

function gallery(e: El, ctx: Ctx): string {
    const rows = findAll(e, x => has(x, 'kg-gallery-row'));
    const groups = (rows.length ? rows : [e]).map(r => findAll(r, x => x.tag === 'img')).filter(g => g.length);
    const space = 8;
    const body = groups
        .map((imgs, i) => {
            // Widths follow each image's shape so every image in a row is the same height, as on the web.
            const ratios = imgs.map(img => {
                const s = size(img, ctx);
                return s.width && s.height ? s.width / s.height : 1.5;
            });
            const height = (ctx.width - space * (imgs.length - 1)) / ratios.reduce((a, b) => a + b, 0);
            const cells = imgs
                .map((img, j) => {
                    const w = ratios[j] * height;
                    const pct = (((w + (j ? space : 0)) / ctx.width) * 100).toFixed(2);
                    const src = href(img.attrs.src, ctx);
                    return src
                        ? `<td width="${pct}%" valign="top" style="padding-left:${j ? space : 0}px"><img src="${src}" width="${Math.round(w)}" height="${Math.round(height)}" alt="${attr(img.attrs.alt ?? '')}" style="display:block;width:100%;height:auto;border:0;border-radius:8px"></td>`
                        : '';
                })
                .join('');
            return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${i ? ` style="margin-top:${space}px"` : ''}><tr>${cells}</tr></table>`;
        })
        .join('');
    const cap = byTag(e, 'figcaption');
    return body ? `<div style="margin:${top(ctx, 6)}px 0 ${gap(ctx, 28)}px">${body}${cap && squash(text(cap)) ? caption(cap, ctx) : ''}</div>` : '';
}

// ------------------------------------------------------------------ embeds and media

interface Playable {
    href: string;
    provider: string;
    youtube?: string;
}

/** What an embed's iframe shows, and where to watch it instead. */
function playable(src: string): Playable {
    const u = unescapeUrl(src);
    const yt = /(?:youtube(?:-nocookie)?\.com\/(?:embed|shorts|live|v)\/|youtu\.be\/)([\w-]{6,})/.exec(u)?.[1];
    if (yt) return { href: `https://www.youtube.com/watch?v=${yt}`, provider: 'YouTube', youtube: yt };
    const vimeo = /player\.vimeo\.com\/video\/(\d+)/.exec(u)?.[1];
    if (vimeo) return { href: `https://vimeo.com/${vimeo}`, provider: 'Vimeo' };
    const loom = /loom\.com\/(?:embed|share)\/([\w-]+)/.exec(u)?.[1];
    if (loom) return { href: `https://www.loom.com/share/${loom}`, provider: 'Loom' };
    const spotify = /open\.spotify\.com\/embed\/(\w+)\/(\w+)/.exec(u);
    if (spotify) return { href: `https://open.spotify.com/${spotify[1]}/${spotify[2]}`, provider: 'Spotify' };
    let provider = 'the web';
    try {
        provider = new URL(u).hostname.replace(/^www\./, '');
    } catch {
        // Keep the generic name.
    }
    return { href: u, provider };
}

function embed(e: El, ctx: Ctx): string {
    const cap = byTag(e, 'figcaption');
    const capHtml = cap && squash(text(cap)) ? caption(cap, ctx) : '';
    const wrap = (inner: string) => `<div style="margin:${top(ctx, 6)}px 0 ${gap(ctx, 28)}px">${inner}${capHtml}</div>`;
    const tweet = e.tag === 'blockquote' ? e : find(e, x => x.tag === 'blockquote' && has(x, 'twitter-tweet'));
    if (tweet && has(tweet, 'twitter-tweet')) return wrap(xPost(tweet, ctx));
    const social = find(e, x => x.tag === 'blockquote' && (has(x, 'instagram-media') || has(x, 'tiktok-embed')));
    if (social) {
        const link = unescapeUrl(social.attrs['data-instgrm-permalink'] ?? social.attrs.cite ?? byTag(social, 'a')?.attrs.href ?? '');
        const url = href(link, ctx);
        return url ? wrap(player(ctx, { href: escText(url), label: has(social, 'instagram-media') ? 'View on Instagram' : 'Watch on TikTok' })) : '';
    }
    const frame = e.tag === 'iframe' ? e : byTag(e, 'iframe');
    if (!frame?.attrs.src) {
        // Some other embed markup: whatever is left once scripts and frames are gone.
        const rest = blocks(e.kids.filter(k => !(isEl(k) && k.tag === 'figcaption')), ctx);
        return squash(rest.replace(/<[^>]+>/g, '')) ? wrap(rest) : '';
    }
    const src = frame.attrs.src;
    const p = playable(src);
    const url = href(e.attrs['data-url'] || escText(p.href), ctx) ?? escText(p.href);
    const known = ctx.o.assets?.videos?.[src];
    const image = known ?? (p.youtube ? { image: `https://i.ytimg.com/vi/${p.youtube}/hqdefault.jpg`, width: 480, height: 360 } : null);
    const title = known?.title ? escText(known.title) : squash(frame.attrs.title ?? '');
    const video = p.youtube || p.provider === 'Vimeo' || p.provider === 'Loom';
    const label = video ? `Watch on ${p.provider}` : p.provider === 'Spotify' ? 'Listen on Spotify' : `View on ${p.provider}`;
    return wrap(player(ctx, { href: url, image, label, title: title && title !== p.provider ? title : '' }));
}

/** A thumbnail with a play bar under it, all one link; without a thumbnail, just the bar. */
function player(ctx: Ctx, o: { href: string; image?: { image: string; width: number; height: number } | null; label: string; title?: string; alt?: string }): string {
    const width = ctx.width;
    const pic = o.image
        ? `<tr><td><a href="${o.href}" style="text-decoration:none"><img src="${o.image.image}" width="${width}" height="${Math.round((width * o.image.height) / o.image.width)}" alt="${attr(o.alt || o.title || o.label)}" style="display:block;width:100%;height:auto;border:0;border-radius:12px 12px 0 0"></a></td></tr>`
        : '';
    const words = o.title
        ? `<span style="display:block;color:#ffffff;font-size:14.5px;line-height:20px;font-weight:600">${clip(o.title, 90)}</span><span style="display:block;color:#a1a1a6;font-size:13px;line-height:18px">${o.label}</span>`
        : `<span style="color:#ffffff;font-size:14.5px;line-height:20px;font-weight:600">${o.label}</span>`;
    // Links sit inside the cells: a link wrapped around a table isn't clickable everywhere.
    const play = `<td width="42" valign="middle"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="30" height="30" align="center" valign="middle" bgcolor="#ffffff" style="width:30px;height:30px;border-radius:15px;background-color:#ffffff"><a href="${o.href}" style="display:block;color:${INK};font-size:11px;line-height:30px;text-decoration:none">&#9654;&#65038;</a></td></tr></table></td>`;
    const bar = `<tr><td class="plr" bgcolor="${INK}" style="background-color:${INK};border-radius:${o.image ? '0 0 12px 12px' : '12px'};padding:13px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${play}<td valign="middle"><a href="${o.href}" style="display:block;text-decoration:none">${words}</a></td></tr></table></td></tr>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${pic}${bar}</table>`;
}

function video(card: El, v: El | null, ctx: Ctx): string {
    const cap = byTag(card, 'figcaption');
    const bg = /url\(['"]?([^'")]+)['"]?\)/.exec(v?.attrs.style ?? '')?.[1];
    const posters = [card.attrs['data-kg-custom-thumbnail'], card.attrs['data-kg-thumbnail'], bg, v?.attrs.poster].filter((s): s is string => !!s && !/spacergif\.org/.test(s));
    const poster = posters[0] ? href(posters[0], ctx) : null;
    const w = num(v?.attrs.width) || 16;
    const h = num(v?.attrs.height) || 9;
    const length = squash(text(byClass(card, 'kg-video-duration')));
    const words = length ? { title: 'Watch the video', label: length } : { label: 'Watch the video' };
    const inner = player(ctx, { href: ctx.o.postUrl, image: poster ? { image: poster, width: w, height: h } : null, ...words, alt: cap ? text(cap) : 'Video' });
    return `<div style="margin:${top(ctx, 6)}px 0 ${gap(ctx, 28)}px">${inner}${cap && squash(text(cap)) ? caption(cap, ctx) : ''}</div>`;
}

function audio(card: El, ctx: Ctx): string {
    const title = squash(text(byClass(card, 'kg-audio-title'))) || 'Listen';
    const length = squash(text(byClass(card, 'kg-audio-duration')));
    const thumb = find(card, x => x.tag === 'img' && !has(x, 'kg-audio-hide'));
    const src = thumb ? href(thumb.attrs.src, ctx) : null;
    const url = ctx.o.postUrl;
    const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${src ? `<td width="68" valign="middle"><a href="${url}" style="text-decoration:none"><img src="${src}" width="56" alt="" style="display:block;width:56px;height:auto;border:0;border-radius:8px"></a></td>` : ''}<td valign="middle"><div style="font-size:15.5px;line-height:1.4;font-weight:600"><a href="${url}" class="ink" style="color:${INK};text-decoration:none">${title}</a></div><div class="mut" style="margin-top:3px;font-size:13.5px;color:${MUTED}">&#9654;&#65038;&nbsp; Listen on the web${length ? ` · ${length}` : ''}</div></td></tr></table>`;
    return panel(inner, ctx, { padding: '14px 16px' });
}

/** An X post as a card: author, text, date. Posts embedded as a bare link use text fetched ahead of time. */
function xPost(q: El, ctx: Ctx, fetched = false): string {
    const links = findAll(q, x => x.tag === 'a' && /\/status(es)?\/\d+/.test(x.attrs.href ?? ''));
    const status = links[links.length - 1];
    const raw = status?.attrs.href ?? '';
    const body = byTag(q, 'p');
    if (!body && !fetched && raw && ctx.o.assets?.tweets?.[raw]) {
        const again = find(parseHtml(ctx.o.assets.tweets[raw]), x => x.tag === 'blockquote');
        if (again) return xPost(again, ctx, true);
    }
    const url = href(raw, ctx) ?? 'https://x.com/';
    const by = /(?:[\u2014\u2013-]|&mdash;|&#8212;)\s*([^()]*?)\s*\((@\w+)\)/.exec(squash(text(q)));
    const user = /(?:twitter|x)\.com\/(\w+)\/status/.exec(unescapeUrl(raw))?.[1];
    const handle = by?.[2] ?? (user ? `@${user}` : '');
    const name = by?.[1] ?? '';
    const date = status ? squash(text(status)) : '';
    const who = name || handle ? `<div style="margin:0 0 10px;font-size:14.5px;line-height:1.4">${name ? `<strong class="ink" style="color:${INK}">${name}</strong> ` : ''}${handle ? `<span class="mut" style="color:${MUTED}">${handle}</span>` : ''}</div>` : '';
    const said = body ? `<div class="ink" style="font-size:16px;line-height:1.6;color:${INK}">${inline(body, { ...ctx, width: ctx.width - 44 })}</div>` : '';
    const foot = `<div style="margin-top:${said ? 12 : 0}px;font-size:13.5px;line-height:1.4"><a href="${url}" class="mut" style="color:${MUTED};text-decoration:none">${date && date !== url ? `${date} · ` : ''}View on X &#8594;</a></div>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="ln" style="border:1px solid ${LINE};border-radius:14px;padding:18px 20px">${who}${said}${foot}</td></tr></table>`;
}

// ------------------------------------------------------------------ assets

const YT_THUMB = (id: string, name: string) => `https://i.ytimg.com/vi/${id}/${name}.jpg`;

/**
 * What the email needs from elsewhere before it is written: sizes for images
 * that carry none, sharp video thumbnails and titles, and the text of X posts
 * that were embedded as a bare link. Anything that fails or is slow is left
 * out and the email falls back to what the post itself holds.
 */
export async function loadEmailAssets(
    html: string,
    o: { sizes?: (srcs: string[]) => Promise<Record<string, { width: number; height: number }>>; fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<EmailAssets> {
    const out: EmailAssets = { images: {}, videos: {}, tweets: {} };
    const get = o.fetch ?? fetch;
    const wait = o.timeoutMs ?? 2500;
    const root = parseHtml(html);
    const json = async (url: string) => {
        const res = await get(url, { signal: AbortSignal.timeout(wait), headers: { accept: 'application/json' } }).catch(() => null);
        return res?.ok ? ((await res.json().catch(() => null)) as Record<string, any> | null) : null;
    };
    const jobs: Promise<void>[] = [];

    const unsized = findAll(root, x => x.tag === 'img' && !!x.attrs.src && !(num(x.attrs.width) && num(x.attrs.height))).map(x => x.attrs.src);
    if (unsized.length && o.sizes) jobs.push(o.sizes([...new Set(unsized)]).then(s => void Object.assign(out.images, s)).catch(() => undefined));

    for (const frame of findAll(root, x => x.tag === 'iframe' && !!x.attrs.src).slice(0, 8)) {
        const src = frame.attrs.src;
        const p = playable(src);
        if (p.youtube) {
            const id = p.youtube;
            jobs.push(
                (async () => {
                    const [head, meta] = await Promise.all([
                        get(YT_THUMB(id, 'maxresdefault'), { method: 'HEAD', signal: AbortSignal.timeout(wait) }).catch(() => null),
                        json(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(p.href)}`)
                    ]);
                    const sharp = !!head?.ok;
                    out.videos[src] = { image: YT_THUMB(id, sharp ? 'maxresdefault' : 'hqdefault'), width: sharp ? 1280 : 480, height: sharp ? 720 : 360, title: typeof meta?.title === 'string' ? meta.title : undefined };
                })()
            );
        } else if (p.provider === 'Vimeo' || p.provider === 'Loom') {
            const api = p.provider === 'Vimeo' ? `https://vimeo.com/api/oembed.json?width=1280&url=${encodeURIComponent(p.href)}` : `https://www.loom.com/v1/oembed?url=${encodeURIComponent(p.href)}`;
            jobs.push(
                json(api).then(meta => {
                    if (typeof meta?.thumbnail_url === 'string' && /^https:\/\//.test(meta.thumbnail_url))
                        out.videos[src] = { image: escText(meta.thumbnail_url), width: Number(meta.thumbnail_width) || 16, height: Number(meta.thumbnail_height) || 9, title: typeof meta.title === 'string' ? meta.title : undefined };
                })
            );
        }
    }

    const bare = findAll(root, x => x.tag === 'blockquote' && has(x, 'twitter-tweet') && !byTag(x, 'p'));
    for (const q of bare.slice(0, 8)) {
        const raw = byTag(q, 'a')?.attrs.href;
        if (!raw) continue;
        jobs.push(
            json(`https://publish.twitter.com/oembed?omit_script=true&dnt=true&hide_thread=true&url=${encodeURIComponent(unescapeUrl(raw))}`).then(meta => {
                if (typeof meta?.html === 'string') out.tweets[raw] = meta.html;
            })
        );
    }
    await Promise.all(jobs);
    return out;
}
