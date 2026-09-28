/**
 * Loads the sample publication in examples/demo (Acme: posts, a page, authors,
 * tags, covers and site settings) into a running server and publishes it.
 *
 * Posts are Markdown files with a small front matter block; images are uploaded
 * through the admin API like any other upload. Meant for a local or brand-new
 * server: it stops when the server already has posts, unless --force.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Post, Snapshot, StaffRecord, StaffRole, Tag } from '@masthead/core';

export interface SeedOptions {
    /** The server's address including the blog path, e.g. http://localhost:8787/blog/ */
    server: string;
    /** BOOTSTRAP_TOKEN or an admin API key with the owner role. */
    token: string;
    /** The sample folder: site.json, posts/*.md, images/. */
    dir: string;
    /** Load even when the server already has content. */
    force?: boolean;
}

interface DemoSite {
    site: Snapshot['site'] & { logo?: string | null; icon?: string | null; shareImage?: string | null };
    newsletter?: Snapshot['newsletter'];
    /** House style for the AI (Settings, AI) and memory entries every AI answer follows. */
    ai?: { voice?: string };
    memory?: string[];
    authors: { slug: string; name: string; email: string; role: StaffRole; bio?: string }[];
    tags: { slug: string; name: string; description?: string }[];
}

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

/** Stable ids, so the same sample always maps onto the same rows. */
const idFor = (kind: string, slug: string) => createHash('sha1').update(`masthead-demo:${kind}:${slug}`).digest('hex').slice(0, 24);

export async function seed(options: SeedOptions): Promise<void> {
    const server = options.server.replace(/\/?$/, '/');
    const t0 = performance.now();
    const call = async (method: string, path: string, body?: unknown) => {
        const form = body instanceof FormData;
        const res = await fetch(`${server}admin/api${path}`, {
            method,
            headers: { authorization: `Bearer ${options.token}`, ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}) },
            body: body === undefined ? undefined : form ? body : JSON.stringify(body)
        }).catch(err => {
            throw new Error(`Could not reach ${server} (${err?.cause?.code ?? err?.message ?? err}). Is the server running?`);
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
        return JSON.parse(text);
    };

    const stats = await call('GET', '/stats');
    if (stats.posts + stats.pages > 0 && !options.force) {
        throw new Error(`${server} already has ${count(stats.posts, 'post')} and ${count(stats.pages, 'page')}. seed is for an empty server; add --force to load the samples anyway.`);
    }

    const demo = JSON.parse(readFileSync(join(options.dir, 'site.json'), 'utf8')) as DemoSite;
    const files = readdirSync(join(options.dir, 'posts'))
        .filter(f => f.endsWith('.md'))
        .sort();
    const docs = files.map(f => ({ file: f, ...frontMatter(readFileSync(join(options.dir, 'posts', f), 'utf8'), f) }));

    // Images: each file uploads once, like a picture dropped into the editor.
    const uploaded = new Map<string, string>();
    const image = async (name: string | undefined | null): Promise<string | null> => {
        if (!name) return null;
        if (uploaded.has(name)) return uploaded.get(name)!;
        const path = join(options.dir, 'images', name);
        if (!existsSync(path)) throw new Error(`Missing image ${path}`);
        const form = new FormData();
        form.append('file', new File([readFileSync(path)], name, { type: TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream' }));
        const { url } = await call('POST', '/media', form);
        uploaded.set(name, url);
        return url;
    };

    const now = new Date().toISOString();
    const tags: Tag[] = demo.tags.map(t => ({ id: idFor('tag', t.slug), slug: t.slug, name: t.name, description: t.description ?? null, visibility: 'public' }));
    const tagId = (nameOrSlug: string) => {
        const t = tags.find(x => x.slug === nameOrSlug.toLowerCase() || x.name.toLowerCase() === nameOrSlug.toLowerCase());
        if (!t) throw new Error(`Unknown tag "${nameOrSlug}": add it to site.json`);
        return t.id;
    };
    const staff: StaffRecord[] = demo.authors.map(a => ({ id: idFor('author', a.slug), slug: a.slug, name: a.name, email: a.email, role: a.role, status: 'active', bio: a.bio ?? null }));
    const authorId = (slug: string) => {
        const a = staff.find(s => s.slug === slug);
        if (!a) throw new Error(`Unknown author "${slug}": add it to site.json`);
        return a.id;
    };

    const posts: Post[] = [];
    for (const d of docs) {
        const m = d.meta;
        const slug = m.slug ?? d.file.replace(/\.md$/, '');
        const at = when(m.date ?? 'today');
        const sent = Number(m.sent ?? 0);
        posts.push({
            id: idFor('post', slug),
            type: m.type === 'page' ? 'page' : 'post',
            slug,
            title: m.title ?? slug,
            status: 'published',
            bodyFormat: 'markdown',
            markdown: d.body,
            html: null,
            customExcerpt: m.excerpt ?? null,
            featureImage: await image(m.cover),
            featureImageAlt: m.cover_alt ?? null,
            featured: m.featured === 'true',
            publishedAt: at,
            createdAt: at,
            updatedAt: at,
            authors: (m.author ?? demo.authors[0].slug).split(',').map(s => authorId(s.trim())),
            tags: (m.tags ?? '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(tagId),
            newsletter: sent ? { sentAt: at, recipients: sent, delivered: Math.round(sent * 0.994), opened: Number(m.opened ?? 0) } : null
        });
    }

    const site = { ...demo.site, url: server, logo: await image(demo.site.logo), icon: await image(demo.site.icon), shareImage: await image(demo.site.shareImage) };
    const snapshot: Snapshot = { format: 'masthead.snapshot/1', exportedAt: now, source: 'masthead demo', site, posts, authors: staff, tags, staff, newsletter: demo.newsletter };

    const r = await call('POST', '/import/content', snapshot);
    if (demo.ai) await call('PUT', '/settings', { ai: demo.ai });
    const memory = (await call('GET', '/ai/memory')) as { text: string }[];
    for (const text of demo.memory ?? []) if (!memory.some(m => m.text === text)) await call('POST', '/ai/memory', { text });
    const pub = await call('POST', '/publish');
    console.log(`seeded     ${count(r.posts, 'post')}, ${count(r.pages, 'page')}, ${count(r.tags, 'tag')}, ${count(r.staff, 'author')}, ${count(uploaded.size, 'image')}`);
    console.log(`published  ${pub.written} of ${pub.total} files in ${pub.ms} ms`);
    console.log(`\nopen       ${server}\nadmin      ${server}admin/  (sign in with the owner token)`);
    console.log(`\ndone in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "3 days ago", "today" or an ISO date, as an ISO timestamp at 14:00 UTC. */
function when(value: string): string {
    const ago = value.match(/^(\d+)\s+days?\s+ago$/i);
    const d = ago || /^today$/i.test(value) ? new Date() : new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`Not a date: "${value}"`);
    if (ago) d.setUTCDate(d.getUTCDate() - Number(ago[1]));
    d.setUTCHours(14, 0, 0, 0);
    return d.toISOString();
}

/** A leading block of `key: value` lines between --- markers, then the Markdown body. */
function frontMatter(text: string, file: string): { meta: Record<string, string>; body: string } {
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) throw new Error(`${file}: expected front matter between --- lines`);
    const meta: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
        const at = line.indexOf(':');
        if (at < 1) continue;
        meta[line.slice(0, at).trim()] = line
            .slice(at + 1)
            .trim()
            .replace(/^"(.*)"$/, '$1');
    }
    return { meta, body: text.slice(m[0].length).trim() + '\n' };
}
