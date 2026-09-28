/**
 * What the idea refresh reads: the AI knowledge sources and the idea sources
 * from Settings, turned into items and compared with what each held at the
 * last read, so ideas come from what is new.
 *
 * Changelogs ({changelog: [{date, items}]}), JSON feeds, RSS and Atom are
 * dated entries: an entry not seen before is new if it is from the last two
 * weeks. Documents (llms.txt, docs) and web pages are paragraphs and list
 * items under their headings: once a source has been read, a paragraph that
 * was added, or rewritten beyond a light edit, is new. Each source's last read
 * is kept in R2 and replaced only after a refresh succeeds.
 */
import type { Signal } from '@masthead/core';
import { plainText, shortHash } from '@masthead/render';
import type { Env } from './env';

export interface SourceItem {
    /** Stable within its source: an entry's date and title, or a paragraph's text. */
    key: string;
    /** The entry's title, or the heading a paragraph sits under. */
    title: string;
    text: string;
    /** Dated entries only. */
    at?: string;
    kind: string;
    url: string;
}

/** An item as kept between reads. `seen` is when it first appeared, null for what was there at the first read. */
interface Kept {
    key: string;
    title: string;
    text: string;
    at?: string;
    seen: string | null;
}

export interface SourceRead {
    url: string;
    items: SourceItem[];
    /** New since the last read. */
    fresh: SourceItem[];
    /** From the last two weeks, new or not: what a refresh someone asks for falls back on. */
    recent: SourceItem[];
    /** A document's or page's text, for background. Empty for feeds. */
    text: string;
    error?: string;
    /** Keeps this read as the one the next compares with. */
    save(): Promise<void>;
}

const WINDOW_DAYS = 14;
/** Paragraphs shorter than this are labels, dates and counters, not news. */
const MIN_WORDS = 8;
/** Word overlap above which a changed paragraph or entry is a light edit of one that went away. */
const LIGHT_EDIT = 0.8;
const KEPT_TEXT = 240;

/** Reads every source at once; one that fails keeps its last read and reports the error. */
export async function readSources(env: Env, urls: string[], at = new Date()): Promise<SourceRead[]> {
    return Promise.all(urls.map(url => readSource(env, url, at)));
}

async function readSource(env: Env, url: string, at: Date): Promise<SourceRead> {
    const stateKey = `ai/ideas/${shortHash(url)}${url.length.toString(36)}.json`;
    const failed = (error: string): SourceRead => ({ url, items: [], fresh: [], recent: [], text: '', error, save: async () => {} });
    let parsed: { items: SourceItem[]; text: string };
    try {
        const res = await fetch(url, { headers: { 'user-agent': 'masthead-ideas', accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
        if (!res.ok) return failed(`HTTP ${res.status}`);
        parsed = parseSource(url, (await res.text()).slice(0, 3_000_000), res.headers.get('content-type') ?? '');
    } catch (err) {
        return failed(err instanceof Error ? err.message : String(err));
    }
    const prev = await env.BUCKET.get(stateKey)
        .then(o => (o ? (o.json() as Promise<{ readAt?: string; items: Kept[] }>) : null))
        .catch(() => null);
    // A source that suddenly lost most of its entries (an error page, a truncated file) must not become the
    // baseline, or everything would look new once it recovers. A drop that lasts three days is real.
    if (!parsed.items.length) return failed('No entries found');
    const dropped = !!prev && prev.items.length >= 20 && parsed.items.length < prev.items.length * 0.3;
    if (dropped && Date.parse(prev!.readAt ?? '') > at.getTime() - 3 * 86400_000) return failed(`Only ${parsed.items.length} entries, down from ${prev!.items.length}; kept the last read`);
    const nowIso = at.toISOString();
    const { fresh, recent, keep } = compare(prev?.items ?? null, parsed.items, nowIso);
    return {
        url,
        items: parsed.items,
        fresh,
        recent,
        text: parsed.text,
        save: async () => {
            await env.BUCKET.put(stateKey, JSON.stringify({ url, readAt: nowIso, items: keep }), { httpMetadata: { contentType: 'application/json' } });
        }
    };
}

/** What is new in `items` compared with the last read (`prev`, null on the first). */
export function compare(prev: Kept[] | null, items: SourceItem[], nowIso: string): { fresh: SourceItem[]; recent: SourceItem[]; keep: Kept[] } {
    const before = new Map((prev ?? []).map(k => [k.key, k]));
    const current = new Set(items.map(i => i.key));
    const gone = (prev ?? []).filter(k => !current.has(k.key)).map(k => words(`${k.title} ${k.text}`));
    const since = Date.parse(nowIso) - WINDOW_DAYS * 86400_000;
    const fresh: SourceItem[] = [];
    const recent: SourceItem[] = [];
    const keep: Kept[] = [];
    for (const item of items) {
        const old = before.get(item.key);
        const seen = old ? old.seen : prev ? nowIso : null;
        keep.push({ key: item.key, title: item.title.slice(0, 200), text: item.text.slice(0, KEPT_TEXT), at: item.at, seen });
        const inWindow = item.at ? Date.parse(item.at) >= since : !!seen && Date.parse(seen) >= since;
        if (inWindow) recent.push(item);
        if (old || !inWindow) continue;
        // Paragraphs count only against an earlier read, and only when they say something.
        if (!item.at && (!prev || item.text.split(' ').length < MIN_WORDS)) continue;
        const w = words(`${item.title} ${item.text.slice(0, KEPT_TEXT)}`);
        if (gone.some(g => overlap(w, g) >= LIGHT_EDIT)) continue;
        fresh.push(item);
    }
    return { fresh, recent, keep };
}

/**
 * Items as signals for the idea prompt: one per dated entry, and one per
 * heading for paragraphs, so a new section reads as one piece of news.
 */
export function toSignals(reads: SourceRead[], which: 'fresh' | 'recent', nowIso = new Date().toISOString()): Signal[] {
    const out: Signal[] = [];
    for (const r of reads) {
        const source = label(r.url);
        const sections = new Map<string, SourceItem[]>();
        for (const item of r[which]) {
            if (item.at) out.push({ ref: `${source}:${item.key}`, source, kind: item.kind, title: item.title, summary: item.text, at: item.at, url: item.url });
            else sections.set(item.title, [...(sections.get(item.title) ?? []), item]);
        }
        for (const [title, items] of sections) {
            out.push({ ref: `${source}#${shortHash(title)}`, source, kind: items[0].kind, title, summary: items.map(i => i.text).join(' ').slice(0, 800), at: nowIso, url: r.url });
        }
    }
    return out;
}

/** "example.com/changelog.json" */
export function label(url: string): string {
    try {
        const u = new URL(url);
        return `${u.host.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}`;
    } catch {
        return url;
    }
}

// ------------------------------------------------------------------ parsing

export function parseSource(url: string, body: string, contentType: string): { items: SourceItem[]; text: string } {
    const type = contentType.toLowerCase();
    const head = body.trimStart().slice(0, 100).toLowerCase();
    if (type.includes('json') || head.startsWith('{') || head.startsWith('[')) {
        try {
            const items = jsonItems(JSON.parse(body), url);
            if (items) return { items, text: '' };
        } catch {
            // Not JSON after all: read it as text.
        }
    }
    if (/rss|atom|xml/.test(type) || /^<\?xml|^<rss|^<feed/.test(head)) {
        const items = feedItems(body, url);
        if (items.length) return { items, text: '' };
    }
    const isHtml = type.includes('html') || /^<!doctype html|^<html/.test(head);
    const text = isHtml ? htmlText(body) : body;
    return { items: paragraphs(text, url, isHtml ? 'page' : 'doc'), text };
}

function jsonItems(data: any, url: string): SourceItem[] | null {
    if (Array.isArray(data?.changelog)) {
        return data.changelog.flatMap((day: any) =>
            (Array.isArray(day?.items) ? day.items : []).filter((i: any) => i?.title).map((i: any) => entry(url, i.title, i.description ?? i.summary ?? '', day.date, i.type ?? 'update', i.url ?? day.url))
        );
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.entries) ? data.entries : Array.isArray(data?.posts) ? data.posts : null;
    if (!list) return null;
    return list
        .filter((o: any) => o && typeof o === 'object' && (o.title || o.name))
        .slice(0, 1000)
        .map((o: any) =>
            entry(
                url,
                o.title ?? o.name,
                o.summary ?? o.description ?? o.content_text ?? (typeof o.content_html === 'string' ? plainText(o.content_html) : ''),
                o.date_published ?? o.published_at ?? o.publishedAt ?? o.date ?? o.created_at ?? o.updated_at,
                o.type ?? o.kind ?? 'entry',
                o.url ?? o.link ?? o.html_url
            )
        );
}

function feedItems(xml: string, url: string): SourceItem[] {
    const out: SourceItem[] = [];
    for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
        const block = m[0];
        const tag = (name: string) => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1];
        const title = xmlText(tag('title'));
        if (!title) continue;
        const link = block.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? xmlText(tag('link'));
        out.push(entry(url, title, xmlText(tag('description') ?? tag('summary') ?? tag('content')), tag('pubDate') ?? tag('published') ?? tag('updated') ?? tag('dc:date'), 'post', link));
        if (out.length >= 500) break;
    }
    return out;
}

function entry(source: string, title: unknown, text: unknown, date: unknown, kind: unknown, link: unknown): SourceItem {
    const at = toIso(date);
    const t = String(title).replace(/\s+/g, ' ').trim().slice(0, 300);
    return {
        key: `${at?.slice(0, 10) ?? ''}-${shortHash(t)}${t.length.toString(36)}`,
        title: t,
        text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200),
        at,
        kind: String(kind).slice(0, 40),
        url: typeof link === 'string' && /^https?:\/\//.test(link.trim()) ? link.trim() : source
    };
}

function toIso(date: unknown): string | undefined {
    if (typeof date !== 'string' && typeof date !== 'number') return undefined;
    const s = String(date).trim();
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Paragraphs and list items, each under the heading it sits in. Code blocks are left out. */
function paragraphs(text: string, url: string, kind: string): SourceItem[] {
    const out: SourceItem[] = [];
    const keys = new Set<string>();
    let top = '';
    let heading = '';
    let lines: string[] = [];
    let code = false;
    const flush = () => {
        const t = lines.join(' ').replace(/\s+/g, ' ').trim();
        lines = [];
        if (!t) return;
        const key = `${shortHash(t)}${t.length.toString(36)}`;
        if (keys.has(key)) return;
        keys.add(key);
        const title = top && heading && heading !== top ? `${top}: ${heading}` : heading || top || label(url);
        out.push({ key, title: title.slice(0, 200), text: t.slice(0, 1200), kind, url });
    };
    for (const raw of text.replace(/\r/g, '').split('\n')) {
        const line = raw.trim();
        if (/^(```|~~~)/.test(line)) {
            flush();
            code = !code;
            continue;
        }
        if (code) continue;
        const h = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
        if (h) {
            flush();
            heading = h[2];
            if (h[1].length === 1) top = h[2];
            continue;
        }
        if (!line || /^[-*_=]{3,}$/.test(line)) {
            flush();
            continue;
        }
        // Each list item is its own paragraph, so one new bullet reads as one change.
        if (/^(?:[-*+]|\d+[.)])\s+/.test(line)) flush();
        lines.push(line);
    }
    flush();
    return out.slice(0, 20_000);
}

/** A page's readable text, with headings kept as Markdown ones. Comments, scripts, menus and footers are left out. */
function htmlText(html: string): string {
    return html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|svg|template|nav|footer|pre|head)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${plainText(inner)}\n\n`)
        .replace(/<li\b[^>]*>/gi, '\n\n- ')
        .replace(/<\/(?:p|li|blockquote|figure|figcaption|div|tr|table|ul|ol|section|article|header|main|aside|dd|dt)>|<br\s*\/?>/gi, '\n\n')
        .split(/\n{2,}/)
        .map(part => decodeEntities(plainText(part)))
        .filter(Boolean)
        .join('\n\n');
}

function xmlText(s: string | undefined): string {
    if (!s) return '';
    const raw = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    // Feeds often carry escaped HTML: unescape, then drop the tags.
    return decodeEntities(plainText(decodeEntities(raw)));
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: '-', ndash: '-', hellip: '...', middot: '·', copy: '©' };

function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
        }
        return NAMED[e.toLowerCase()] ?? m;
    });
}

function words(s: string): Set<string> {
    return new Set(s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#'-]*/gu) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
    let both = 0;
    for (const w of a) if (b.has(w)) both++;
    return both / (a.size + b.size - both || 1);
}
