import type { OutputFile } from '@masthead/core';
import { buildSite } from '@masthead/render';
import { getSetting, loadSnapshot, setSetting } from './content';
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
 * Renders the whole site from the database and writes only the files that
 * changed. A full render of a few hundred posts takes well under a second.
 */
export async function publishSite(env: Env, db: D1Database, options: AppOptions): Promise<PublishResult> {
    const t0 = Date.now();
    const snapshot = await loadSnapshot(env, db);
    const base = basePath(env);
    const result = await buildSite(snapshot, {
        theme: options.theme,
        render: { linkTag: linkTag(env), postsPerPage: 25 },
        features: { subscribeUrl: `${base}api/subscribe` }
    });

    const { results } = await db.prepare('SELECT path, hash FROM site_files').all<{ path: string; hash: string }>();
    const previous = new Map(results.map(r => [r.path, r.hash]));
    const keep = new Set<string>();
    const rows: D1PreparedStatement[] = [];
    const changed: string[] = [];
    let written = 0;
    const t = now();

    // A handful of parallel writes keeps a full first publish fast without flooding R2.
    const writeAll = (queue: OutputFile[]) =>
        Promise.all(
            Array.from({ length: 8 }, async () => {
                for (let f = queue.shift(); f; f = queue.shift()) {
                    keep.add(f.path);
                    const hash = await sha256(typeof f.contents === 'string' ? f.contents : f.contents);
                    if (previous.get(f.path) === hash) continue;
                    await env.BUCKET.put(`${SITE_PREFIX}${f.path}`, f.contents, { httpMetadata: { contentType: f.contentType } });
                    changed.push(f.path);
                    rows.push(
                        db
                            .prepare('INSERT INTO site_files (path, hash, content_type, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, content_type = excluded.content_type, updated_at = excluded.updated_at')
                            .bind(f.path, hash, f.contentType, t)
                    );
                    written++;
                }
            })
        );
    // Theme files first: no page may reach readers before the stylesheet version it names.
    const isAsset = (f: OutputFile) => f.path.startsWith(`${base.slice(1)}assets/`);
    await writeAll(result.files.filter(isAsset));
    await writeAll(result.files.filter(f => !isAsset(f)));

    const stale = [...previous.keys()].filter(p => !keep.has(p));
    for (let i = 0; i < stale.length; i += 500) await env.BUCKET.delete(stale.slice(i, i + 500).map(p => `${SITE_PREFIX}${p}`));
    for (const p of stale) rows.push(db.prepare('DELETE FROM site_files WHERE path = ?').bind(p));
    await batched(db, rows);
    await setSetting(db, 'site_published_at', t);
    // Readers in this data center see the change at once; elsewhere within a minute.
    const cache = edgeCache();
    if (cache) await Promise.all([...changed, ...stale].flatMap(p => [cache.delete(edgeKey(p, true)), cache.delete(edgeKey(p, false))]));
    return { written, removed: stale.length, total: result.files.length, ms: Date.now() - t0 };
}

/** Publishes scheduled posts whose time has come. Returns true when anything changed. */
export async function releaseScheduled(db: D1Database): Promise<boolean> {
    const res = await db.prepare("UPDATE posts SET status = 'published', updated_at = ? WHERE status = 'scheduled' AND published_at <= ?").bind(now(), now()).run();
    return (res.meta.changes ?? 0) > 0;
}

export async function lastPublished(db: D1Database): Promise<string | null> {
    return getSetting<string | null>(db, 'site_published_at', null);
}
