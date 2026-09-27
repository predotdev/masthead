import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Checks a build against the live site it replaces: every built page must
 * exist live, and title, canonical, share tags and the post body must match.
 * Run it before switching traffic.
 */
export async function compare(opts: { dist?: string; ours?: string; live: string; limit: number }) {
    const pages = (opts.ours ? await sitemapPaths(opts.ours) : await builtPaths(opts.dist!)).slice(0, opts.limit);
    const readOurs = async (path: string) => {
        if (!opts.ours) return readFile(join(opts.dist!, path, 'index.html'), 'utf8');
        const res = await fetch(new URL(path, opts.ours), { headers: { 'user-agent': 'masthead-compare' } });
        if (!res.ok) throw new Error(`ours returned ${res.status}`);
        return res.text();
    };

    const rows: { path: string; issues: string[] }[] = [];
    let bodies = 0;
    let bodiesSame = 0;
    for (const path of pages) {
        let ours: string;
        try {
            ours = await readOurs(path);
        } catch (err) {
            rows.push({ path, issues: [err instanceof Error ? err.message : String(err)] });
            continue;
        }
        const res = await fetch(new URL(path, opts.live), { redirect: 'manual', headers: { 'user-agent': 'masthead-compare' } });
        const issues: string[] = [];
        if (res.status !== 200) {
            issues.push(`live returned ${res.status}`);
            rows.push({ path, issues });
            continue;
        }
        const theirs = await res.text();
        for (const [label, pick] of [
            ['title', (h: string) => tag(h, /<title>([\s\S]*?)<\/title>/i)],
            ['canonical', (h: string) => attr(h, /<link[^>]+rel="canonical"[^>]*>/i, 'href')],
            ['og:title', (h: string) => attr(h, /<meta[^>]+property="og:title"[^>]*>/i, 'content')],
            ['og:image', (h: string) => attr(h, /<meta[^>]+property="og:image"[^>]*>/i, 'content')]
        ] as const) {
            const a = pick(ours);
            const b = pick(theirs);
            if (norm(a) !== norm(b)) issues.push(`${label}: ours "${clip(a)}" vs live "${clip(b)}"`);
        }
        const ourBody = element(ours, /<div class="content">/);
        const liveBody = element(theirs, /<section class="gh-content[^"]*"[^>]*>/) ?? element(theirs, /<div class="(?:gh-)?content[^"]*"[^>]*>/);
        if (ourBody && liveBody) {
            bodies++;
            if (norm(ourBody) === norm(liveBody)) bodiesSame++;
            else if (words(ourBody) === words(liveBody)) issues.push('body: same text, different markup');
            else issues.push('body: text differs');
        }
        rows.push({ path, issues });
    }

    const clean = rows.filter(r => r.issues.length === 0).length;
    for (const r of rows.filter(r => r.issues.length)) console.log(`${r.path}\n  ${r.issues.join('\n  ')}`);
    console.log(`\n${pages.length} pages checked · ${clean} match on every check · post bodies identical: ${bodiesSame}/${bodies}`);
}

async function builtPaths(dist: string): Promise<string[]> {
    return (await walk(dist))
        .filter(f => f.endsWith(`${sep}index.html`) && !f.includes(`${sep}_masthead${sep}`))
        .map(f => `/${relative(dist, f).split(sep).join('/').replace(/index\.html$/, '')}`)
        .sort();
}

/** Every page a running server lists in its sitemaps, as paths. */
async function sitemapPaths(origin: string): Promise<string[]> {
    const base = new URL(origin);
    const index = await (await fetch(new URL('sitemap.xml', base))).text();
    const maps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(new URL(m[1]).pathname, base).toString());
    const paths = new Set<string>([new URL(base).pathname]);
    for (const map of maps) {
        const xml = await (await fetch(map)).text();
        for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) paths.add(new URL(m[1]).pathname);
    }
    return [...paths].sort();
}

async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else out.push(full);
    }
    return out;
}

function tag(html: string, re: RegExp): string {
    return decode(html.match(re)?.[1] ?? '');
}

function attr(html: string, re: RegExp, name: string): string {
    const el = html.match(re)?.[0] ?? '';
    return decode(el.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1] ?? '');
}

/** The inner HTML of the element whose opening tag matches `open`, balancing nested tags of the same name. */
function element(html: string, open: RegExp): string | null {
    const m = open.exec(html);
    if (!m) return null;
    const name = m[0].match(/^<(\w+)/)![1];
    const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
    re.lastIndex = m.index + m[0].length;
    let depth = 1;
    for (let t = re.exec(html); t; t = re.exec(html)) {
        depth += t[1] ? -1 : 1;
        if (depth === 0) return html.slice(m.index + m[0].length, t.index);
    }
    return null;
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
/** Media moves hosts on import (Ghost's storage -> the blog's own content path), so compare paths, not hosts. */
const media = (s: string) => s.replace(/[^"'\s(),]*\/content\/(images|media|files)\//g, '/content/$1/');
const norm = (s: string | null) => media(s ?? '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
const words = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const clip = (s: string) => (s.length > 70 ? `${s.slice(0, 67)}...` : s);
