/**
 * What the editor's AI knows: every post on this blog plus the sources listed
 * in Settings (docs, a changelog, an llms.txt), split into passages and
 * embedded, and the team's standing notes ("memory").
 *
 * Passages live in D1. Their vectors are packed into one R2 object so a lookup
 * reads a single file (cached per isolate) and scores it in memory. Refreshes
 * only embed passages whose text changed, a batch at a time, so no request or
 * cron tick runs long.
 */
import type { AIProvider } from '@masthead/core';
import { plainText } from '@masthead/render';
import { aiSettings, getSetting, setSetting, siteSettings } from './content';
import { batched } from './db';
import type { Ctx, Env } from './env';
import { HttpError, now, sha256 } from './util';

const INDEX_KEY = 'ai/knowledge.f32';
const IDS_KEY = 'ai/knowledge.ids.json';
/** Each post's vector (the mean of its passages'), for related posts. */
const POSTS_INDEX_KEY = 'ai/posts.f32';
const POSTS_IDS_KEY = 'ai/posts.json';
const CHUNK = 1400;
const BATCH = 48;
/** The closest posts kept for each post; its page shows three of them, after tags and dates have their say. */
const RELATED = 8;

export interface Memory {
    id: string;
    text: string;
    at: string;
    by?: string;
}

export interface Passage {
    id: number;
    source: string;
    title: string;
    url: string | null;
    text: string;
    score: number;
}

// ------------------------------------------------------------------ memory

export async function listMemory(db: D1Database): Promise<Memory[]> {
    return (await getSetting<{ memory?: Memory[] }>(db, 'ai', {})).memory ?? [];
}

export async function addMemory(db: D1Database, text: string, by?: string): Promise<Memory[]> {
    const clean = text.trim().slice(0, 600);
    if (!clean) throw new HttpError(400, 'Write what should be remembered.');
    const ai = await getSetting<Record<string, unknown>>(db, 'ai', {});
    const memory = [...((ai.memory as Memory[]) ?? []), { id: crypto.randomUUID().slice(0, 8), text: clean, at: now(), by }].slice(-100);
    await setSetting(db, 'ai', { ...ai, memory });
    return memory;
}

export async function deleteMemory(db: D1Database, id: string): Promise<Memory[]> {
    const ai = await getSetting<Record<string, unknown>>(db, 'ai', {});
    const memory = ((ai.memory as Memory[]) ?? []).filter(m => m.id !== id);
    await setSetting(db, 'ai', { ...ai, memory });
    return memory;
}

// ------------------------------------------------------------------ passages

/** Splits text into passages of about CHUNK characters on paragraph boundaries. */
export function chunkText(text: string, size = CHUNK): string[] {
    const paras = text
        .replace(/\r/g, '')
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean);
    const out: string[] = [];
    let cur = '';
    for (const p of paras) {
        if (p.length > size * 1.5) {
            if (cur) out.push(cur), (cur = '');
            // A very long paragraph splits between words.
            for (let i = 0; i < p.length; ) {
                let end = Math.min(p.length, i + size);
                const space = end < p.length ? p.lastIndexOf(' ', end) : -1;
                if (space > i + size / 2) end = space;
                out.push(p.slice(i, end).trim());
                i = end;
            }
            continue;
        }
        if (cur && cur.length + p.length + 2 > size) out.push(cur), (cur = '');
        cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (cur) out.push(cur);
    return out;
}

/** HTML as text that keeps its paragraph breaks, so passages split between paragraphs. */
export function blockText(html: string): string {
    return html
        // Comments first: page source notes are not the page's content.
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/(?:p|h[1-6]|li|blockquote|pre|figure|figcaption|div|tr|table|ul|ol|section)>|<br\s*\/?>/gi, '\n\n')
        .split(/\n{2,}/)
        .map(part => plainText(part))
        .filter(Boolean)
        .join('\n\n');
}

/** Turns a fetched source into titled passages. Changelogs in the {changelog:[{date, items}]} shape read as dated entries. */
function passagesFromSource(url: string, body: string, contentType: string): { title: string; text: string }[] {
    let text = body;
    let title = new URL(url).host + new URL(url).pathname;
    if (contentType.includes('json')) {
        try {
            const json = JSON.parse(body);
            if (Array.isArray(json?.changelog)) {
                text = json.changelog
                    .map((day: any) => `${day.date}\n${(day.items ?? []).map((i: any) => `- [${i.type ?? 'update'}] ${i.title}: ${i.description ?? ''}`).join('\n')}`)
                    .join('\n\n');
                title = `Changelog (${new URL(url).host})`;
            } else text = JSON.stringify(json, null, 1);
        } catch {
            // Not JSON after all: index the raw text.
        }
    } else if (contentType.includes('html')) text = blockText(body);
    // Markdown documents (llms.txt style): keep the nearest heading as the passage title.
    const out: { title: string; text: string }[] = [];
    const sections = text.split(/\n(?=#{1,3} )/);
    for (const section of sections) {
        const heading = section.match(/^#{1,3} (.+)/)?.[1]?.trim();
        for (const piece of chunkText(section)) out.push({ title: heading ? `${title}: ${heading}` : title, text: piece });
    }
    return out;
}

async function sourceDocuments(ctx: Ctx, postsOnly: boolean): Promise<{ source: string; title: string; url: string | null; text: string }[]> {
    const docs: { source: string; title: string; url: string | null; text: string }[] = [];
    // Every published post and page, whole (the list query leaves bodies out).
    const { results: posts } = await ctx.db
        .prepare("SELECT id, slug, title, custom_excerpt, markdown, html FROM posts WHERE status = 'published' ORDER BY published_at DESC")
        .all<{ id: string; slug: string; title: string; custom_excerpt: string | null; markdown: string | null; html: string | null }>();
    const site = new URL(ctx.env.SITE_URL);
    for (const p of posts) {
        const body = p.html ? blockText(p.html) : (p.markdown ?? '');
        const url = new URL(`${ctx.basePath}${p.slug}/`, site.origin).toString();
        for (const piece of chunkText(`${p.custom_excerpt ?? ''}\n\n${body}`)) docs.push({ source: `post:${p.id}`, title: p.title, url, text: piece });
    }
    // Configured sources.
    const { knowledgeSources } = await aiSettings(ctx.env, ctx.db);
    for (const url of postsOnly ? [] : knowledgeSources) {
        try {
            const res = await fetch(url, { headers: { 'user-agent': 'masthead-knowledge' }, signal: AbortSignal.timeout(15_000) });
            if (!res.ok) continue;
            for (const piece of passagesFromSource(url, await res.text(), res.headers.get('content-type') ?? '')) docs.push({ source: `url:${url}`, title: piece.title, url, text: piece.text });
        } catch {
            // An unreachable source keeps its old passages until the next refresh.
            docs.push(...(await existingSource(ctx.db, `url:${url}`)));
        }
    }
    return docs;
}

async function existingSource(db: D1Database, source: string) {
    const { results } = await db.prepare('SELECT source, title, url, chunk AS text FROM knowledge WHERE source = ?').bind(source).all<{ source: string; title: string; url: string | null; text: string }>();
    return results;
}

/** Brings passages in line with the sources: unchanged ones keep their vectors, changed ones are queued for embedding. */
export async function refreshKnowledge(ctx: Ctx, options: { postsOnly?: boolean } = {}): Promise<{ passages: number; queued: number; removed: number }> {
    const docs = await sourceDocuments(ctx, !!options.postsOnly);
    const want = new Map<string, (typeof docs)[number]>();
    for (const d of docs) want.set(`${d.source}\u0000${await sha256(d.text)}`, d);
    const { results } = await ctx.db
        .prepare(options.postsOnly ? "SELECT id, source, hash FROM knowledge WHERE source LIKE 'post:%'" : 'SELECT id, source, hash FROM knowledge')
        .all<{ id: number; source: string; hash: string }>();
    const have = new Map(results.map(r => [`${r.source}\u0000${r.hash}`, r.id]));
    const stale = results.filter(r => !want.has(`${r.source}\u0000${r.hash}`)).map(r => r.id);
    const add = [...want].filter(([k]) => !have.has(k));
    const t = now();
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < stale.length; i += 90) stmts.push(ctx.db.prepare(`DELETE FROM knowledge WHERE id IN (${stale.slice(i, i + 90).map(() => '?').join(',')})`).bind(...stale.slice(i, i + 90)));
    for (const [key, d] of add) {
        stmts.push(
            ctx.db.prepare('INSERT INTO knowledge (source, title, url, chunk, hash, vector, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?)').bind(d.source, d.title, d.url, d.text, key.split('\u0000')[1], t)
        );
    }
    for (let i = 0; i < stmts.length; i += 80) await ctx.db.batch(stmts.slice(i, i + 80));
    if (stale.length && !add.length) await rebuildIndex(ctx.env, ctx.db);
    if (!options.postsOnly) await setSetting(ctx.db, 'knowledge_refreshed_at', t);
    return { passages: want.size, queued: add.length, removed: stale.length };
}

/** Embeds queued passages until the time budget runs out; rebuilds the index when none are left. */
export async function embedPending(env: Env, db: D1Database, ai: AIProvider | null, budgetMs = 20_000): Promise<number> {
    if (!ai?.embed) return 0;
    const { embeddingModel } = await aiSettings(env, db);
    const deadline = Date.now() + budgetMs;
    let done = 0;
    while (Date.now() < deadline) {
        const { results } = await db.prepare('SELECT id, title, chunk FROM knowledge WHERE vector IS NULL LIMIT ?').bind(BATCH).all<{ id: number; title: string; chunk: string }>();
        if (!results.length) {
            // Related posts start from a rebuild (once on a site embedded before they existed), and a
            // large first pass over them continues here, a slice per cron tick.
            const related = await getSetting<boolean | null>(db, 'related_pending', null);
            if (done || (related === null && (await getSetting(db, 'knowledge_version', null)))) await rebuildIndex(env, db);
            else if (related) await relatePosts(env, db, Math.max(2000, deadline - Date.now()));
            break;
        }
        const texts = results.map(r => `${r.title}\n\n${r.chunk}`);
        const model = embeddingModel ?? undefined;
        let vectors: (number[] | null)[];
        try {
            vectors = (await ai.embed(texts, model)).vectors;
        } catch {
            // One passage the API refuses (a firewall reading a shell command in it as an attack, say) would
            // fail this batch every minute and stall everything behind it: embed one by one instead. A passage
            // refused on its own is set aside (an empty vector: not pending, never searched); anything that
            // might pass later (rate limits, outages) stays pending and ends this run.
            vectors = [];
            for (const t of texts) {
                const one = await ai.embed([t], model).then(
                    r => r.vectors[0],
                    err => (permanent(err) ? null : undefined)
                );
                if (one === undefined) break;
                vectors.push(one);
            }
            if (!vectors.length) break;
        }
        await db.batch(vectors.map((v, i) => db.prepare('UPDATE knowledge SET vector = ? WHERE id = ?').bind(v ? encode(normalize(v)) : new Uint8Array(0), results[i].id)));
        done += vectors.length;
    }
    return done;
}

/** A refusal that asking again won't change: a 4xx other than a timeout or rate limit. */
function permanent(err: unknown): boolean {
    const status = (err as { status?: number } | null)?.status ?? 0;
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function rebuildIndex(env: Env, db: D1Database): Promise<void> {
    const ids: number[] = [];
    const parts: Float32Array[] = [];
    // A post's vector is the mean of its passages': summed here, normalized when saved.
    const posts = new Map<string, Float32Array>();
    for (let offset = 0; ; offset += 400) {
        const { results } = await db
            .prepare('SELECT id, source, vector FROM knowledge WHERE vector IS NOT NULL AND length(vector) > 0 ORDER BY id LIMIT 400 OFFSET ?')
            .bind(offset)
            .all<{ id: number; source: string; vector: string }>();
        for (const r of results) {
            const v = decode(r.vector);
            ids.push(r.id);
            parts.push(v);
            if (!r.source.startsWith('post:')) continue;
            const sum = posts.get(r.source.slice(5));
            if (!sum) posts.set(r.source.slice(5), Float32Array.from(v));
            else if (sum.length === v.length) for (let d = 0; d < v.length; d++) sum[d] += v[d];
        }
        if (results.length < 400) break;
    }
    const dims = parts[0]?.length ?? 0;
    const matrix = new Float32Array(ids.length * dims);
    parts.forEach((v, i) => matrix.set(v, i * dims));
    await env.BUCKET.put(INDEX_KEY, matrix.buffer, { customMetadata: { dims: String(dims), count: String(ids.length) } });
    await env.BUCKET.put(IDS_KEY, JSON.stringify(ids));
    await savePostVectors(env, posts, dims);
    await setSetting(db, 'knowledge_version', now());
    await relatePosts(env, db).catch(err => console.error('related posts failed', err));
}

async function savePostVectors(env: Env, sums: Map<string, Float32Array>, dims: number): Promise<void> {
    const kept = [...sums].filter(([, v]) => v.length === dims && dims > 0);
    const matrix = new Float32Array(kept.length * dims);
    const keys: string[] = [];
    kept.forEach(([, sum], i) => {
        const v = normalize(sum);
        matrix.set(v, i * dims);
        keys.push(fingerprint(v));
    });
    await env.BUCKET.put(POSTS_INDEX_KEY, matrix.buffer);
    await env.BUCKET.put(POSTS_IDS_KEY, JSON.stringify({ dims, ids: kept.map(([id]) => id), keys }));
}

/**
 * Each post's closest posts in meaning (the cosine similarity of their vectors), for "Keep reading".
 * Only posts whose vector changed are compared with every other post, and each joins the lists of
 * the posts it is close to, so publishing one post costs one pass over the posts however large the
 * blog is. A first pass over a large blog stops at the time budget and continues on the next call.
 */
export async function relatePosts(env: Env, db: D1Database, budgetMs = 10_000): Promise<{ updated: number; remaining: number }> {
    const deadline = Date.now() + budgetMs;
    const [bin, meta] = await Promise.all([env.BUCKET.get(POSTS_INDEX_KEY), env.BUCKET.get(POSTS_IDS_KEY)]);
    if (!bin || !meta) return { updated: 0, remaining: 0 };
    const { dims, ids, keys } = await meta.json<{ dims: number; ids: string[]; keys: string[] }>();
    const matrix = new Float32Array(await bin.arrayBuffer());
    const [rows, pages] = await db.batch([db.prepare('SELECT post_id, vector_key, related FROM related_posts'), db.prepare("SELECT id FROM posts WHERE type = 'page'")]);
    const lists = new Map((rows.results as { post_id: string; vector_key: string; related: string }[]).map(r => [r.post_id, { key: r.vector_key, related: JSON.parse(r.related) as [string, number][] }]));
    // Pages are never "read next".
    const skip = new Set((pages.results as { id: string }[]).map(p => p.id));
    const order = ids.map((_, i) => i).filter(i => !skip.has(ids[i]));
    const dirty = order.filter(i => lists.get(ids[i])?.key !== keys[i]);
    const changed = new Set<string>();
    let done = 0;
    for (const i of dirty) {
        if (done && Date.now() > deadline) break;
        const own: [string, number][] = [];
        const a = i * dims;
        for (const j of order) {
            if (j === i) continue;
            const b = j * dims;
            let s = 0;
            for (let d = 0; d < dims; d++) s += matrix[a + d] * matrix[b + d];
            s = Math.round(s * 10_000) / 10_000;
            place(own, ids[j], s);
            const other = lists.get(ids[j]);
            if (other && place(other.related, ids[i], s)) changed.add(ids[j]);
        }
        lists.set(ids[i], { key: keys[i], related: own });
        changed.add(ids[i]);
        done++;
    }
    const known = new Set(ids);
    const gone = [...lists.keys()].filter(id => !known.has(id) || skip.has(id));
    const t = now();
    const stmts = [...changed].map(id =>
        db
            .prepare('INSERT INTO related_posts (post_id, vector_key, related, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(post_id) DO UPDATE SET vector_key = excluded.vector_key, related = excluded.related, updated_at = excluded.updated_at')
            .bind(id, lists.get(id)!.key, JSON.stringify(lists.get(id)!.related), t)
    );
    for (let i = 0; i < gone.length; i += 90) stmts.push(db.prepare(`DELETE FROM related_posts WHERE post_id IN (${gone.slice(i, i + 90).map(() => '?').join(',')})`).bind(...gone.slice(i, i + 90)));
    await batched(db, stmts);
    const remaining = dirty.length - done;
    await setSetting(db, 'related_pending', remaining > 0);
    if (changed.size || gone.length) await setSetting(db, 'related_updated_at', t);
    return { updated: changed.size, remaining };
}

/** True when related posts changed after the last publish started: the site is rebuilt to show them. */
export async function relatedChanged(db: D1Database): Promise<boolean> {
    const [changed, started] = await Promise.all([getSetting<string | null>(db, 'related_updated_at', null), getSetting<string | null>(db, 'site_publish_started_at', null)]);
    return !!changed && (!started || changed > started);
}

/** Puts a post in a closest-first list of at most RELATED, or moves it to its new score. True when the list changed. */
function place(list: [string, number][], id: string, score: number): boolean {
    const at = list.findIndex(x => x[0] === id);
    if (at >= 0) {
        if (list[at][1] === score) return false;
        list.splice(at, 1);
    } else if (list.length >= RELATED && score <= list[list.length - 1][1]) return false;
    let k = list.length;
    while (k > 0 && list[k - 1][1] < score) k--;
    list.splice(k, 0, [id, score]);
    if (list.length > RELATED) list.pop();
    return true;
}

let cached: { version: string; ids: number[]; dims: number; matrix: Float32Array } | null = null;

async function loadIndex(env: Env, db: D1Database) {
    const version = await getSetting<string | null>(db, 'knowledge_version', null);
    if (!version) return null;
    if (cached?.version === version) return cached;
    const [bin, ids] = await Promise.all([env.BUCKET.get(INDEX_KEY), env.BUCKET.get(IDS_KEY)]);
    if (!bin || !ids) return null;
    const dims = Number(bin.customMetadata?.dims ?? 0);
    cached = { version, ids: await ids.json<number[]>(), dims, matrix: new Float32Array(await bin.arrayBuffer()) };
    return cached;
}

/** The passages most related to a query, best first. Empty when nothing is indexed yet. */
export async function retrieve(ctx: Ctx, ai: AIProvider, query: string, k = 6): Promise<Passage[]> {
    if (!ai.embed || !query.trim()) return [];
    const index = await loadIndex(ctx.env, ctx.db);
    if (!index || !index.dims) return [];
    const { embeddingModel } = await aiSettings(ctx.env, ctx.db);
    const [raw] = (await ai.embed([query.slice(0, 4000)], embeddingModel ?? undefined)).vectors;
    const q = normalize(raw);
    if (q.length !== index.dims) return [];
    const scores: { i: number; s: number }[] = [];
    for (let i = 0; i < index.ids.length; i++) {
        let s = 0;
        const off = i * index.dims;
        for (let d = 0; d < index.dims; d++) s += q[d] * index.matrix[off + d];
        scores.push({ i, s });
    }
    scores.sort((a, b) => b.s - a.s);
    // A source contributes at most two passages, so one long document can't crowd out the rest.
    const picked = scores.slice(0, k * 3).map(({ i, s }) => ({ id: index.ids[i], s }));
    const { results } = await ctx.db
        .prepare(`SELECT id, source, title, url, chunk FROM knowledge WHERE id IN (${picked.map(() => '?').join(',')})`)
        .bind(...picked.map(p => p.id))
        .all<{ id: number; source: string; title: string; url: string | null; chunk: string }>();
    const byId = new Map(results.map(r => [r.id, r]));
    const out: Passage[] = [];
    const counts = new Map<string, number>();
    for (const p of picked) {
        const r = byId.get(p.id);
        if (!r) continue;
        const n = counts.get(r.source) ?? 0;
        if (n >= 2) continue;
        counts.set(r.source, n + 1);
        out.push({ id: r.id, source: r.source, title: r.title, url: r.url, text: r.chunk, score: p.s });
        if (out.length >= k) break;
    }
    return out;
}

// ------------------------------------------------------------------ posts to link

let postPassages: { version: string; posts: Map<number, string> } | null = null;

/** The post each indexed post passage comes from, by passage id; kept per index version. */
async function passagePosts(db: D1Database, version: string): Promise<Map<number, string>> {
    if (postPassages?.version === version) return postPassages.posts;
    const { results } = await db.prepare("SELECT id, source FROM knowledge WHERE source LIKE 'post:%'").all<{ id: number; source: string }>();
    postPassages = { version, posts: new Map(results.map(r => [r.id, r.source.slice('post:'.length)])) };
    return postPassages.posts;
}

// The same paragraph is looked up again as the cursor comes back to it: its vector is kept.
const queryVectors = new Map<string, Float32Array>();

/**
 * Published posts nearest in meaning to a piece of writing, best first: one row
 * per post, with its closest passage. `ready` is false until the blog has been
 * read, when there is nothing to compare with yet.
 */
export async function relatedPosts(ctx: Ctx, ai: AIProvider, text: string, opts: { exclude?: string[]; limit?: number } = {}): Promise<{ ready: boolean; posts: { postId: string; score: number; passage: string }[] }> {
    const index = await loadIndex(ctx.env, ctx.db);
    if (!ai.embed || !index?.dims) return { ready: false, posts: [] };
    const query = text.trim().slice(0, 4000);
    if (!query) return { ready: true, posts: [] };
    const { embeddingModel } = await aiSettings(ctx.env, ctx.db);
    const key = `${embeddingModel}\u0000${query}`;
    let q = queryVectors.get(key);
    if (!q) {
        q = normalize((await ai.embed([query], embeddingModel ?? undefined)).vectors[0]);
        if (queryVectors.size >= 200) queryVectors.delete(queryVectors.keys().next().value!);
        queryVectors.set(key, q);
    }
    if (q.length !== index.dims) return { ready: false, posts: [] };
    const posts = await passagePosts(ctx.db, index.version);
    const skip = new Set(opts.exclude ?? []);
    const best = new Map<string, { id: number; s: number }>();
    for (let i = 0; i < index.ids.length; i++) {
        const post = posts.get(index.ids[i]);
        if (!post || skip.has(post)) continue;
        let s = 0;
        const off = i * index.dims;
        for (let d = 0; d < index.dims; d++) s += q[d] * index.matrix[off + d];
        const seen = best.get(post);
        if (!seen || s > seen.s) best.set(post, { id: index.ids[i], s });
    }
    const top = [...best].sort((a, b) => b[1].s - a[1].s).slice(0, opts.limit ?? 6);
    if (!top.length) return { ready: true, posts: [] };
    const { results } = await ctx.db
        .prepare(`SELECT id, chunk FROM knowledge WHERE id IN (${top.map(() => '?').join(',')})`)
        .bind(...top.map(([, b]) => b.id))
        .all<{ id: number; chunk: string }>();
    const chunks = new Map(results.map(r => [r.id, r.chunk]));
    return { ready: true, posts: top.map(([postId, b]) => ({ postId, score: b.s, passage: chunks.get(b.id) ?? '' })) };
}

export interface LinkSuggestion {
    id: string;
    title: string;
    /** The post's address as it stands now (its slug may have changed since it was read). */
    url: string;
    excerpt: string | null;
    publishedAt: string | null;
    /** The part of the post closest to the text. */
    passage: string;
    score: number;
}

/** Posts worth linking from a paragraph: published posts only, never the ones in `exclude` (e.g. the post itself). */
export async function suggestLinks(ctx: Ctx, ai: AIProvider, text: string, exclude: string[], limit = 5): Promise<{ ready: boolean; posts: LinkSuggestion[] }> {
    const found = await relatedPosts(ctx, ai, text, { exclude, limit: limit + 3 });
    if (!found.posts.length) return { ready: found.ready, posts: [] };
    const ids = found.posts.map(p => p.postId);
    const [{ results }, site] = await Promise.all([
        ctx.db
            .prepare(`SELECT id, slug, title, custom_excerpt, published_at FROM posts WHERE status = 'published' AND type = 'post' AND id IN (${ids.map(() => '?').join(',')})`)
            .bind(...ids)
            .all<{ id: string; slug: string; title: string; custom_excerpt: string | null; published_at: string | null }>(),
        siteSettings(ctx.env, ctx.db)
    ]);
    const byId = new Map(results.map(r => [r.id, r]));
    const posts = found.posts.flatMap(p => {
        const r = byId.get(p.postId);
        return r ? [{ id: r.id, title: r.title, url: `${site.url}${r.slug}/`, excerpt: r.custom_excerpt, publishedAt: r.published_at, passage: p.passage, score: p.score }] : [];
    });
    return { ready: true, posts: posts.slice(0, limit) };
}

/** Forgets every vector, e.g. after the embedding model changes; the cron embeds them again. */
export async function resetKnowledge(db: D1Database): Promise<void> {
    await db.prepare('UPDATE knowledge SET vector = NULL').run();
    await setSetting(db, 'knowledge_version', null);
}

export async function knowledgeStats(db: D1Database) {
    const row = await db
        .prepare(`SELECT COUNT(*) AS passages, SUM(vector IS NULL) AS pending, COUNT(DISTINCT source) AS sources FROM knowledge`)
        .first<{ passages: number; pending: number; sources: number }>();
    const refreshed = await getSetting<string | null>(db, 'knowledge_refreshed_at', null);
    return { passages: Number(row?.passages ?? 0), pending: Number(row?.pending ?? 0), sources: Number(row?.sources ?? 0), refreshedAt: refreshed };
}

// ------------------------------------------------------------------ vectors

function normalize(v: number[] | Float32Array): Float32Array {
    let n = 0;
    for (const x of v) n += x * x;
    const len = Math.sqrt(n) || 1;
    return Float32Array.from(v, x => x / len);
}

function encode(v: Float32Array): string {
    const bytes = new Uint8Array(v.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/** A short fingerprint of a vector: a post whose vector keeps it keeps its related posts. */
function fingerprint(v: Float32Array): string {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let a = 0x811c9dc5;
    let b = 0x9747b28c;
    for (let i = 0; i < bytes.length; i++) {
        a = Math.imul(a ^ bytes[i], 0x01000193);
        b = Math.imul(b ^ bytes[i], 0x5bd1e995);
    }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

function decode(b64: string): Float32Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
}
