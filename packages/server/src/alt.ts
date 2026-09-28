/**
 * Alt text: what an image shows, in a sentence, for search engines, screen
 * readers and the AI models that read a post. A vision model writes it from
 * the picture and the words around it. `findImages` and `withAlts` read and
 * rewrite a post body (HTML or Markdown) without touching anything else, and
 * `backfillPost` fills every empty description in one post, keeping a version
 * of the text first.
 */
import type { Post } from '@masthead/core';
import { asDataUrl, chooseModel, provider } from './ai';
import { getPost, savePost } from './content';
import type { Ctx } from './env';
import { keepRevision } from './revisions';
import { HttpError } from './util';

export const ALT_MAX = 125;

const SYSTEM = `You write alt text for images in blog posts: one plain sentence a person who cannot see the image would find useful, and the sentence a search engine or an AI model should index the image by.
Rules:
- At most ${ALT_MAX} characters. No quotes, no trailing period needed, no line breaks.
- Never start with "Image of", "Picture of", "Photo of" or "Graphic of". Start with what the image is or shows.
- Name what is visible: product and app names, screen or page titles, chart type and what it compares, the numbers or labels that carry the point.
- Use the surrounding text only to know what matters; do not describe things that are not in the picture.
- If it is a screenshot, say which product and screen. If it is a chart, say what it compares and the takeaway. If it is a photo or art, say what it shows.
- Answer with the alt text only.`;

export interface AltInput {
    /** The image: an address on this site, or a public https address. */
    src: string;
    postTitle?: string;
    /** The words just before and after the image in the post. */
    nearbyText?: string;
    model?: string;
}

/** Trims a model's answer into alt text: no lead-in, no quotes, one line, within the limit at a word boundary. */
export function tidyAlt(raw: string): string {
    let t = raw
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:alt(?: text)?\s*:\s*)/i, '')
        .replace(/^(["“`])(.*)(["”`])$/, '$2')
        .replace(/^(?:an?\s+)?(?:image|picture|photo|photograph|graphic|illustration)\s+(?:of|showing)\s+/i, '');
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (t.length > ALT_MAX) {
        const cut = t.slice(0, ALT_MAX - 1);
        t = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 60))}…`;
    }
    return t;
}

/** The image as data the model can read: a resized copy from the media library when there is one, else the original. */
async function readable(ctx: Ctx, src: string): Promise<string> {
    const abs = new URL(src, ctx.url).toString();
    const sized = abs.replace(/\/content\/images\/(?!size\/)/, '/content/images/size/w1000/');
    if (sized !== abs) {
        const small = await asDataUrl(ctx, sized).catch(() => null);
        if (small) return small;
    }
    return asDataUrl(ctx, abs);
}

export async function altText(ctx: Ctx, input: AltInput): Promise<{ alt: string; model: string }> {
    if (!input.src?.trim()) throw new HttpError(400, 'Say which image.');
    const chosen = await chooseModel(ctx, 'text', input.model || ctx.env.ALT_MODEL);
    const context = [input.postTitle ? `The post is titled "${input.postTitle}".` : '', input.nearbyText?.trim() ? `Text around the image:\n${input.nearbyText.trim().slice(0, 700)}` : ''].filter(Boolean).join('\n\n');
    const res = await provider(ctx).text({
        model: chosen.model,
        system: SYSTEM,
        messages: [{ role: 'user', content: context || 'Write the alt text for this image.', images: [await readable(ctx, input.src)] }],
        maxTokens: 120,
        temperature: 0.2
    });
    let alt = tidyAlt(res.text);
    // Over the limit: ask once for a shorter one rather than cutting a sentence off.
    if (alt.length > ALT_MAX) {
        const again = await provider(ctx).text({ model: chosen.model, system: SYSTEM, messages: [{ role: 'user', content: `Rewrite this alt text in under ${ALT_MAX - 15} characters, keeping the product and screen names and the point:\n\n${res.text.trim()}` }], maxTokens: 120, temperature: 0.2 });
        alt = tidyAlt(again.text || alt);
    }
    if (!alt) throw new HttpError(502, 'The model did not describe that image.');
    return { alt, model: res.model };
}

// ------------------------------------------------------------------ finding and filling

export interface FoundImage {
    src: string;
    alt: string;
    /** The words around it, for the model. */
    nearby: string;
}

const IMG_TAG = /<img\b[^>]*>/gi;
const MD_IMAGE = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?)\s*\)/g;
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))?.slice(1).find(v => v !== undefined) ?? null;
const words = (html: string) => html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const nearby = (before: string, after: string) => `${words(before).slice(-300)} [IMAGE] ${words(after).slice(0, 200)}`.trim();

/** Pictures that are decoration by design: link-card thumbnails and icons, or marked so. */
function decorative(tag: string): boolean {
    const cls = attr(tag, 'class') ?? '';
    return /kg-bookmark|kg-audio|brand-mark|emoji/.test(cls) || /^(?:presentation|none)$/i.test(attr(tag, 'role') ?? '') || attr(tag, 'aria-hidden') === 'true';
}

/** Every content image in a body, with the alt it has now ('' when it has none). */
export function findImages(body: string, format: 'html' | 'markdown'): FoundImage[] {
    const out: FoundImage[] = [];
    if (format === 'html') {
        for (const m of body.matchAll(IMG_TAG)) {
            const src = attr(m[0], 'src');
            if (!src || src.startsWith('data:') || decorative(m[0])) continue;
            const at = m.index ?? 0;
            out.push({ src: src.replace(/&amp;/g, '&'), alt: (attr(m[0], 'alt') ?? '').trim(), nearby: nearby(body.slice(Math.max(0, at - 1500), at), body.slice(at + m[0].length, at + m[0].length + 1000)) });
        }
    } else {
        for (const m of body.matchAll(MD_IMAGE)) {
            const at = m.index ?? 0;
            out.push({ src: m[2].replace(/^<|>$/g, ''), alt: m[1].trim(), nearby: nearby(body.slice(Math.max(0, at - 800), at), body.slice(at + m[0].length, at + m[0].length + 600)) });
        }
    }
    return out;
}

/** The body with an alt written into every image that has none and has an entry in `alts` (keyed by src). Nothing else changes. */
export function withAlts(body: string, format: 'html' | 'markdown', alts: Map<string, string>): { body: string; changed: number } {
    let changed = 0;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    if (format === 'html') {
        const next = body.replace(IMG_TAG, tag => {
            const src = attr(tag, 'src')?.replace(/&amp;/g, '&');
            const alt = src ? alts.get(src) : undefined;
            if (!alt || decorative(tag) || (attr(tag, 'alt') ?? '').trim()) return tag;
            changed++;
            const has = /\salt\s*=\s*(?:"[^"]*"|'[^']*')/i;
            return has.test(tag) ? tag.replace(has, ` alt="${esc(alt)}"`) : tag.replace(/^<img\b/i, `<img alt="${esc(alt)}"`);
        });
        return { body: next, changed };
    }
    const next = body.replace(MD_IMAGE, (whole, alt: string, src: string, title: string) => {
        const wanted = alts.get(src.replace(/^<|>$/g, ''));
        if (!wanted || alt.trim()) return whole;
        changed++;
        return `![${wanted.replace(/[[\]]/g, '')}](${src}${title})`;
    });
    return { body: next, changed };
}

/** Post bodies that carry text in more than one field: the format the editor writes, and the copy kept for Markdown readers. */
function bodies(post: Pick<Post, 'html' | 'markdown'>): { field: 'html' | 'markdown'; text: string }[] {
    return [
        ...(post.html ? [{ field: 'html' as const, text: post.html }] : []),
        ...(post.markdown ? [{ field: 'markdown' as const, text: post.markdown }] : [])
    ];
}

export interface MissingAlt {
    postId: string;
    slug: string;
    title: string;
    /** Images in the body with no description, counting each address once. */
    missing: number;
    cover: boolean;
}

/** Published posts with any image that has no description. */
export async function postsMissingAlt(db: D1Database): Promise<MissingAlt[]> {
    const { results } = await db.prepare("SELECT id FROM posts WHERE status IN ('published','scheduled') ORDER BY published_at DESC").all<{ id: string }>();
    const out: MissingAlt[] = [];
    for (const { id } of results) {
        const post = await getPost(db, id);
        if (!post) continue;
        const srcs = new Set(bodies(post).flatMap(b => findImages(b.text, b.field).filter(i => !i.alt).map(i => i.src)));
        const cover = !!post.featureImage && !post.featureImageAlt?.trim();
        if (srcs.size || cover) out.push({ postId: id, slug: post.slug, title: post.title, missing: srcs.size, cover });
    }
    return out;
}

export interface BackfillRow {
    where: 'cover' | 'body';
    src: string;
    alt: string;
}

/**
 * Writes a description into every image of one post that has none. A version of
 * the text is kept first (the history shows who and why), so it can be undone.
 * `dryRun` only reports what it would write.
 */
export async function backfillPost(ctx: Ctx, postId: string, o: { dryRun?: boolean; model?: string; by?: string } = {}): Promise<{ postId: string; slug: string; rows: BackfillRow[]; written: boolean }> {
    const post = await getPost(ctx.db, postId);
    if (!post) throw new HttpError(404, 'Post not found.');
    const targets = new Map<string, string>();
    for (const b of bodies(post)) for (const i of findImages(b.text, b.field)) if (!i.alt && !targets.has(i.src)) targets.set(i.src, i.nearby);
    const alts = new Map<string, string>();
    const rows: BackfillRow[] = [];
    const queue = [...targets];
    // Three at a time keeps a post with many screenshots quick without flooding the gateway.
    await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
            for (let job = queue.shift(); job; job = queue.shift()) {
                const [src, near] = job;
                const { alt } = await altText(ctx, { src, postTitle: post.title, nearbyText: near, model: o.model });
                alts.set(src, alt);
                rows.push({ where: 'body', src, alt });
            }
        })
    );
    let coverAlt: string | undefined;
    if (post.featureImage && !post.featureImageAlt?.trim()) {
        coverAlt = (await altText(ctx, { src: post.featureImage, postTitle: post.title, nearbyText: post.customExcerpt ?? undefined, model: o.model })).alt;
        rows.unshift({ where: 'cover', src: post.featureImage, alt: coverAlt });
    }
    const patch: Partial<Post> = {};
    for (const b of bodies(post)) {
        const next = withAlts(b.text, b.field, alts);
        if (next.changed) patch[b.field] = next.body;
    }
    if (coverAlt) patch.featureImageAlt = coverAlt;
    if (o.dryRun || !Object.keys(patch).length) return { postId, slug: post.slug, rows: rows.sort((a, b) => a.where.localeCompare(b.where)), written: false };
    await keepRevision(ctx.db, post, patch, o.by ?? 'alt text backfill', 'alt text');
    // Only the description changes: the post keeps its dates, so it does not jump to the top or re-notify anyone.
    await savePost(ctx.db, { id: postId, ...patch }, { keepTimestamps: { createdAt: post.createdAt, updatedAt: post.updatedAt } });
    return { postId, slug: post.slug, rows, written: true };
}
