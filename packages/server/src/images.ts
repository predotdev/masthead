/**
 * Images: their real size (so pages reserve the right space and share cards
 * state it) and resized copies for srcset, made when an image is stored.
 */
import type { Env } from './env';
import { MEDIA_PREFIX } from './public';
import { now } from './util';

/** srcset widths, the same ones imported Ghost images come with. */
export const VARIANT_WIDTHS = [600, 1000, 2000];

/** Width and height from the file header (PNG, JPEG, GIF, WebP), without decoding the image. Null when unknown. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
    const u16 = (i: number) => (b[i] << 8) | b[i + 1];
    const le16 = (i: number) => b[i] | (b[i + 1] << 8);
    const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32(16), height: u32(20) };
    if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: le16(6), height: le16(8) };
    if (b.length > 30 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') {
        const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (tag === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
        if (tag === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
        if (tag === 'VP8L') {
            const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        return null;
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
        // JPEG: walk the segments to a start-of-frame marker.
        let i = 2;
        while (i + 9 < b.length) {
            if (b[i] !== 0xff) return null;
            const marker = b[i + 1];
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16(i + 7), height: u16(i + 5) };
            i += 2 + u16(i + 2);
        }
    }
    return null;
}

/** Where the resized copy of an image at content/images/<rest> lives. */
export function variantKey(rel: string, width: number): string | null {
    const m = rel.match(/^content\/images\/(?!size\/)(.+)$/);
    return m && !/\.(gif|svg)$/i.test(rel) ? `content/images/size/w${width}/${m[1]}` : null;
}

/**
 * Stores an image with its size and, when the Worker has the Images binding,
 * WebP copies at the srcset widths it is wider than. Returns its size.
 */
export async function storeImage(env: Env, db: D1Database, rel: string, bytes: Uint8Array, contentType: string, source: string): Promise<{ width: number; height: number } | null> {
    await env.BUCKET.put(`${MEDIA_PREFIX}${rel}`, bytes, { httpMetadata: { contentType } });
    const size = imageSize(bytes);
    await db
        .prepare('INSERT OR REPLACE INTO media (key, content_type, size, source_url, created_at, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(rel, contentType, bytes.length, source, now(), size?.width ?? null, size?.height ?? null)
        .run();
    if (size) await makeVariants(env, rel, bytes, size.width).catch(err => console.warn(`variants for ${rel}: ${err?.message ?? err}`));
    return size;
}

/** The resized copies of one image (skipped without the Images binding). Returns how many were written. */
export async function makeVariants(env: Env, rel: string, bytes: Uint8Array, width: number): Promise<number> {
    if (!env.IMAGES) return 0;
    let made = 0;
    for (const w of VARIANT_WIDTHS) {
        const key = variantKey(rel, w);
        if (!key || w >= width) continue;
        const out = await env.IMAGES.input(new Blob([bytes]).stream()).transform({ width: w }).output({ format: 'image/webp', quality: 82 });
        await env.BUCKET.put(`${MEDIA_PREFIX}${key}`, out.response().body, { httpMetadata: { contentType: out.contentType() } });
        made++;
    }
    return made;
}

/**
 * For images stored before sizes were recorded: reads each file's header for
 * its size, and makes missing resized copies. A few dozen per call.
 */
export async function backfillImages(env: Env, db: D1Database, limit = 40): Promise<{ sized: number; variants: number; remaining: number }> {
    const { results } = await db
        .prepare("SELECT key FROM media WHERE width IS NULL AND content_type LIKE 'image/%' AND key NOT LIKE 'content/images/size/%' ORDER BY created_at DESC LIMIT ?")
        .bind(limit)
        .all<{ key: string }>();
    let sized = 0;
    let variants = 0;
    for (const { key } of results) {
        const obj = await env.BUCKET.get(`${MEDIA_PREFIX}${key}`);
        if (!obj) {
            await db.prepare('UPDATE media SET width = 0, height = 0 WHERE key = ?').bind(key).run();
            continue;
        }
        const bytes = new Uint8Array(await obj.arrayBuffer());
        const size = imageSize(bytes);
        await db.prepare('UPDATE media SET width = ?, height = ? WHERE key = ?').bind(size?.width ?? 0, size?.height ?? 0, key).run();
        if (!size) continue;
        sized++;
        // Imported images already have copies at every width; new ones may not.
        const first = variantKey(key, VARIANT_WIDTHS[0]);
        if (first && size.width > VARIANT_WIDTHS[0] && !(await env.BUCKET.head(`${MEDIA_PREFIX}${first}`))) variants += await makeVariants(env, key, bytes, size.width).catch(() => 0);
    }
    const left = await db.prepare("SELECT COUNT(*) AS n FROM media WHERE width IS NULL AND content_type LIKE 'image/%' AND key NOT LIKE 'content/images/size/%'").first<{ n: number }>();
    return { sized, variants, remaining: Number(left?.n ?? 0) };
}
