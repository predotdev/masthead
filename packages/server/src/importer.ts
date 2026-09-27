import type { AudienceExport, Snapshot } from '@masthead/core';
import { getSetting, saveStaff, setSetting } from './content';
import { batched } from './db';
import type { Ctx } from './env';
import { importMembers } from './members';
import { MEDIA_PREFIX } from './public';
import { HttpError, newId, now, slugify } from './util';

/** Settings, staff, tags and posts from a snapshot. Ids and timestamps are kept; re-running updates in place. */
export async function importContent(ctx: Ctx, snap: Snapshot) {
    if (snap?.format !== 'masthead.snapshot/1') throw new HttpError(400, 'Expected a masthead.snapshot/1 document.');
    const db = ctx.db;
    const { url: _url, ...site } = snap.site;
    const current = await getSetting<Record<string, unknown>>(db, 'site', {});
    await setSetting(db, 'site', { ...current, ...site });
    if (snap.newsletter) await setSetting(db, 'newsletter', { ...(await getSetting(db, 'newsletter', {})), ...snap.newsletter });

    // Staff first: posts reference them as authors.
    const staffIds = new Map<string, string>();
    const staff = snap.staff?.length ? snap.staff : snap.authors.map(a => ({ ...a, email: `${a.slug}@authors.invalid`, role: 'author' as const, status: 'suspended' as const }));
    for (const s of staff) {
        const saved = await saveStaff(db, { ...s, id: /^[0-9a-f]{24}$/.test(s.id) ? s.id : undefined });
        staffIds.set(s.id, saved.id);
    }

    const t = now();
    const tagStmts = snap.tags.map(tag =>
        db
            .prepare(
                `INSERT INTO tags (id, slug, name, description, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, description = excluded.description, visibility = excluded.visibility, updated_at = excluded.updated_at`
            )
            .bind(tag.id, slugify(tag.slug), tag.name, tag.description ?? null, tag.visibility, t, t)
    );
    await batched(db, tagStmts);

    const postStmts: D1PreparedStatement[] = [];
    for (const p of snap.posts) {
        postStmts.push(
            db
                .prepare(
                    `INSERT INTO posts (id, type, slug, title, status, body_format, markdown, html, custom_excerpt, feature_image, feature_image_alt, feature_image_caption,
                       meta_title, meta_description, og_title, og_description, og_image, twitter_title, twitter_description, twitter_image, canonical_url,
                       featured, newsletter, published_at, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET type = excluded.type, slug = excluded.slug, title = excluded.title, status = excluded.status,
                       body_format = excluded.body_format, markdown = excluded.markdown, html = excluded.html, custom_excerpt = excluded.custom_excerpt,
                       feature_image = excluded.feature_image, feature_image_alt = excluded.feature_image_alt, feature_image_caption = excluded.feature_image_caption,
                       meta_title = excluded.meta_title, meta_description = excluded.meta_description, og_title = excluded.og_title, og_description = excluded.og_description,
                       og_image = excluded.og_image, twitter_title = excluded.twitter_title, twitter_description = excluded.twitter_description,
                       twitter_image = excluded.twitter_image, canonical_url = excluded.canonical_url, featured = excluded.featured, newsletter = excluded.newsletter,
                       published_at = excluded.published_at, created_at = excluded.created_at, updated_at = excluded.updated_at`
                )
                .bind(
                    p.id,
                    p.type,
                    p.slug,
                    p.title,
                    p.status,
                    p.bodyFormat ?? (p.markdown && !p.html ? 'markdown' : 'html'),
                    p.markdown ?? null,
                    p.html ?? null,
                    p.customExcerpt ?? null,
                    p.featureImage ?? null,
                    p.featureImageAlt ?? null,
                    p.featureImageCaption ?? null,
                    p.metaTitle ?? null,
                    p.metaDescription ?? null,
                    p.ogTitle ?? null,
                    p.ogDescription ?? null,
                    p.ogImage ?? null,
                    p.twitterTitle ?? null,
                    p.twitterDescription ?? null,
                    p.twitterImage ?? null,
                    p.canonicalUrl ?? null,
                    p.featured ? 1 : 0,
                    p.newsletter ? JSON.stringify(p.newsletter) : null,
                    p.publishedAt,
                    p.createdAt,
                    p.updatedAt
                )
        );
        postStmts.push(db.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(p.id));
        p.tags.forEach((tagId, i) => postStmts.push(db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id, sort) VALUES (?, ?, ?)').bind(p.id, tagId, i)));
        postStmts.push(db.prepare('DELETE FROM post_authors WHERE post_id = ?').bind(p.id));
        p.authors.forEach((a, i) => postStmts.push(db.prepare('INSERT OR IGNORE INTO post_authors (post_id, staff_id, sort) VALUES (?, ?, ?)').bind(p.id, staffIds.get(a) ?? a, i)));
    }
    await batched(db, postStmts);
    return { staff: staff.length, tags: snap.tags.length, posts: snap.posts.filter(p => p.type === 'post').length, pages: snap.posts.filter(p => p.type === 'page').length };
}

export async function importAudience(ctx: Ctx, chunk: Pick<AudienceExport, 'members' | 'events'>) {
    const members = Array.isArray(chunk?.members) ? chunk.members : [];
    const events = Array.isArray(chunk?.events) ? chunk.events : [];
    if (members.length > 5000 || events.length > 5000) throw new HttpError(413, 'Send at most 5,000 members and 5,000 events per request.');
    return importMembers(ctx.db, members, events);
}

/** Copies files from their current host into media storage, keeping their relative paths. */
export async function importMedia(ctx: Ctx, items: { url: string; path: string }[]) {
    if (!Array.isArray(items) || items.length > 40) throw new HttpError(413, 'Send at most 40 files per request.');
    const results: { path: string; ok: boolean; size?: number; error?: string }[] = [];
    // Workers allow six open connections per request, and each copy holds one while it streams.
    const queue = [...items];
    await Promise.all(
        Array.from({ length: 4 }, async () => {
            for (let item = queue.shift(); item; item = queue.shift()) await copyOne(item);
        })
    );
    return { results };

    async function copyOne({ url, path }: { url: string; path: string }) {
        const rel = path.replace(/^\/+/, '');
        if (!/^content\//.test(rel) || rel.includes('..')) return void results.push({ path, ok: false, error: 'Paths must start with content/.' });
        const existing = await ctx.db.prepare('SELECT size FROM media WHERE key = ?').bind(rel).first<{ size: number }>();
        if (existing) return void results.push({ path, ok: true, size: existing.size });
        try {
            const res = await fetch(url, { headers: { 'user-agent': 'masthead-import' } });
            if (!res.ok || !res.body) return void results.push({ path, ok: false, error: `HTTP ${res.status}` });
            const type = res.headers.get('content-type') ?? 'application/octet-stream';
            // Stream when the size is known so large videos never sit in memory.
            const length = Number(res.headers.get('content-length') ?? NaN);
            const body = Number.isFinite(length) && !res.headers.get('content-encoding') ? res.body : new Uint8Array(await res.arrayBuffer());
            const stored = await ctx.env.BUCKET.put(`${MEDIA_PREFIX}${rel}`, body, { httpMetadata: { contentType: type } });
            const size = stored?.size ?? 0;
            await ctx.db.prepare('INSERT OR REPLACE INTO media (key, content_type, size, source_url, created_at) VALUES (?, ?, ?, ?, ?)').bind(rel, type, size, url, now()).run();
            results.push({ path, ok: true, size });
        } catch (err: any) {
            results.push({ path, ok: false, error: err?.message ?? 'fetch failed' });
        }
    }
}

/** Points every stored reference at the new media location. */
export async function rewriteUrls(ctx: Ctx, from: string, to: string) {
    if (!from || from.length < 8) throw new HttpError(400, 'from must be a URL prefix.');
    const db = ctx.db;
    const cols = ['markdown', 'html', 'feature_image', 'og_image', 'twitter_image'];
    const results = await db.batch([
        // instr, not LIKE: D1 rejects LIKE patterns as long as a storage URL.
        ...cols.map(c => db.prepare(`UPDATE posts SET ${c} = REPLACE(${c}, ?, ?) WHERE instr(${c}, ?) > 0`).bind(from, to, from)),
        db.prepare('UPDATE staff SET profile_image = REPLACE(profile_image, ?, ?) WHERE instr(profile_image, ?) > 0').bind(from, to, from),
        db.prepare('UPDATE settings SET value = REPLACE(value, ?, ?) WHERE instr(value, ?) > 0').bind(JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1), JSON.stringify(from).slice(1, -1))
    ]);
    return { changed: results.reduce((n, r) => n + (r.meta.changes ?? 0), 0) };
}

export { newId };
