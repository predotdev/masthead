/**
 * The left share card design (appearance.shareCards.design = 'left'): 1200 x 630 on a sky of still
 * stars. The site's logo and a trail of small mono capitals on top, the headline and one support
 * line set left, then a footer band under a hairline: the byline or post count on the left, the
 * page's address on the right. An author's card has their portrait (or initial) in a circle.
 *
 * Trees of elements for satori, like card-layout.ts; no dependencies, so the design can be tried
 * out anywhere. Text is fitted with satori's own measurements (fitCard), never cut mid-sentence:
 * a long title steps down from 64px to 48px, and support copy that does not fit loses whole
 * sentences. Nothing is drawn under 28px, so the card still reads at a feed's 0.42x scale.
 */
import type { ShareCard, ShareCardSite } from '@masthead/core';
import { type CardImage, type CardNode, cardDate } from './card-layout';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
export const MIN_FONT = 28;

/** The fonts this design loads: fontsource packages, their version on the CDN, and the files' weights (WOFF: satori reads no WOFF2). */
export const LEFT_FONTS = {
    sans: { family: 'Inter', pkg: 'inter', version: '5.3.0', weights: [500, 600, 800] },
    mono: { family: 'JetBrains Mono', pkg: 'jetbrains-mono', version: '5.3.0', weights: [500, 700] }
} as const;

const PAD = 72;
const INNER = CARD_WIDTH - PAD * 2;
const SANS = LEFT_FONTS.sans.family;
const MONO = LEFT_FONTS.mono.family;
const INK = '#ffffff';
const DIM = '#7d7d7d';
const SOFT = '#a5a5a5';
const MUTE = '#8f8f8f';
const STRONG = '#e8e8e8';
const LABEL = '#c4c4c4';
const RULE = 'rgba(255,255,255,0.09)';

const TITLE_SIZES = [64, 60, 56, 52, 48];
const TEXT_SIZE = 31;
const TEXT_LINE = 1.42;
const TITLE_LINE = 1.06;
const MARK_HEIGHT = 34;
/** A wide logo (a wordmark) is drawn no wider than this, so the trail keeps its room. */
const MARK_MAX_WIDTH = 240;
const AVATAR = 132;

/** What the design draws: the site and page reduced to its parts. */
export interface LeftCard {
    /** The trail after the logo, e.g. ["Acme", "Blog", "Product"]. */
    eyebrow: string[];
    title: string;
    /** A second headline line, set dimmer. */
    dim?: string | null;
    text?: string | null;
    /** The footer band: left (byline and date, or a count) and right (the address). */
    meta: [string, string];
    /** An initial for an author without a portrait; a card with one leaves room for the circle. */
    avatar?: string | null;
    /** Balance the title's lines (posts). */
    balance?: boolean;
}

/** What fitCard chose. */
export interface LeftFit {
    titleSize?: number;
    title?: string;
    text?: string | null;
    textSize?: number;
    eyebrow?: string[];
    meta?: [string, string];
}

export interface LeftArt {
    sky: string;
    mark?: CardImage | null;
    portrait?: CardImage | null;
}

/** A page's card as this design draws it. */
export function leftCard(site: ShareCardSite, card: ShareCard): LeftCard {
    const trail = site.trail?.length ? site.trail : [site.title, 'Blog'];
    const date = card.kind === 'post' ? cardDate(card.date, site.locale) : '';
    return {
        eyebrow: [...trail, card.eyebrow].filter((p): p is string => !!p?.trim()),
        title: card.title,
        dim: card.dim,
        text: card.text,
        meta: [[card.meta, date].filter(Boolean).join(' · '), card.address ?? ''],
        avatar: card.kind === 'author' ? ([...card.title.trim()][0]?.toUpperCase() ?? null) : null,
        balance: card.kind === 'post'
    };
}

// ------------------------------------------------------------------ art

/**
 * The sky every card sits on: 260 still stars from a fixed seed and a soft light from the top
 * left, as one SVG.
 */
export function skySvg(): string {
    let seed = 0x5eed2026;
    const rnd = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const radii = [0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.4];
    let stars = '';
    for (let i = 0; i < 260; i++) {
        const x = (rnd() * CARD_WIDTH).toFixed(1);
        const y = (rnd() * CARD_HEIGHT).toFixed(1);
        const r = radii[Math.floor(rnd() * radii.length)];
        stars += `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" fill-opacity="${(0.11 + rnd() * 0.49).toFixed(2)}"/>`;
    }
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">` +
        '<defs><radialGradient id="l" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(168 -50.4) scale(880 520)">' +
        '<stop offset="0" stop-color="#fff" stop-opacity="0.09"/><stop offset="0.64" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>' +
        `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#000"/>${stars}<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#l)"/></svg>`
    );
}

/** An SVG string as a data: URL satori embeds. */
export function svgDataUrl(svg: string): string {
    const bytes = new TextEncoder().encode(svg);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/svg+xml;base64,${btoa(bin)}`;
}

// ------------------------------------------------------------------ elements

type Style = Record<string, string | number>;
type Child = CardNode | string | null | undefined | false | '' | Child[];

function el(type: string, style: Style, ...children: Child[]): CardNode {
    const kept = (children.flat(4) as Child[]).filter((c): c is CardNode | string => c !== null && c !== undefined && c !== false && c !== '');
    return { type, props: { style: { display: 'flex', ...style }, children: kept.length === 1 ? kept[0] : kept } };
}

function img(src: string, width: number, height: number, style: Style = {}): CardNode {
    return { type: 'img', props: { src, width, height, style: { width, height, ...style } } };
}

/**
 * Support copy as satori lays out mixed weights: one element per word in a wrapping row (satori
 * does not flow spans inline), "**stressed**" words brighter.
 */
function richText(text: string, size: number, color: string): CardNode[] {
    // Words in order; `glued` marks one that follows the last with no space ("**code**.").
    const words: { w: string; strong: boolean; glued: boolean }[] = [];
    let spaced = true;
    for (const part of String(text).split(/(\*\*[^*]+\*\*)/)) {
        if (!part) continue;
        const strong = part.startsWith('**') && part.endsWith('**');
        const body = strong ? part.slice(2, -2) : part;
        for (const w of body.split(/(\s+)/)) {
            if (!w) continue;
            if (/^\s+$/.test(w)) {
                spaced = true;
                continue;
            }
            words.push({ w, strong, glued: !spaced && words.length > 0 });
            spaced = false;
        }
    }
    const groups: (typeof words)[] = [];
    for (const word of words) {
        if (word.glued) groups[groups.length - 1].push(word);
        else groups.push([word]);
    }
    const space = size * 0.27;
    const span = ({ w, strong }: { w: string; strong: boolean }) => el('div', strong ? { color: STRONG, fontWeight: 600 } : { color }, w);
    return groups.map((g, i) => el('div', { marginRight: i < groups.length - 1 ? space : 0 }, g.map(span)));
}

/**
 * The trail after the mark: capitals 0.2em apart, one space between words and two either side of
 * each dot. Each word is its own element, since satori spaces a run of mono capitals unevenly.
 *
 * satori 0.32 (the Worker's) also spaces a run's last letter from what follows, which 0.33 (the
 * spec's) does not: each word's margin takes that back, so the trail sits where the spec's does.
 */
const TRAIL_TRACKING = 5.6;
function eyebrow(parts: string[]): CardNode {
    const space = 28 * 0.6 + TRAIL_TRACKING;
    const items: { t: string; gap: number }[] = [];
    parts.filter(Boolean).forEach((part, p) => {
        if (p) items.push({ t: '·', gap: space * 2 });
        const words = String(part).toUpperCase().split(/\s+/).filter(Boolean);
        words.forEach((w, i) => items.push({ t: w, gap: i < words.length - 1 ? space : space * 2 }));
    });
    return el(
        'div',
        { alignItems: 'center', fontFamily: MONO, fontSize: 28, fontWeight: 500, letterSpacing: TRAIL_TRACKING, color: MUTE, lineHeight: 1 },
        items.map((it, i) => el('div', { marginRight: (i < items.length - 1 ? it.gap : 0) - TRAIL_TRACKING }, it.t))
    );
}

function markWidth(mark: CardImage | null | undefined): number {
    return mark ? Math.min(MARK_MAX_WIDTH, Math.round(((MARK_HEIGHT * mark.width) / mark.height) * 100) / 100) : 0;
}

function lockup(parts: string[], art: LeftArt): CardNode {
    const w = markWidth(art.mark);
    return el('div', { alignItems: 'center', height: MARK_HEIGHT }, art.mark ? img(art.mark.src, w, MARK_HEIGHT, { marginRight: 18, objectFit: 'contain' }) : null, eyebrow(parts));
}

function titleBlock(card: LeftCard, title: string, size: number, art: LeftArt): CardNode {
    const line = (text: string, color: string) =>
        el(
            'div',
            {
                width: card.avatar || art.portrait ? INNER - 170 : INNER,
                fontSize: size,
                fontWeight: 800,
                lineHeight: TITLE_LINE,
                letterSpacing: -0.03 * size,
                color,
                ...(card.balance ? { textWrap: 'balance' } : {})
            },
            text
        );
    return el('div', { flexDirection: 'column', marginTop: 30 }, line(title, INK), card.dim ? line(card.dim, DIM) : null);
}

function textBlock(text: string, size: number): CardNode {
    return el(
        'div',
        { flexWrap: 'wrap', marginTop: 24, maxWidth: 1040, fontSize: size, fontWeight: 500, lineHeight: TEXT_LINE, letterSpacing: -0.01 * size, color: SOFT },
        richText(text, size, SOFT)
    );
}

function meta([left, right]: [string, string]): CardNode {
    return el(
        'div',
        { borderTop: `1px solid ${RULE}`, paddingTop: 30, width: INNER, justifyContent: 'space-between', alignItems: 'baseline' },
        el('div', { fontSize: 28, fontWeight: 500, color: LABEL, whiteSpace: 'nowrap' }, left || ''),
        el('div', { fontFamily: MONO, fontSize: 28, fontWeight: 500, color: MUTE, whiteSpace: 'nowrap' }, right || '')
    );
}

function avatar(card: LeftCard, art: LeftArt): CardNode | null {
    const box = { position: 'absolute', top: PAD, right: PAD, width: AVATAR, height: AVATAR, borderRadius: AVATAR };
    if (art.portrait) return img(art.portrait.src, AVATAR, AVATAR, { ...box, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.16)' });
    if (!card.avatar) return null;
    return el(
        'div',
        { ...box, border: '1px solid rgba(255,255,255,0.16)', backgroundColor: '#1a1a1a', color: STRONG, alignItems: 'center', justifyContent: 'center', fontSize: 52, fontWeight: 600, letterSpacing: -1 },
        card.avatar
    );
}

/** One card's tree. `fit` is what fitCard() chose; without it the card is drawn at the design sizes. */
export function cardTree(card: LeftCard, art: LeftArt, fit: LeftFit = {}): CardNode {
    const text = fit.text === undefined ? card.text : fit.text;
    return el(
        'div',
        { position: 'relative', width: CARD_WIDTH, height: CARD_HEIGHT, backgroundColor: '#000', fontFamily: SANS, color: INK, overflow: 'hidden' },
        img(art.sky, CARD_WIDTH, CARD_HEIGHT, { position: 'absolute', top: 0, left: 0 }),
        el(
            'div',
            { position: 'absolute', top: 0, left: 0, width: CARD_WIDTH, height: CARD_HEIGHT, padding: PAD, flexDirection: 'column' },
            lockup(fit.eyebrow ?? card.eyebrow, art),
            titleBlock(card, fit.title ?? card.title, fit.titleSize ?? TITLE_SIZES[0], art),
            text ? textBlock(text, fit.textSize ?? TEXT_SIZE) : null,
            el('div', { flexGrow: 1 }),
            meta(fit.meta ?? card.meta)
        ),
        avatar(card, art)
    );
}

// ------------------------------------------------------------------ fitting

/** Satori's layout call, as fitCard uses it (the module's default export). */
export type Layout = (node: CardNode, options: any) => Promise<string>;

/** The footer band's height (a meta line), so the body knows its room. */
const FOOTER_HEIGHT = 31 + 34;

function sentences(text: string): string[] {
    // A sentence ends at . ! or ? before a space, so "acme.io" and "3.0" stay whole.
    return String(text)
        .split(/(?<=[.!?](?:\*\*)?)\s+/)
        .map(s => s.trim())
        .filter(Boolean);
}

/** Height satori gives `node` laid out INNER wide. */
async function heightOf(satori: Layout, fonts: any[], node: CardNode): Promise<number> {
    const svg = await satori(el('div', { width: INNER, flexDirection: 'column', fontFamily: SANS }, node), { width: INNER, fonts });
    return Number(svg.match(/height="([\d.]+)"/)?.[1] ?? 0);
}

async function widthOf(satori: Layout, fonts: any[], node: CardNode): Promise<number> {
    const svg = await satori(el('div', { flexDirection: 'row', fontFamily: SANS }, node), { height: 200, fonts });
    return Number(svg.match(/width="([\d.]+)"/)?.[1] ?? 0);
}

/**
 * Fits a card's text to the frame with satori's own measurements. The title steps down from 64px
 * until it takes two lines (three at 48px). The support copy keeps as many whole sentences as fit
 * in three lines (two under a three-line title) at 31px; a single sentence too long for that goes
 * to 28px, then ends at a clause or a word with an ellipsis. The address on the right of the meta
 * line stays whole; the line on the left gives way to it when both don't fit.
 *
 * Beyond the spec, for any site's text: a trail too wide for the card drops its middle parts, then
 * shortens its last one; a title still over three lines at 48px ends at a word with an ellipsis;
 * and support copy with no room for one line is left out.
 */
export async function fitCard(card: LeftCard, art: LeftArt, satori: Layout, fonts: any[]): Promise<LeftFit> {
    const room = CARD_HEIGHT - PAD * 2 - MARK_HEIGHT - FOOTER_HEIGHT - 8;
    const fit: LeftFit = {};

    // The trail: as wide as the card, less the mark and (top right) the avatar.
    const trailRoom = INNER - (art.mark ? markWidth(art.mark) + 18 : 0) - (card.avatar || art.portrait ? 170 : 0);
    const trailWidth = (parts: string[]) => widthOf(satori, fonts, eyebrow(parts));
    if ((await trailWidth(card.eyebrow)) > trailRoom) {
        let parts = [...card.eyebrow];
        while (parts.length > 2 && (await trailWidth(parts)) > trailRoom) parts.splice(1, 1);
        while ((await trailWidth(parts)) > trailRoom) {
            const last = parts[parts.length - 1].replace(/…$/, '');
            const words = last.split(/\s+/);
            if (words.length > 1) parts[parts.length - 1] = `${words.slice(0, -1).join(' ')}…`;
            else if (parts.length > 1) parts = parts.slice(0, -1);
            else break;
        }
        fit.eyebrow = parts;
    }

    let titleSize = TITLE_SIZES[0];
    let titleHeight = 0;
    let titleLines = 0;
    const linesOf = (height: number, size: number) => Math.round((height - 30) / (size * TITLE_LINE));
    for (const size of TITLE_SIZES) {
        titleSize = size;
        titleHeight = await heightOf(satori, fonts, titleBlock(card, card.title, size, art));
        titleLines = linesOf(titleHeight, size);
        if (titleLines <= (card.dim ? 1 : 0) + (size === TITLE_SIZES[TITLE_SIZES.length - 1] ? 3 : 2)) break;
    }
    fit.titleSize = titleSize;
    const maxTitleLines = (card.dim ? 1 : 0) + 3;
    if (titleLines > maxTitleLines) {
        const words = card.title.split(' ');
        for (let n = words.length - 1; n > 0; n--) {
            const title = `${words.slice(0, n).join(' ').replace(/[,;:–—-]+$/, '')}…`;
            const height = await heightOf(satori, fonts, titleBlock(card, title, titleSize, art));
            if (linesOf(height, titleSize) <= maxTitleLines || n === 1) {
                fit.title = title;
                titleHeight = height;
                titleLines = linesOf(height, titleSize);
                break;
            }
        }
    }

    if (card.text) {
        const maxLines = titleLines >= 3 ? 2 : 3;
        const left = room - titleHeight;
        const fits = async (text: string, size: number) => {
            const h = await heightOf(satori, fonts, textBlock(text, size));
            return h <= left && Math.round((h - 24) / (size * TEXT_LINE)) <= maxLines;
        };
        const parts = sentences(card.text);
        let text: string | null = null;
        for (let n = parts.length; n > 0 && !text; n--) if (await fits(parts.slice(0, n).join(' '), TEXT_SIZE)) text = parts.slice(0, n).join(' ');
        fit.textSize = TEXT_SIZE;
        if (!text && (await fits(parts[0], MIN_FONT))) {
            text = parts[0];
            fit.textSize = MIN_FONT;
        }
        if (!text) {
            // One sentence too long for the card: end it at the last clause that fits, else at a word.
            fit.textSize = MIN_FONT;
            const words = parts[0].split(' ');
            let cut: string | null = null;
            for (let n = words.length - 1; n > 3 && !cut; n--) {
                const head = words.slice(0, n).join(' ');
                if (/[,;:]$/.test(head) && (await fits(`${head.slice(0, -1)}…`, MIN_FONT))) cut = `${head.slice(0, -1)}…`;
            }
            for (let n = words.length - 1; n > 3 && !cut; n--) {
                const t = `${words.slice(0, n).join(' ').replace(/[,;:–-]+$/, '')}…`;
                if (await fits(t, MIN_FONT)) cut = t;
            }
            const four = `${words.slice(0, 4).join(' ')}…`;
            // No room for even a line: the card goes without.
            text = cut ?? ((await fits(four, MIN_FONT)) ? four : null);
        }
        fit.text = text;
    }

    const [l, r] = card.meta;
    const right = r ? await widthOf(satori, fonts, el('div', { fontFamily: MONO, fontSize: 28, fontWeight: 500 }, r)) : 0;
    const fitsLeft = !!l && (await widthOf(satori, fonts, el('div', { fontSize: 28, fontWeight: 500 }, l))) <= INNER - right - 40;
    fit.meta = [fitsLeft ? l : '', r];
    return fit;
}

/** Every problem with a tree: any text under MIN_FONT. Empty when the card is fine. */
export function checkCard(tree: CardNode): string[] {
    const errors: string[] = [];
    const walk = (node: CardNode | string | undefined, size: number) => {
        if (!node || typeof node !== 'object') return;
        const s = Number(node.props?.style?.fontSize ?? size);
        const kids = node.props?.children;
        const list = Array.isArray(kids) ? kids : [kids];
        if (list.some(k => typeof k === 'string' && k.trim()) && s < MIN_FONT) errors.push(`"${list.filter(k => typeof k === 'string').join(' ').slice(0, 40)}" is ${s}px (min ${MIN_FONT}px)`);
        for (const k of list) walk(k as CardNode | string | undefined, s);
    };
    walk(tree, 16);
    return errors;
}
