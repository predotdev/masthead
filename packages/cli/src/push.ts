/**
 * Loads a snapshot (and optionally an audience export) into a running
 * Masthead server: content, staff, media, members and their history, then
 * publishes. Every step is idempotent, so a failed run can simply be re-run.
 */
import type { AudienceExport, MemberRecord, Snapshot } from '@masthead/core';

export interface PushOptions {
    /** The server's public address including the blog path, e.g. https://blog.example.workers.dev/blog/ */
    server: string;
    /** The server's BOOTSTRAP_TOKEN: imports need the owner. */
    token: string;
    snapshot?: Snapshot;
    audience?: AudienceExport;
    /** Copy images and files onto the server and point content at them. */
    media?: boolean;
}

const MEDIA_URL = /https?:\/\/[^\s"'<>()\\]+?\/content\/(?:images|media|files)\/[^\s"'<>()\\]+/g;

export async function push(options: PushOptions): Promise<void> {
    const server = options.server.endsWith('/') ? options.server : `${options.server}/`;
    const base = new URL(server).pathname;
    const call = client(server, options.token);
    const t0 = performance.now();

    if (options.snapshot) {
        const snap = options.snapshot;
        const r = await call('POST', '/import/content', snap);
        console.log(`content    ${r.posts} posts, ${r.pages} pages, ${r.tags} tags, ${r.staff} staff`);

        if (options.media) {
            const found = collectMedia(snap);
            console.log(`media      ${found.files.length} files referenced`);
            const failed = await copyMedia(call, found.files);
            // Resized copies of cover and share images, for srcset. Optional: the server falls back to the original.
            const variants = sizeVariants(snap, found.files);
            if (variants.length) {
                const missing = await copyMedia(call, variants, 'variants');
                if (missing.length) console.log(`variants   ${missing.length} not available; those images are served at full size`);
            }
            if (failed.length) {
                console.log(`media      ${failed.length} files could not be copied; content still points at the old host:`);
                for (const f of failed.slice(0, 20)) console.log(`           ${f.url}  ${f.error}`);
            } else {
                for (const prefix of found.prefixes) {
                    const { changed } = await call('POST', '/import/rewrite', { from: prefix, to: `${base}content/` });
                    console.log(`rewrite    ${prefix} -> ${base}content/  (${changed} rows)`);
                }
            }
        }
    }

    if (options.audience) {
        const members = mergeDuplicates(options.audience.members);
        const { events } = options.audience;
        let upserted = 0;
        await inChunks(members, 1000, 2, async chunk => {
            const r = await call('POST', '/import/members', { members: chunk, events: [] });
            upserted += r.upserted;
            progress('members', upserted, members.length);
        });
        progressDone();
        let sent = 0;
        await inChunks(events, 2000, 2, async chunk => {
            await call('POST', '/import/members', { members: [], events: chunk });
            sent += chunk.length;
            progress('history', sent, events.length);
        });
        progressDone();
        console.log(`members    ${upserted} members, ${events.length} history events`);
    }

    const pub = await call('POST', '/publish');
    console.log(`publish    ${pub.written} of ${pub.total} files written in ${pub.ms} ms`);

    const stats = await call('GET', '/stats');
    console.log(`\nserver now has`);
    console.log(`  posts     ${stats.posts} (${stats.published} published, ${stats.drafts} drafts), pages ${stats.pages}`);
    console.log(`  tags ${stats.tags}, staff ${stats.staff}, media ${stats.media}, site files ${stats.site_files}`);
    const m = stats.members;
    console.log(`  members   ${m.total} (${m.subscribed} subscribed, ${m.unsubscribed} unsubscribed, ${m.pending} pending, ${m.suppressed} suppressed), history ${stats.member_events}`);
    if (options.snapshot) {
        const want = { posts: options.snapshot.posts.filter(p => p.type === 'post').length, pages: options.snapshot.posts.filter(p => p.type === 'page').length, tags: options.snapshot.tags.length };
        const ok = stats.posts >= want.posts && stats.pages >= want.pages && stats.tags >= want.tags;
        console.log(`  ${ok ? 'matches' : 'DOES NOT MATCH'} the snapshot (${want.posts} posts, ${want.pages} pages, ${want.tags} tags)`);
    }
    if (options.audience) {
        const unique = mergeDuplicates(options.audience.members).length;
        console.log(`  ${m.total >= unique ? 'matches' : 'DOES NOT MATCH'} the audience export (${unique} unique addresses)`);
    }
    console.log(`\ndone in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

type Call = (method: string, path: string, body?: unknown) => Promise<any>;

function client(server: string, token: string): Call {
    return async (method, path, body) => {
        for (let attempt = 0; ; attempt++) {
            const res = await fetch(`${server}admin/api${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, 'x-masthead': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body)
            }).catch(err => ({ ok: false, status: 0, statusText: String(err), json: async () => ({}), text: async () => String(err) }) as unknown as Response);
            if (res.ok) return res.json();
            const retry = res.status === 0 || res.status === 429 || res.status >= 500;
            const detail = await res.text().catch(() => '');
            if (!retry || attempt >= 4) throw new Error(`${method} ${path}: HTTP ${res.status} ${detail.slice(0, 300)}`);
            await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        }
    };
}

/** Every media file the content references, keyed by its path under content/. */
export function collectMedia(snap: Snapshot): { files: { url: string; path: string }[]; prefixes: string[] } {
    const byPath = new Map<string, string>();
    const prefixes = new Set<string>();
    const scan = (v: unknown): void => {
        if (typeof v === 'string') {
            for (const match of v.matchAll(MEDIA_URL)) {
                const url = match[0].replace(/[.,;:]+$/, '').replace(/&amp;/g, '&');
                const at = url.indexOf('/content/');
                prefixes.add(url.slice(0, at + '/content/'.length));
                let path = url.slice(at + 1).split(/[?#]/)[0];
                try {
                    path = decodeURIComponent(path);
                } catch {}
                if (!byPath.has(path)) byPath.set(path, url.split('#')[0]);
            }
        } else if (Array.isArray(v)) v.forEach(scan);
        else if (v && typeof v === 'object') Object.values(v).forEach(scan);
    };
    scan(snap.posts);
    scan(snap.site);
    scan(snap.staff ?? snap.authors);
    scan(snap.tags);
    return { files: [...byPath].map(([path, url]) => ({ url, path })), prefixes: [...prefixes] };
}

/** Ghost serves resized copies at content/images/size/wN/...; these widths are the ones themes use. */
const VARIANT_WIDTHS = [600, 1000, 2000];

function sizeVariants(snap: Snapshot, files: { url: string; path: string }[]): { url: string; path: string }[] {
    const covers = new Set<string>();
    for (const p of snap.posts) for (const u of [p.featureImage, p.ogImage, p.twitterImage]) if (u) covers.add(u.split(/[?#]/)[0]);
    const out: { url: string; path: string }[] = [];
    for (const f of files) {
        if (!covers.has(f.url) || !f.path.startsWith('content/images/') || f.path.startsWith('content/images/size/') || /\.(gif|svg)$/i.test(f.path)) continue;
        const rest = f.path.slice('content/images/'.length);
        const at = f.url.indexOf('/content/images/');
        for (const w of VARIANT_WIDTHS) out.push({ url: `${f.url.slice(0, at)}/content/images/size/w${w}/${f.url.slice(at + '/content/images/'.length)}`, path: `content/images/size/w${w}/${rest}` });
    }
    return out;
}

async function copyMedia(call: Call, files: { url: string; path: string }[], label = 'media') {
    let pending = files;
    let failed: { url: string; path: string; error: string }[] = [];
    let copied = 0;
    let bytes = 0;
    for (let round = 0; round < 3 && pending.length; round++) {
        failed = [];
        await inChunks(pending, 20, 3, async chunk => {
            const { results } = await call('POST', '/import/media', { items: chunk });
            for (const r of results as { path: string; ok: boolean; size?: number; error?: string }[]) {
                if (r.ok) {
                    copied++;
                    bytes += r.size ?? 0;
                } else failed.push({ ...chunk.find(c => c.path === r.path)!, error: r.error ?? 'failed' });
            }
            progress(label, copied, files.length);
        });
        pending = failed.map(({ url, path }) => ({ url, path }));
    }
    progressDone();
    console.log(`${label.padEnd(10)} ${copied} copied (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    return failed;
}

/** One record per address. Where copies disagree, the opt-out and any suppression win. */
export function mergeDuplicates(members: MemberRecord[]): MemberRecord[] {
    const byEmail = new Map<string, MemberRecord>();
    for (const m of members) {
        const key = m.email.toLowerCase();
        const seen = byEmail.get(key);
        if (!seen) {
            byEmail.set(key, m);
            continue;
        }
        byEmail.set(key, {
            ...seen,
            status: seen.status === 'unsubscribed' || m.status === 'unsubscribed' ? 'unsubscribed' : seen.status === 'subscribed' || m.status === 'subscribed' ? 'subscribed' : 'pending',
            suppressed: seen.suppressed ?? m.suppressed ?? null,
            labels: [...new Set([...seen.labels, ...m.labels])],
            flags: [...new Set([...(seen.flags ?? []), ...(m.flags ?? [])])],
            createdAt: seen.createdAt < m.createdAt ? seen.createdAt : m.createdAt,
            emailCount: Math.max(seen.emailCount ?? 0, m.emailCount ?? 0),
            openedCount: Math.max(seen.openedCount ?? 0, m.openedCount ?? 0)
        });
    }
    return [...byEmail.values()];
}

async function inChunks<T>(items: T[], size: number, parallel: number, fn: (chunk: T[]) => Promise<void>) {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    await Promise.all(
        Array.from({ length: parallel }, async () => {
            for (let c = chunks.shift(); c; c = chunks.shift()) await fn(c);
        })
    );
}

function progress(label: string, done: number, total: number) {
    if (process.stdout.isTTY) process.stdout.write(`\r${label.padEnd(10)} ${done}/${total}`);
}
function progressDone() {
    if (process.stdout.isTTY) process.stdout.write('\n');
}
