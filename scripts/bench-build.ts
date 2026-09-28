/**
 * How publishing scales with the size of the blog. Repeats a snapshot's posts
 * to N posts, then publishes the way the server does: files stream from the
 * renderer with bodies loaded 50 at a time, each file is hashed and dropped.
 * Reports time and peak heap above the starting point (the Worker's budget is
 * 128 MB). Run: bun scripts/bench-build.ts <snapshot.json> [N...]
 */
import { readFileSync } from 'node:fs';
import { renderSite } from '../packages/render/src/index';
import { defaultTheme } from '../packages/theme-default/src/index';

const [file, ...sizes] = process.argv.slice(2);
if (!file) throw new Error('Usage: bun scripts/bench-build.ts <snapshot.json> [N...]');
const snap = JSON.parse(readFileSync(file, 'utf8'));
const published = snap.posts.filter((p: any) => p.status === 'published' && p.type === 'post');

for (const n of (sizes.length ? sizes : ['40', '1000', '5000']).map(Number)) {
    // The "database": every body, outside what the publish holds.
    const store = new Map<string, any>();
    // Related posts by meaning, when the snapshot has them: each copy's point at the same copy.
    const related: Record<string, { id: string; score: number }[]> = {};
    const posts = Array.from({ length: n }, (_, i) => {
        const p = published[i % published.length];
        const k = Math.floor(i / published.length);
        const day = new Date(Date.parse(p.publishedAt) - k * 86_400_000).toISOString();
        const post = k === 0 ? p : { ...p, id: `${p.id}-${k}`, slug: `${p.slug}-${k}`, title: `${p.title} (${k})`, publishedAt: day, updatedAt: day, createdAt: day };
        store.set(post.id, { html: post.html, markdown: post.markdown, bodyFormat: post.bodyFormat });
        if (snap.related?.[p.id]) related[post.id] = snap.related[p.id].map((r: { id: string; score: number }) => ({ ...r, id: k === 0 ? r.id : `${r.id}-${k}` }));
        return { ...post, html: null, markdown: null };
    });
    const snapshot = { ...snap, posts: [...posts, ...snap.posts.filter((p: any) => p.type === 'page')], ...(snap.related ? { related } : {}) };
    for (const p of snap.posts.filter((p: any) => p.type === 'page')) store.set(p.id, { html: p.html, markdown: p.markdown, bodyFormat: p.bodyFormat });
    const bodies = { load: async (ids: string[]) => new Map(ids.map(id => [id, store.get(id)])) };

    Bun.gc(true);
    const base = process.memoryUsage().heapUsed;
    let peak = 0;
    let files = 0;
    let bytes = 0;
    const t0 = performance.now();
    for await (const f of renderSite(snapshot, { theme: defaultTheme, render: { postsPerPage: 25 } }, bodies)) {
        const data = typeof f.contents === 'string' ? new TextEncoder().encode(f.contents) : f.contents;
        await crypto.subtle.digest('SHA-256', data as BufferSource);
        bytes += data.length;
        // Live memory: collect garbage before sampling (a Worker's GC does the same under pressure).
        if (++files % 500 === 0) (Bun.gc(true), (peak = Math.max(peak, process.memoryUsage().heapUsed - base)));
    }
    Bun.gc(true);
    peak = Math.max(peak, process.memoryUsage().heapUsed - base);
    console.log(JSON.stringify({ posts: n, files, MB_written: +(bytes / 1e6).toFixed(1), ms: Math.round(performance.now() - t0), peak_live_MB: +(peak / 1e6).toFixed(1) }));
}
