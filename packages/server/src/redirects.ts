import type { Ctx, Env } from './env';
import { basePath } from './publish';
import { HttpError, csvEscape, newId, now, parseCsv } from './util';

export type RedirectStatus = 301 | 302 | 307 | 308;

export interface Redirect {
    id: string;
    /** Where it applies, inside the blog: "/old-post/" (exact) or a pattern like "^/topic/(.*)$" (regex). */
    from: string;
    /** Where it goes: a blog address ("/blog/new-post/") or a full https address. */
    to: string;
    status: RedirectStatus;
    kind: 'path' | 'regex';
    hits: number;
    lastHitAt: string | null;
    note: string | null;
    createdAt: string;
}

export interface RedirectInput {
    from: string;
    to: string;
    status?: number;
    note?: string | null;
}

const STATUSES: RedirectStatus[] = [301, 302, 307, 308];
export const MAX_REGEX_RULES = 200;
const MAX_LENGTH = 300;
/** Characters that make a "from" a pattern rather than a path. */
const REGEX_CHARS = /[()[\]*+?^$|\\{}]/;

const row = (r: any): Redirect => ({ id: r.id, from: r.from_path, to: r.to_url, status: r.status, kind: r.kind, hits: r.hits, lastHitAt: r.last_hit_at, note: r.note, createdAt: r.created_at });

// ------------------------------------------------------------------ normalizing

/** The blog's own address prefix ("/blog/"), whatever host the request came in on. */
export const canonicalBase = (env: Env) => basePath(env);

/** "/Old-Post/" -> "/old-post": lower case, no trailing slash (the root stays "/"). */
function pathKey(path: string): string {
    const p = path.toLowerCase().replace(/\/{2,}/g, '/');
    return p.length > 1 ? p.replace(/\/+$/, '') : p || '/';
}

/** Turns what someone typed into the stored "from": inside the blog, with a leading slash. */
export function normalizeFrom(raw: string, base: string): { from: string; kind: 'path' | 'regex' } {
    let from = String(raw ?? '').trim();
    if (!from) throw new HttpError(400, 'Say which address to redirect from.');
    if (from.length > MAX_LENGTH) throw new HttpError(400, 'That address is too long.');
    if (/^https?:\/\//i.test(from)) {
        try {
            const u = new URL(from);
            from = u.pathname + u.search;
        } catch {
            throw new HttpError(400, 'That address is not valid.');
        }
    }
    const regex = REGEX_CHARS.test(from.replace(/^\^\/?/, '/').replace(/\$$/, ''));
    if (regex) {
        // A pattern is written against the address inside the blog; a leading blog prefix is dropped.
        let pattern = from.replace(/^\^/, '');
        if (pattern.startsWith(base)) pattern = pattern.slice(base.length - 1);
        if (!pattern.startsWith('/')) pattern = `/${pattern}`;
        compile(`^${pattern.replace(/\$$/, '')}$`);
        return { from: `^${pattern.replace(/\$$/, '')}$`, kind: 'regex' };
    }
    if (from.includes('?') || from.includes('#')) throw new HttpError(400, 'Match the path only; query strings are kept as they are.');
    if (!from.startsWith('/')) from = `/${from}`;
    if (from.startsWith(base)) from = from.slice(base.length - 1);
    if (!from.startsWith('/')) from = `/${from}`;
    const key = pathKey(from);
    if (key === '/') throw new HttpError(400, 'The front page cannot be redirected.');
    return { from: key, kind: 'path' };
}

/** A destination: a full https address, or an address inside the blog (stored with the blog's prefix). */
export function normalizeTo(raw: string, base: string): string {
    const to = String(raw ?? '').trim();
    if (!to) throw new HttpError(400, 'Say where it should go.');
    if (to.length > 2000) throw new HttpError(400, 'That destination is too long.');
    if (/^[a-z][a-z0-9+.-]*:/i.test(to)) {
        let u: URL;
        try {
            u = new URL(to);
        } catch {
            throw new HttpError(400, 'That destination is not a valid address.');
        }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'Destinations are web addresses (https://...) or addresses inside the blog.');
        return u.toString();
    }
    if (to.startsWith('//') || to.includes('\\')) throw new HttpError(400, 'That destination is not valid.');
    const path = to.startsWith('/') ? to : `/${to}`;
    return path.startsWith(base) ? path : `${base}${path.slice(1)}`;
}

function compile(source: string): RegExp {
    if (source.length > MAX_LENGTH) throw new HttpError(400, 'That pattern is too long.');
    // Nested repetition like (a+)+ can take minutes to fail on a long address.
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(source)) throw new HttpError(400, 'That pattern repeats a repeat, which can hang the site. Simplify it.');
    try {
        return new RegExp(source, 'i');
    } catch (err: any) {
        throw new HttpError(400, `That pattern is not valid: ${String(err?.message ?? err).slice(0, 120)}`);
    }
}

// ------------------------------------------------------------------ resolving

/** Where a request goes, given the rules. Pure; the caller counts the hit. */
export function resolveRedirect(rules: Pick<Redirect, 'id' | 'from' | 'to' | 'status' | 'kind'>[], relative: string, search: string, base: string, activeBase: string): { id: string; status: RedirectStatus; location: string } | null {
    const key = pathKey(relative);
    const withSlash = relative.endsWith('/') ? relative : `${relative}/`;
    const exact = rules.find(r => r.kind === 'path' && r.from === key);
    let hit: { rule: (typeof rules)[number]; groups: string[] } | null = exact ? { rule: exact, groups: [] } : null;
    if (!hit) {
        for (const rule of rules) {
            if (rule.kind !== 'regex') continue;
            let m: RegExpMatchArray | null = null;
            try {
                // Without the trailing slash first, so (.*) captures "ai" rather than "ai/"; a pattern that ends in /$ matches the other form.
                const re = new RegExp(rule.from, 'i');
                m = key.match(re) ?? withSlash.match(re) ?? relative.match(re);
            } catch {
                continue;
            }
            if (m) {
                hit = { rule, groups: [...m] };
                break;
            }
        }
    }
    if (!hit) return null;
    let to = hit.rule.to;
    if (hit.groups.length) to = to.replace(/\$(\d)/g, (_, n) => hit!.groups[Number(n)] ?? '');
    if (!/^https?:\/\//i.test(to)) to = to.replace(/\/{2,}/g, '/');
    // A captured group must never turn a blog address into another site.
    if (!/^https?:\/\//i.test(to) && (to.startsWith('//') || to.includes('\\'))) return null;
    // Rules are stored against the canonical prefix; a preview address answers under its own.
    if (to.startsWith(base) && activeBase !== base) to = activeBase + to.slice(base.length);
    if (search && !to.includes('?')) to += search;
    return { id: hit.rule.id, status: hit.rule.status, location: to };
}

/** Follows the rules from `from` through the blog's own addresses; true when it would loop or run past five hops. */
export function loops(rules: Pick<Redirect, 'id' | 'from' | 'to' | 'status' | 'kind'>[], start: string, base: string): boolean {
    let at = start;
    const seen = new Set<string>();
    for (let hop = 0; hop < 6; hop++) {
        const hit = resolveRedirect(rules, at, '', base, base);
        if (!hit) return false;
        if (!hit.location.startsWith(base)) return false;
        at = `/${hit.location.slice(base.length)}`;
        const k = pathKey(at);
        if (seen.has(k)) return true;
        seen.add(k);
    }
    return true;
}

// ------------------------------------------------------------------ storage

let cache: { at: number; rules: Redirect[] } | null = null;
const CACHE_MS = 60_000;

export const bustRedirects = () => {
    cache = null;
};

export async function listRedirects(db: D1Database): Promise<Redirect[]> {
    const { results } = await db.prepare('SELECT * FROM redirects ORDER BY created_at DESC, from_path').all<any>();
    return results.map(row);
}

/** The rules, kept in memory for a minute per isolate; a write clears this isolate's copy at once. */
async function rules(db: D1Database): Promise<Redirect[]> {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.rules;
    // Exact paths first, then patterns, oldest patterns first so their order is stable.
    const { results } = await db.prepare(`SELECT * FROM redirects ORDER BY CASE kind WHEN 'path' THEN 0 ELSE 1 END, created_at`).all<any>();
    cache = { at: Date.now(), rules: results.map(row) };
    return cache.rules;
}

async function checkNoLoop(db: D1Database, base: string, candidate: Redirect, replacing?: string) {
    const all = (await listRedirects(db)).filter(r => r.id !== replacing);
    const test = [...all, candidate];
    if (candidate.kind === 'path') {
        if (candidate.to.startsWith(base) && pathKey(`/${candidate.to.slice(base.length)}`) === candidate.from) throw new HttpError(400, 'That redirects an address to itself.');
        if (loops(test, candidate.from, base)) throw new HttpError(400, 'That would loop, or chain more than five redirects.');
    }
    // Any exact rule that leads into this one must still end within five hops.
    for (const r of test) if (r.kind === 'path' && loops(test, r.from, base)) throw new HttpError(400, `That would make ${r.from} loop, or chain more than five redirects.`);
}

export async function saveRedirect(db: D1Database, env: Env, input: RedirectInput, by: string | null, id?: string): Promise<Redirect> {
    const base = canonicalBase(env);
    const { from, kind } = normalizeFrom(input.from, base);
    const to = normalizeTo(input.to, base);
    const status = input.status === undefined || input.status === null ? 301 : Number(input.status);
    if (!STATUSES.includes(status as RedirectStatus)) throw new HttpError(400, 'The status is 301, 302, 307 or 308.');
    if (kind === 'regex') {
        const { results } = await db.prepare(`SELECT id FROM redirects WHERE kind = 'regex'`).all<{ id: string }>();
        if (results.filter(r => r.id !== id).length >= MAX_REGEX_RULES) throw new HttpError(400, `At most ${MAX_REGEX_RULES} pattern redirects.`);
    }
    const clash = await db.prepare('SELECT id FROM redirects WHERE from_path = ? AND id != ?').bind(from, id ?? '').first();
    if (clash) throw new HttpError(409, 'That address already has a redirect.');
    const note = input.note ? String(input.note).slice(0, 200) : null;
    const candidate: Redirect = { id: id ?? newId(), from, to, status: status as RedirectStatus, kind, hits: 0, lastHitAt: null, note, createdAt: now() };
    await checkNoLoop(db, base, candidate, id);
    if (id) {
        const res = await db.prepare('UPDATE redirects SET from_path = ?, to_url = ?, status = ?, kind = ?, note = ? WHERE id = ?').bind(from, to, status, kind, note, id).run();
        if (!res.meta.changes) throw new HttpError(404, 'Redirect not found.');
    } else {
        await db.prepare('INSERT INTO redirects (id, from_path, to_url, status, kind, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(candidate.id, from, to, status, kind, note, by, candidate.createdAt).run();
    }
    bustRedirects();
    const saved = await db.prepare('SELECT * FROM redirects WHERE id = ?').bind(candidate.id).first<any>();
    return row(saved);
}

export async function deleteRedirect(db: D1Database, id: string): Promise<void> {
    await db.prepare('DELETE FROM redirects WHERE id = ?').bind(id).run();
    bustRedirects();
}

/** What a URL would do, for the admin's test box. */
export async function testRedirect(ctx: Ctx, url: string): Promise<{ to: string; status: number; via: string } | null> {
    const base = canonicalBase(ctx.env);
    let path = String(url ?? '').trim();
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
    const q = path.indexOf('?');
    const search = q >= 0 ? path.slice(q) : '';
    if (q >= 0) path = path.slice(0, q);
    if (!path.startsWith('/')) path = `/${path}`;
    if (path.startsWith(base)) path = path.slice(base.length - 1);
    const hit = resolveRedirect(await rules(ctx.db), path, search, base, base);
    if (!hit) return null;
    return { to: hit.location, status: hit.status, via: hit.id };
}

/**
 * The redirect for a request nothing else answered, or null. Counts the hit after the response.
 * `path` is the decoded request path, as the site sees it.
 */
export async function redirectFor(ctx: Ctx, path: string): Promise<{ status: RedirectStatus; location: string } | null> {
    const base = canonicalBase(ctx.env);
    const active = ctx.basePath;
    if (!path.startsWith(active)) return null;
    const relative = path.slice(active.length - 1);
    const list = await rules(ctx.db);
    if (!list.length) return null;
    const hit = resolveRedirect(list, relative, ctx.url.search, base, active);
    if (!hit) return null;
    ctx.exec.waitUntil(
        ctx.db
            .prepare('UPDATE redirects SET hits = hits + 1, last_hit_at = ? WHERE id = ?')
            .bind(now(), hit.id)
            .run()
            .catch(() => {})
    );
    return { status: hit.status, location: hit.location };
}

// ------------------------------------------------------------------ slugs

/** A published address moved: send the old one to the new one, and drop any redirect from the new one. */
export async function redirectMovedAddress(db: D1Database, env: Env, oldPath: string, newPath: string, by: string | null): Promise<void> {
    const base = canonicalBase(env);
    const from = pathKey(oldPath);
    const to = `${base}${newPath.replace(/^\/+/, '')}`;
    if (from === pathKey(newPath)) return;
    // A redirect from the address that now exists would shadow nothing (real pages win) but is stale.
    await db.prepare('DELETE FROM redirects WHERE from_path = ?').bind(pathKey(newPath)).run();
    const clash = await db.prepare('SELECT id FROM redirects WHERE from_path = ?').bind(from).first();
    if (!clash) await db.prepare('INSERT INTO redirects (id, from_path, to_url, status, kind, note, created_by, created_at) VALUES (?, ?, ?, 301, \'path\', ?, ?, ?)').bind(newId(), from, to, 'Address changed', by, now()).run();
    // Earlier redirects that pointed at the old address now point straight at the new one.
    await db.prepare('UPDATE redirects SET to_url = ? WHERE to_url = ?').bind(to, `${base}${oldPath.replace(/^\/+/, '')}`).run();
    bustRedirects();
}

// ------------------------------------------------------------------ import and export

export interface Imported {
    added: number;
    skipped: { from: string; reason: string }[];
}

/** Ghost's redirects.json: [{ "from": "/old/", "to": "/new/", "permanent": true }], every "from" a regular expression. */
export function parseImport(text: string): RedirectInput[] {
    const t = text.trim();
    if (!t) throw new HttpError(400, 'Nothing to import.');
    if (t.startsWith('[') || t.startsWith('{')) {
        let data: any;
        try {
            data = JSON.parse(t);
        } catch {
            throw new HttpError(400, 'That is not valid JSON.');
        }
        const list = Array.isArray(data) ? data : Array.isArray(data.redirects) ? data.redirects : null;
        if (!list) throw new HttpError(400, 'Expected a list of { from, to, permanent }.');
        return list.map((r: any) => ({ from: String(r.from ?? ''), to: String(r.to ?? ''), status: r.status ?? (r.permanent === false ? 302 : 301), note: r.note ?? null }));
    }
    const rows = parseCsv(t).filter(r => r.some(c => c.trim()));
    const start = /^from$/i.test((rows[0]?.[0] ?? '').trim()) ? 1 : 0;
    return rows.slice(start).map(r => ({ from: r[0] ?? '', to: r[1] ?? '', status: r[2] ? Number(r[2]) : 301, note: r[3] ?? null }));
}

export async function importRedirects(db: D1Database, env: Env, items: RedirectInput[], by: string | null): Promise<Imported> {
    const out: Imported = { added: 0, skipped: [] };
    if (items.length > 2000) throw new HttpError(400, 'At most 2,000 redirects at a time.');
    for (const item of items) {
        try {
            await saveRedirect(db, env, item, by);
            out.added++;
        } catch (err: any) {
            out.skipped.push({ from: String(item.from).slice(0, 80), reason: err instanceof HttpError ? err.message : 'Could not save.' });
        }
    }
    return out;
}

/** Ghost-compatible: { from, to, permanent }, with the blog prefix left off, so the file moves back to Ghost. */
export async function exportRedirects(db: D1Database, env: Env, format: 'json' | 'csv') {
    const base = canonicalBase(env);
    const list = (await listRedirects(db)).reverse();
    const rel = (to: string) => (to.startsWith(base) ? `/${to.slice(base.length)}` : to);
    if (format === 'csv') return ['from,to,status,note', ...list.map(r => [r.from, rel(r.to), r.status, r.note ?? ''].map(x => csvEscape(String(x))).join(','))].join('\n') + '\n';
    return JSON.stringify(list.map(r => ({ from: r.from, to: rel(r.to), permanent: r.status === 301 || r.status === 308 })), null, 2) + '\n';
}
