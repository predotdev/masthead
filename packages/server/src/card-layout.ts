/**
 * The share card's design: 1200 x 630 on the site's night sky, the logo lockup
 * on top, then the page's topic and date, its title and a byline, the way a
 * post page opens. Trees of elements for satori (cards.ts turns them into
 * PNGs); no dependencies, so the design can be tried out anywhere.
 *
 * The sky (backdrop, stars, fade) is the same on every card: it is drawn once
 * per site and each card is set on top of it.
 */
import type { ShareCard, ShareCardSite } from '@masthead/core';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
/** Part of every card's address: change it with the design, and every card is drawn again. */
export const CARD_DESIGN = '1';

export interface CardImage {
    /** A data: URL satori can embed (PNG, JPEG or SVG). */
    src: string;
    width: number;
    height: number;
}

export interface CardNode {
    type: string;
    props: { style?: Record<string, string | number>; children?: (CardNode | string)[] | CardNode | string; src?: string; width?: number; height?: number };
}

const INK = '#fafafa';
const MUTED = 'rgba(250, 250, 250, 0.64)';
const FAINT = 'rgba(250, 250, 250, 0.46)';
/** The site's title fill: white fading down, as on post and list titles. */
const TITLE_FILL = 'linear-gradient(180deg, #ffffff 25%, rgba(255, 255, 255, 0.68) 100%)';
const TEXT_WIDTH = 1000;

function el(type: string, style: Record<string, string | number>, ...children: (CardNode | string | null | false | undefined | '')[]): CardNode {
    const kept = children.filter((c): c is CardNode | string => !!c);
    return { type, props: { style: { display: 'flex', ...style }, children: kept.length === 1 ? kept[0] : kept } };
}

function img(image: CardImage, style: Record<string, string | number>): CardNode {
    return { type: 'img', props: { src: image.src, width: image.width, height: image.height, style } };
}

const full = { position: 'absolute', top: 0, left: 0, width: CARD_WIDTH, height: CARD_HEIGHT } as const;

/** The night sky: the backdrop scaled to cover the card from the top (or a drawn glow), stars, and the fade into black. */
export function skyTree(backdrop: CardImage | null): CardNode {
    const layers: CardNode[] = [];
    if (backdrop) {
        const scale = Math.max(CARD_WIDTH / backdrop.width, CARD_HEIGHT / backdrop.height);
        const w = Math.round(backdrop.width * scale);
        layers.push(img(backdrop, { position: 'absolute', top: 0, left: Math.round((CARD_WIDTH - w) / 2), width: w, height: Math.round(backdrop.height * scale) }));
    } else {
        layers.push(
            el('div', {
                ...full,
                backgroundImage:
                    'radial-gradient(ellipse 60% 70% at 50% 34%, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0) 70%), radial-gradient(ellipse 36% 50% at 0% 0%, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0) 70%), radial-gradient(ellipse 36% 50% at 100% 0%, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0) 70%)'
            })
        );
    }
    layers.push({ type: 'img', props: { src: starfield(), width: CARD_WIDTH, height: CARD_HEIGHT, style: { ...full } } });
    layers.push(el('div', { ...full, backgroundImage: 'linear-gradient(180deg, rgba(0, 0, 0, 0) 50%, rgba(0, 0, 0, 0.62) 100%)' }));
    return el('div', { position: 'relative', width: CARD_WIDTH, height: CARD_HEIGHT, overflow: 'hidden', backgroundColor: '#000' }, ...layers);
}

/**
 * Still stars like the site's sparkles: dense in the two top corners, sparse along the edges and the
 * top, a few bright ones with a glow. The same sky on every card (a fixed seed).
 */
function starfield(): string {
    let seed = 0x9e3779b9;
    const rnd = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // x, y, width, height (fractions of the card) and how many stars.
    const regions: [number, number, number, number, number][] = [
        [0, 0, 0.3, 0.42, 70],
        [0.7, 0, 0.3, 0.42, 70],
        [0, 0.42, 0.16, 0.4, 18],
        [0.84, 0.42, 0.16, 0.4, 18],
        [0.3, 0, 0.4, 0.16, 20]
    ];
    const dots: string[] = [];
    for (const [rx, ry, rw, rh, n] of regions) {
        for (let i = 0; i < n; i++) {
            const x = (rx + rnd() * rw) * CARD_WIDTH;
            const y = (ry + rnd() * rh) * CARD_HEIGHT;
            dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.5 + rnd() * 1.1).toFixed(2)}" fill="#fff" fill-opacity="${(0.25 + rnd() * 0.7).toFixed(2)}"/>`);
        }
    }
    for (const [fx, fy, r] of [
        [0.13, 0.17, 2.2],
        [0.87, 0.12, 1.9],
        [0.06, 0.55, 1.5],
        [0.95, 0.47, 1.6],
        [0.36, 0.07, 1.3]
    ]) {
        const x = (fx * CARD_WIDTH).toFixed(1);
        const y = (fy * CARD_HEIGHT).toFixed(1);
        dots.push(`<circle cx="${x}" cy="${y}" r="${r * 4}" fill="url(#g)"/><circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>${dots.join('')}</svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Title size by length: short titles fill the card, long ones still fit in three or four lines. */
function titleSize(title: string, room: number): number {
    const n = [...title].length;
    const size = n <= 22 ? 96 : n <= 38 ? 86 : n <= 58 ? 76 : n <= 84 ? 68 : n <= 112 ? 58 : 50;
    return Math.min(size, room);
}

/** Balanced lines, except for a single word, which satori's balancing pushes off center. */
const wrap = (text: string) => (/\s/.test(text.trim()) ? 'balance' : 'wrap');

/** Cut at a word boundary with an ellipsis (satori's own line clamp can't center or balance its lines). */
function clip(text: string, max: number): string {
    const chars = [...text];
    if (chars.length <= max) return text;
    const cut = chars.slice(0, max).join('');
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).replace(/[\s,;:.\-–]+$/, '')}…`;
}

export function cardDate(iso: string | null | undefined, locale: string): string {
    if (!iso) return '';
    try {
        return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
    } catch {
        return iso.slice(0, 10);
    }
}

/** The logo and the blog's name. "Acme blog" sets the site's name at full weight and the rest light, as the front page does. */
function lockup(site: ShareCardSite, logo: CardImage | null | undefined, size: number): CardNode {
    const words = site.wordmark?.trim() || site.title;
    const named = !!site.title && words.toLowerCase().startsWith(`${site.title.toLowerCase()} `);
    const name = named ? words.slice(0, site.title.length) : words;
    const kind = named ? words.slice(site.title.length + 1) : '';
    // A small mark reads best a little taller than the text; a big one as tall as its capitals, like the front page's.
    const markHeight = size * (size > 60 ? 0.84 : 1.1);
    const big = size > 60;
    return el(
        'div',
        { alignItems: 'center' },
        logo ? img(logo, { height: markHeight, width: (markHeight * logo.width) / logo.height, marginRight: size * (big ? 0.24 : 0.34) }) : null,
        el(
            'div',
            { fontSize: size, fontWeight: 600, letterSpacing: big ? '-0.045em' : '-0.03em', color: INK, ...(big ? { backgroundImage: TITLE_FILL, backgroundClip: 'text', color: 'transparent', paddingBottom: size * 0.08 } : {}) },
            name
        ),
        kind
            ? el(
                  'div',
                  {
                      fontSize: size,
                      fontWeight: 300,
                      letterSpacing: '-0.03em',
                      color: MUTED,
                      marginLeft: size * 0.24,
                      ...(big ? { backgroundImage: 'linear-gradient(180deg, rgba(250, 250, 250, 0.88), rgba(250, 250, 250, 0.5))', backgroundClip: 'text', color: 'transparent', paddingBottom: size * 0.08 } : {})
                  },
                  kind
              )
            : null
    );
}

/** Small caps after a glowing spark, like the front page's newest post. */
function kicker(parts: (string | null | undefined)[]): CardNode | null {
    const text = parts.filter(Boolean).join('  ·  ');
    if (!text) return null;
    return el(
        'div',
        { alignItems: 'center', fontSize: 22, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: MUTED },
        el('div', { width: 8, height: 8, borderRadius: 8, marginRight: 16, backgroundColor: INK, boxShadow: '0 0 14px 3px rgba(255, 255, 255, 0.75)' }),
        text
    );
}

/** One card, set on the site's sky. */
export function cardTree(site: ShareCardSite, card: ShareCard, art: { sky: CardImage; logo?: CardImage | null; portrait?: CardImage | null }): CardNode {
    const date = cardDate(card.date, site.locale);
    // Centered, balanced lines; a fixed width, so short text doesn't shrink its box.
    const text = (size: number, max: number) =>
        card.text ? el('div', { width: TEXT_WIDTH - 120, justifyContent: 'center', marginTop: 22, fontSize: size, lineHeight: 1.4, color: MUTED, textAlign: 'center', letterSpacing: '-0.01em', textWrap: wrap(card.text) }, clip(card.text, max)) : null;

    let middle: CardNode;
    if (card.kind === 'home') {
        // As large as the front page's masthead, smaller for a long name, so it stays on one line.
        const words = [...(site.wordmark?.trim() || site.title)].length;
        middle = el('div', { flexDirection: 'column', alignItems: 'center' }, lockup(site, art.logo, Math.min(112, Math.floor(1000 / (0.58 * words + (art.logo ? 1.7 : 0))))), text(32, 100));
    } else {
        const portrait = art.portrait ? 132 : 0;
        // Room for the title: the card less the lockup, byline, kicker, portrait and text around it.
        const room = art.portrait || card.text ? 72 : 96;
        middle = el(
            'div',
            { flexDirection: 'column', alignItems: 'center', width: TEXT_WIDTH },
            art.portrait
                ? img(art.portrait, { width: portrait, height: portrait, borderRadius: portrait, marginBottom: 30, objectFit: 'cover', border: '3px solid rgba(255, 255, 255, 0.24)' })
                : null,
            kicker([card.eyebrow, date]),
            el(
                'div',
                {
                    width: TEXT_WIDTH,
                    justifyContent: 'center',
                    marginTop: 24,
                    paddingBottom: 8,
                    fontSize: titleSize(card.title, room),
                    fontWeight: 600,
                    lineHeight: 1.08,
                    letterSpacing: '-0.035em',
                    textAlign: 'center',
                    textWrap: wrap(card.title),
                    backgroundImage: TITLE_FILL,
                    backgroundClip: 'text',
                    color: 'transparent'
                },
                clip(card.title, art.portrait || card.text ? 60 : 150)
            ),
            text(28, art.portrait ? 64 : 120)
        );
    }

    const host = site.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return el(
        'div',
        { position: 'relative', width: CARD_WIDTH, height: CARD_HEIGHT, fontFamily: 'Inter', color: INK },
        img(art.sky, { ...full }),
        el(
            'div',
            { ...full, flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: '62px 72px 64px' },
            card.kind === 'home' ? el('div', { height: 38 }) : lockup(site, art.logo, 34),
            middle,
            el('div', { height: 30, fontSize: 23, color: FAINT, letterSpacing: '-0.005em' }, card.meta || host)
        )
    );
}

/** Inter's subsets on the font CDN, and the characters each covers. */
const SUBSETS: [string, [number, number][]][] = [
    ['latin', [[0x0, 0xff], [0x131, 0x131], [0x152, 0x153], [0x2bb, 0x2bc], [0x2c6, 0x2c6], [0x2da, 0x2da], [0x2dc, 0x2dc], [0x304, 0x304], [0x308, 0x308], [0x329, 0x329], [0x2000, 0x206f], [0x20ac, 0x20ac], [0x2122, 0x2122], [0x2191, 0x2191], [0x2193, 0x2193], [0x2212, 0x2212], [0x2215, 0x2215], [0xfeff, 0xfeff], [0xfffd, 0xfffd]]],
    ['latin-ext', [[0x100, 0x2ba], [0x2bd, 0x2c5], [0x2c7, 0x2cc], [0x2ce, 0x2d7], [0x2dd, 0x2ff], [0x1d00, 0x1dbf], [0x1e00, 0x1e9f], [0x1ef2, 0x1eff], [0x2020, 0x2020], [0x20a0, 0x20ab], [0x20ad, 0x20c0], [0x2113, 0x2113], [0x2c60, 0x2c7f], [0xa720, 0xa7ff]]],
    ['cyrillic', [[0x301, 0x301], [0x400, 0x45f], [0x490, 0x491], [0x4b0, 0x4b1], [0x2116, 0x2116]]],
    ['cyrillic-ext', [[0x460, 0x52f], [0x1c80, 0x1c8a], [0x20b4, 0x20b4], [0x2de0, 0x2dff], [0xa640, 0xa69f], [0xfe2e, 0xfe2f]]],
    ['greek', [[0x370, 0x377], [0x37a, 0x37f], [0x384, 0x38a], [0x38c, 0x38c], [0x38e, 0x3a1], [0x3a3, 0x3ff]]],
    ['greek-ext', [[0x1f00, 0x1fff]]],
    ['vietnamese', [[0x102, 0x103], [0x110, 0x111], [0x128, 0x129], [0x168, 0x169], [0x1a0, 0x1a1], [0x1af, 0x1b0], [0x300, 0x301], [0x303, 0x304], [0x308, 0x309], [0x323, 0x323], [0x329, 0x329], [0x1ea0, 0x1ef9], [0x20ab, 0x20ab]]]
];

function subsetOf(code: number): string | null {
    for (const [name, ranges] of SUBSETS) for (const [from, to] of ranges) if (code >= from && code <= to) return name;
    return null;
}

/** Text the card's font can draw: characters outside Inter (emoji, CJK) are left out rather than drawn as boxes. */
export function drawable(text: string): string {
    return [...text]
        .filter(c => subsetOf(c.codePointAt(0)!) !== null)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The Inter subsets a card's text needs, Latin always first. */
export function subsetsFor(texts: (string | null | undefined)[]): string[] {
    const need = new Set(['latin']);
    for (const t of texts) for (const c of t ?? '') need.add(subsetOf(c.codePointAt(0)!) ?? 'latin');
    return SUBSETS.map(([name]) => name).filter(name => need.has(name));
}
