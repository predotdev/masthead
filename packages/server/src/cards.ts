/**
 * Share cards: a PNG for every page without its own image, drawn on its first
 * request from the list the published site keeps (_masthead/cards.json) and
 * stored for good; a card's address changes whenever what it shows does.
 *
 * Satori lays the card out and resvg paints it, both WebAssembly bundled with
 * the Worker and loaded only here. Inter comes from a font CDN once and stays
 * in R2, as do the site's sky, logo and portraits once sized for the card.
 */
import type { ShareCard, ShareCards } from '@masthead/core';
import { shortHash } from '@masthead/render';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import satori, { init as initSatori } from 'satori/standalone';
import yogaWasm from 'satori/yoga.wasm';
import { CARD_DESIGN, CARD_HEIGHT, CARD_WIDTH, type CardImage, cardTree, drawable, skyTree, subsetsFor } from './card-layout';
import type { Ctx, Env } from './env';
import { imageSize } from './images';
import { MEDIA_PREFIX } from './public';
import { SITE_PREFIX } from './publish';

/** R2 prefix for what cards are made from: fonts, the sky, sized images. Never served. */
const PARTS = 'cards/';
/** Inter, as the Latin, Cyrillic, Greek and Vietnamese subsets fontsource publishes (WOFF: satori reads no WOFF2). */
const FONT_CDN = 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/';
const WEIGHTS = [300, 400, 600] as const;

const memo = new Map<string, Promise<unknown>>();

/** Satori and resvg, started once per isolate (each on its own, so one failing is retried alone). */
function engine(): Promise<unknown> {
    return Promise.all([once('engine:satori', () => initSatori(yogaWasm)), once('engine:resvg', () => initWasm(resvgWasm))]);
}

/** Draws the card listed under `key`, stores it with the site's media and returns it; null when no page lists it. */
export async function drawCard(ctx: Ctx, key: string): Promise<Uint8Array | null> {
    const list = await cardList(ctx);
    const card = list?.cards[key];
    if (!list || !card) return null;
    const clean: ShareCard = {
        ...card,
        title: drawable(card.title) || drawable(list.site.title),
        eyebrow: card.eyebrow && drawable(card.eyebrow),
        text: card.text && drawable(card.text),
        meta: card.meta && drawable(card.meta)
    };
    const [sky, logo, portrait, fonts] = await Promise.all([
        skyFor(ctx, list.site.backdrop ?? null),
        list.site.logo ? picture(ctx, list.site.logo, { height: 192 }, 'image/png') : null,
        card.image ? picture(ctx, card.image, { width: 264, height: 264, fit: 'cover' }, 'image/jpeg') : null,
        fontsFor(ctx.env, [clean.title, clean.eyebrow, clean.text, clean.meta, list.site.wordmark, list.site.title]),
        engine()
    ]);
    const svg = await satori(cardTree(list.site, clean, { sky, logo, portrait }), { width: CARD_WIDTH, height: CARD_HEIGHT, fonts });
    const png = paint(svg);
    await ctx.env.BUCKET.put(`${MEDIA_PREFIX}content/cards/${key}.png`, png, { httpMetadata: { contentType: 'image/png' } });
    return png;
}

function paint(svg: string): Uint8Array {
    const resvg = new Resvg(svg, { fitTo: { mode: 'original' } });
    const image = resvg.render();
    const png = image.asPng();
    // wasm memory is not garbage collected: free what each card used.
    image.free();
    resvg.free();
    return png;
}

let listCache: { etag: string; list: ShareCards } | null = null;

/** The published site's cards, read again only when a publish changed them. */
async function cardList(ctx: Ctx): Promise<ShareCards | null> {
    const key = `${SITE_PREFIX}${ctx.basePath.slice(1)}_masthead/cards.json`;
    const obj = await ctx.env.BUCKET.get(key, listCache ? { onlyIf: { etagDoesNotMatch: listCache.etag } } : undefined);
    if (!obj) return null;
    if (!('body' in obj)) return listCache!.list;
    listCache = { etag: obj.etag, list: await obj.json<ShareCards>() };
    return listCache.list;
}

/** The night sky every card is set on: drawn once per backdrop and design (and whether WebP backdrops can be read). */
function skyFor(ctx: Ctx, backdrop: string | null): Promise<CardImage> {
    return once(`${PARTS}sky-${shortHash(`${CARD_DESIGN}\u0000${backdrop ?? ''}\u0000${!!ctx.env.IMAGES}`)}.png`, async key => {
        let png = await read(ctx.env, key);
        if (!png) {
            const image = backdrop ? await picture(ctx, backdrop, { width: CARD_WIDTH, height: CARD_HEIGHT, fit: 'cover', gravity: 'top' }, 'image/jpeg') : null;
            const [fonts] = await Promise.all([fontsFor(ctx.env, []), engine()]);
            png = paint(await satori(skyTree(image), { width: CARD_WIDTH, height: CARD_HEIGHT, fonts }));
            await ctx.env.BUCKET.put(key, png, { httpMetadata: { contentType: 'image/png' } });
        }
        return { src: dataUrl(png, 'image/png'), width: CARD_WIDTH, height: CARD_HEIGHT };
    });
}

/**
 * An image as satori takes it (a data: URL of a PNG, JPEG or SVG), sized for the card by the
 * Images binding when there is one (which also reads WebP and AVIF). Null when it can't be used;
 * an error when it may work later (the network), so no card is stored without it.
 */
function picture(ctx: Ctx, url: string, size: { width?: number; height?: number; fit?: 'cover'; gravity?: 'top' }, format: 'image/png' | 'image/jpeg'): Promise<CardImage | null> {
    return once(`${PARTS}img-${shortHash(`${url}\u0000${JSON.stringify(size)}\u0000${format}`)}`, async key => {
        const sized = await read(ctx.env, key);
        if (sized) return raster(sized);
        const bytes = await source(ctx, url);
        if (!bytes) return null;
        if (isSvg(bytes)) return svgImage(bytes);
        if (ctx.env.IMAGES) {
            try {
                const out = await ctx.env.IMAGES.input(new Blob([bytes]).stream())
                    .transform({ ...size, fit: size.fit ?? 'scale-down' })
                    .output({ format, quality: 90 });
                const made = new Uint8Array(await out.response().arrayBuffer());
                await ctx.env.BUCKET.put(key, made);
                return raster(made);
            } catch (err) {
                console.warn(`card image ${url}: ${(err as Error)?.message ?? err}`);
            }
        }
        // Without the binding, resvg reads PNG, JPEG and GIF as they are.
        return raster(bytes);
    });
}

/** A stored image from R2, anything else over the network. */
async function source(ctx: Ctx, url: string): Promise<Uint8Array | null> {
    const site = new URL(ctx.env.SITE_URL);
    let target: URL;
    try {
        target = new URL(url, site);
    } catch {
        return null;
    }
    if (target.origin === site.origin && target.pathname.startsWith(`${ctx.basePath}content/`)) {
        let rel: string;
        try {
            rel = decodeURIComponent(target.pathname.slice(ctx.basePath.length));
        } catch {
            return null;
        }
        const obj = await ctx.env.BUCKET.get(`${MEDIA_PREFIX}${rel}`);
        return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    }
    if (!/^https?:$/.test(target.protocol)) return null;
    const res = await fetch(target.href, { signal: AbortSignal.timeout(8000) });
    if (res.status >= 500 || res.status === 429) throw new Error(`${target.href}: HTTP ${res.status}`);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

function raster(bytes: Uint8Array): CardImage | null {
    const size = imageSize(bytes);
    const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x47 ? 'image/gif' : null;
    return size && type ? { src: dataUrl(bytes, type), ...size } : null;
}

function isSvg(bytes: Uint8Array): boolean {
    return /<svg[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 1024)));
}

function svgImage(bytes: Uint8Array): CardImage | null {
    const text = new TextDecoder().decode(bytes);
    const root = text.match(/<svg\b[^>]*>/i)?.[0] ?? '';
    const attr = (name: string) => Number.parseFloat(root.match(new RegExp(`\\s${name}\\s*=\\s*["']([\\d.]+)`, 'i'))?.[1] ?? '');
    const box = root.match(/viewBox\s*=\s*["'][\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    const width = attr('width') || Number(box?.[1]);
    const height = attr('height') || Number(box?.[2]);
    return width > 0 && height > 0 ? { src: dataUrl(bytes, 'image/svg+xml'), width, height } : null;
}

/** Inter at the card's weights, in the subsets its text needs. */
async function fontsFor(env: Env, texts: (string | null | undefined)[]) {
    const files = subsetsFor(texts).flatMap(subset => WEIGHTS.map(weight => ({ subset, weight })));
    return Promise.all(
        files.map(async ({ subset, weight }) => ({
            // One family per subset: satori looks for a missing letter in the other families, not in fonts that share a name.
            name: subset === 'latin' ? 'Inter' : `Inter ${subset}`,
            weight,
            style: 'normal' as const,
            data: await font(env, `inter-${subset}-${weight}-normal.woff`)
        }))
    );
}

function font(env: Env, file: string): Promise<ArrayBuffer> {
    return once(`${PARTS}fonts/${file}`, async key => {
        const kept = await env.BUCKET.get(key);
        if (kept) return kept.arrayBuffer();
        const res = await fetch(`${FONT_CDN}${file}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'font/woff' } });
        return bytes;
    });
}

async function read(env: Env, key: string): Promise<Uint8Array | null> {
    const obj = await env.BUCKET.get(key);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}

/** One promise per key and isolate; a failure is forgotten, so the next card tries again. */
function once<T>(key: string, make: (key: string) => Promise<T>): Promise<T> {
    let p = memo.get(key) as Promise<T> | undefined;
    if (!p) {
        p = make(key);
        memo.set(key, p);
        p.catch(() => memo.delete(key));
    }
    return p;
}

function dataUrl(bytes: Uint8Array, type: string): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
}
