/**
 * Responsive images in post bodies. An image stored with the blog (under
 * <base>content/images/) gets its real width and height, a srcset of resized
 * copies in its own format, a WebP <source> and sizes that follow the theme's
 * layout, and loads lazily unless it may be the first thing a reader sees.
 * Remote images, GIFs and SVGs keep their files: the server makes no copies
 * of them.
 */

/**
 * Widths the server keeps resized copies at (content/images/size/w<N>/...) and
 * makes WebP copies at on request (content/images/size/w<N>/format/webp/...),
 * the server's VARIANT_WIDTHS. A copy is never wider than its original.
 */
export const IMAGE_WIDTHS = [600, 1000, 2000];

/** How wide a theme lays out body images, as values for the sizes attribute. */
export interface BodyImageSizes {
    /** An image in the text column. */
    content: string;
    /** An image card marked wide (kg-width-wide). */
    wide: string;
    /** An image card marked full width (kg-width-full). */
    full: string;
}

export interface ResponsiveImageOptions {
    /** The blog's path, e.g. "/blog/". */
    basePath: string;
    /** The site's origin, for absolute links to stored images. */
    origin: string;
    /** A stored image's size by path (e.g. /blog/content/images/x.png), when known. */
    sizeOf(path: string): { width: number; height: number } | null;
    sizes: BodyImageSizes;
    /**
     * The first image may be the first thing the reader sees (a page without a cover): it loads
     * at once. Otherwise every image waits until it is near.
     */
    eagerFirst?: boolean;
}

type Size = { width: number; height: number };
type Attr = [name: string, value: string | null];

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements whose text is not markup: an "<img" inside them is not an image. */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template']);

export function responsiveImages(html: string, o: ResponsiveImageOptions): string {
    if (!html.includes('<img')) return html;
    const stack: { tag: string; cls: string }[] = [];
    let out = '';
    let last = 0;
    let seen = 0;
    const re = new RegExp(TAG.source, 'g');
    for (let m = re.exec(html); m; m = re.exec(html)) {
        if (!m[2]) continue;
        const tag = m[2].toLowerCase();
        if (m[1]) {
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].tag === tag) {
                    stack.length = i;
                    break;
                }
            }
            continue;
        }
        if (RAW.has(tag)) {
            const close = new RegExp(`</${tag}\\s*>`, 'gi');
            close.lastIndex = re.lastIndex;
            re.lastIndex = close.exec(html) ? close.lastIndex : html.length;
            continue;
        }
        if (tag !== 'img') {
            if (!VOID.has(tag) && !m[3].trimEnd().endsWith('/')) stack.push({ tag, cls: tag === 'div' || tag === 'figure' ? classOf(m[3]) : '' });
            continue;
        }
        out += html.slice(last, m.index) + image(m[3], seen++, stack, html, re.lastIndex, o);
        last = re.lastIndex;
    }
    return out + html.slice(last);
}

function image(attrText: string, index: number, stack: { tag: string; cls: string }[], html: string, at: number, o: ResponsiveImageOptions): string {
    const attrs = parseAttrs(attrText);
    const get = (name: string) => attrs.find(a => a[0] === name)?.[1] ?? null;
    const set = (name: string, value: string) => {
        const a = attrs.find(x => x[0] === name);
        if (a) a[1] = value;
        else attrs.push([name, value]);
    };
    if (index > 0 || !o.eagerFirst) (set('loading', 'lazy'), set('decoding', 'async'));
    else if (get('loading') === 'lazy') attrs.splice(attrs.findIndex(a => a[0] === 'loading'), 1);

    const stored = storedImage(get('src'), o);
    if (!stored || stack.some(s => s.tag === 'picture')) return tag(attrs);
    let path = `${o.basePath}content/images/${stored.rest}`;
    try {
        path = decodeURIComponent(path);
    } catch {}
    const natural = o.sizeOf(path);
    if (natural) {
        // The file's real size: an imported page may still name the size of an original that was since replaced.
        // A smaller width set on purpose stays.
        const w = Number(get('width'));
        if (!(w > 0 && w < natural.width && Number(get('height')) > 0)) (set('width', String(natural.width)), set('height', String(natural.height)));
    }
    if (/\.(gif|svg)$/i.test(stored.rest)) return tag(attrs);

    let figure = '';
    for (const s of stack) if (s.tag === 'figure') figure = s.cls;
    const wide = /\bkg-width-wide\b/.test(figure);
    const inGallery = stack.some(s => /\bkg-gallery-image\b/.test(s.cls));
    const sizes = inGallery
        ? divide(wide ? o.sizes.wide : o.sizes.content, galleryRow(html, at))
        : /\bkg-width-full\b/.test(figure)
          ? o.sizes.full
          : wide
            ? o.sizes.wide
            : stack.some(s => /\bkg-bookmark-thumbnail\b/.test(s.cls))
              ? '220px'
              : o.sizes.content;
    set('srcset', candidates(stored, get('src')!, natural, false));
    set('sizes', sizes);
    return `<picture><source type="image/webp" srcset="${candidates(stored, get('src')!, natural, true)}" sizes="${sizes}">${tag(attrs)}</picture>`;
}

/** Where a stored image's resized copies live: the URL up to content/images/, and the path after it. */
function storedImage(src: string | null, o: ResponsiveImageOptions): { prefix: string; rest: string } | null {
    if (!src) return null;
    const base = `${o.basePath}content/images/`;
    const local = src.startsWith(`${o.origin}${base}`) ? src.slice(o.origin.length) : src;
    if (!local.startsWith(base)) return null;
    // A resized copy used as the src still names its original.
    const rest = local
        .slice(base.length)
        .split(/[?#]/)[0]
        .replace(/^size\/w\d+(?:h\d+)?\/(?:format\/[a-z]+\/)?/, '');
    return rest ? { prefix: src.slice(0, src.length - local.length) + base, rest } : null;
}

/**
 * srcset candidates: the resized copies narrower than the original, then the original itself at its
 * real width (in WebP, the copy at the next width up, which is never enlarged). Without a known size,
 * every width, the way covers do it.
 */
function candidates(img: { prefix: string; rest: string }, src: string, natural: Size | null, webp: boolean): string {
    const url = (w: number) => `${img.prefix}size/w${w}/${webp ? 'format/webp/' : ''}${img.rest}`;
    if (!natural) return IMAGE_WIDTHS.map(w => `${url(w)} ${w}w`).join(', ');
    const out: string[] = [];
    for (const w of IMAGE_WIDTHS) {
        if (w < natural.width) out.push(`${url(w)} ${w}w`);
        else return [...out, `${webp ? url(w) : src} ${natural.width}w`].join(', ');
    }
    return out.join(', ');
}

/** How many images share the gallery row an image is in. */
function galleryRow(html: string, at: number): number {
    const start = html.lastIndexOf('kg-gallery-row', at);
    const next = html.indexOf('kg-gallery-row', at);
    const end = html.indexOf('</figure>', at);
    const stop = next >= 0 && (end < 0 || next < end) ? next : end >= 0 ? end : html.length;
    return Math.max(1, (html.slice(start, stop).match(/<img\b/gi) ?? []).length);
}

/** sizes for one of n images side by side: each length divided by n. */
function divide(sizes: string, n: number): string {
    if (n <= 1) return sizes;
    return splitTop(sizes)
        .map(clause => {
            const m = clause.trim().match(/^(.*?)\s*((?:calc|min|max|clamp)\(.*\)|[\d.]+[a-z%]+)$/i);
            return m ? `${m[1] ? `${m[1]} ` : ''}calc(${m[2]} / ${n})` : clause.trim();
        })
        .join(', ');
}

/** Splits on commas outside parentheses. */
function splitTop(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') depth--;
        else if (s[i] === ',' && depth === 0) (out.push(s.slice(from, i)), (from = i + 1));
    }
    return [...out, s.slice(from)];
}

function classOf(attrText: string): string {
    return attrText.match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)?.slice(1).find(v => v !== undefined) ?? '';
}

function parseAttrs(text: string): Attr[] {
    const out: Attr[] = [];
    for (const m of text.matchAll(ATTR)) {
        const value = m[2] ?? m[3] ?? m[4];
        out.push([m[1].toLowerCase(), value === undefined ? null : m[3] !== undefined ? m[3].replace(/"/g, '&quot;') : value]);
    }
    return out;
}

function tag(attrs: Attr[]): string {
    return `<img${attrs.map(([name, value]) => (value === null ? ` ${name}` : ` ${name}="${value}"`)).join('')}>`;
}
