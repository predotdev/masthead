import type { OutputFile } from '@masthead/core';
import { renderSite } from '@masthead/render';
import { getSetting, loadBodies, loadSnapshot, setSetting } from './content';
import { analyticsConfig } from './analytics';
import { CARD_DESIGN } from './card-layout';
import { notifyIndexNow } from './indexnow';
import { batched } from './db';
import type { AppOptions, Env } from './env';
import { now, sha256 } from './util';

export const SITE_PREFIX = 'site/';

/** Cloudflare's edge cache on a custom domain; absent in local dev and a no-op on workers.dev. */
export function edgeCache(): Cache | null {
    return ((globalThis as any).caches?.default as Cache | undefined) ?? null;
}

/** Edge cache key for a site file. The canonical host and preview hosts differ only in their robots header. */
export function edgeKey(path: string, canonical: boolean): Request {
    return new Request(`https://masthead.cache/${canonical ? 'c' : 'p'}/${path}`);
}

export function basePath(env: Env): string {
    return new URL(env.SITE_URL.endsWith('/') ? env.SITE_URL : `${env.SITE_URL}/`).pathname;
}

export function linkTag(env: Env): { param: string; value: string } | undefined {
    const [param, value] = (env.LINK_TAG ?? '').split('=');
    return param && value ? { param, value } : undefined;
}

export interface PublishResult {
    written: number;
    removed: number;
    total: number;
    ms: number;
}

/**
 * Renders the site from the database and writes only the files that changed.
 * Files stream from the renderer and bodies load a few posts at a time, so
 * memory stays flat as the blog grows (10,000 posts render in one pass).
 */
export async function publishSite(env: Env, db: D1Database, options: AppOptions): Promise<PublishResult> {
    const t0 = Date.now();
    await setSetting(db, 'site_publish_started_at', now());
    const snapshot = await loadSnapshot(env, db, { bodies: false });
    const base = basePath(env);
    const files = renderSite(
        snapshot,
        {
            theme: options.theme,
            render: { linkTag: linkTag(env), postsPerPage: 25 },
            features: { subscribeUrl: `${base}api/subscribe`, analytics: analyticsConfig(env), shareCards: { version: CARD_DESIGN } }
        },
        { load: ids => loadBodies(db, ids) }
    );

    const { results } = await db.prepare('SELECT path, hash FROM site_files').all<{ path: string; hash: string }>();
    const previous = new Map(results.map(r => [r.path, r.hash]));
    const keep = new Set<string>();
    const changed: string[] = [];
    const t = now();
    let rows: D1PreparedStatement[] = [];
    let written = 0;
    let total = 0;

    const write = async (f: OutputFile) => {
        const hash = await sha256(f.contents);
        if (previous.get(f.path) === hash) return;
        await env.BUCKET.put(`${SITE_PREFIX}${f.path}`, f.contents, { httpMetadata: { contentType: f.contentType } });
        changed.push(f.path);
        rows.push(
            db
                .prepare('INSERT INTO site_files (path, hash, content_type, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, content_type = excluded.content_type, updated_at = excluded.updated_at')
                .bind(f.path, hash, f.contentType, t)
        );
        written++;
    };
    // Eight writes in flight at most. Theme files come first and are all written
    // before any page, so no page reaches readers before the stylesheet it names.
    const isAsset = (f: OutputFile) => f.path.startsWith(`${base.slice(1)}assets/`);
    let batch: OutputFile[] = [];
    let assetsDone = false;
    const flush = async () => {
        await Promise.all(batch.map(write));
        batch = [];
        if (rows.length >= 400) (await batched(db, rows), (rows = []));
    };
    for await (const f of files) {
        total++;
        keep.add(f.path);
        if (!assetsDone && !isAsset(f)) (await flush(), (assetsDone = true));
        batch.push(f);
        if (batch.length === 8) await flush();
    }
    await flush();

    const stale = [...previous.keys()].filter(p => !keep.has(p));
    for (let i = 0; i < stale.length; i += 500) await env.BUCKET.delete(stale.slice(i, i + 500).map(p => `${SITE_PREFIX}${p}`));
    for (const p of stale) rows.push(db.prepare('DELETE FROM site_files WHERE path = ?').bind(p));
    await batched(db, rows);
    await setSetting(db, 'site_published_at', t);
    await notifyIndexNow(env, db, changed);
    // Readers in this data center see the change at once; elsewhere within a minute.
    const cache = edgeCache();
    if (cache) await Promise.all([...changed, ...stale].flatMap(p => [cache.delete(edgeKey(p, true)), cache.delete(edgeKey(p, false))]));
    return { written, removed: stale.length, total, ms: Date.now() - t0 };
}

/**
 * True when the last publish started but never finished (a publish after an
 * admin request can be cut off with the request's time). The cron then runs
 * it again; files already written are skipped, so a large first publish
 * finishes over a few passes.
 */
export async function publishUnfinished(db: D1Database): Promise<boolean> {
    const [started, done] = await Promise.all([getSetting<string | null>(db, 'site_publish_started_at', null), getSetting<string | null>(db, 'site_published_at', null)]);
    return !!started && (!done || done < started) && Date.now() - Date.parse(started) > 90_000;
}

/** Publishes scheduled posts whose time has come. Returns true when anything changed. */
export async function releaseScheduled(db: D1Database): Promise<boolean> {
    const res = await db.prepare("UPDATE posts SET status = 'published', updated_at = ? WHERE status = 'scheduled' AND published_at <= ?").bind(now(), now()).run();
    return (res.meta.changes ?? 0) > 0;
}

export async function lastPublished(db: D1Database): Promise<string | null> {
    return getSetting<string | null>(db, 'site_published_at', null);
}
