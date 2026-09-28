/**
 * Post ideas that arrive by themselves. Once a day, at the hour set in
 * Settings, the server reads the AI knowledge sources and the idea sources,
 * keeps what is new since the last read (sources.ts), and asks the text model
 * for a few ideas grounded in it, under the same rules as the CLI studio
 * (core ideas.ts). The day is skipped when nothing is new or when enough
 * ideas are already waiting. "Refresh now" runs the same thing on request.
 */
import { admitSignal, denylist, ideaBlocked, ideaPrompt, interleaveSignals, readIdeas, type Background, type Policy } from '@masthead/core';
import { addIdeas } from './ai';
import { aiSettings, getSetting, setSetting, siteSettings } from './content';
import type { Ctx, Env } from './env';
import { listMemory } from './knowledge';
import { label, readSources, toSignals, type SourceRead } from './sources';
import { now } from './util';

export interface IdeaSettings {
    /** Refresh by itself once a day. */
    enabled: boolean;
    /** Hour of the day (UTC) the refresh runs. */
    hour: number;
    /** Ideas per refresh, at most. */
    count: number;
    /** The editor's direction for ideas, e.g. "more on what our benchmarks teach, less UI polish". */
    guidance: string | null;
    /** Public pages or feeds read besides the AI knowledge sources. Their text is also background for ideas. */
    sources: string[];
    /** Names ideas never mention; the DENYLIST variable adds more. */
    denylist: string[];
}

/** What the last refresh did, for the Ideas page. */
export interface IdeaRun {
    at: string;
    trigger: 'schedule' | 'manual';
    /** Items read across the sources. */
    read: number;
    /** New since the last read, after the denylist. */
    fresh: number;
    /** What the model was given: the new items, or the last two weeks on a manual refresh with nothing new. */
    used: number;
    added: number;
    /** Ideas dropped because they mention a denylisted name. */
    blocked: number;
    sources: { url: string; items: number; fresh: number; error?: string }[];
    skipped?: string;
    error?: string;
    model?: string;
    /** Attempts today, when a failed scheduled refresh is tried again. */
    tries?: number;
    ms?: number;
}

const DEFAULTS: IdeaSettings = { enabled: true, hour: 13, count: 5, guidance: null, sources: [], denylist: [] };
/** With this many ideas waiting, the daily refresh waits for the team to catch up. */
const MAX_OPEN = 30;
/** Signals in one prompt, at most. */
const PROMPT_SIGNALS = 60;
/** Minute past each hour when the cron checks whether the daily refresh is due. */
export const IDEAS_MINUTE = 7;

export function cleanIdeaSettings(input: Partial<IdeaSettings>): IdeaSettings {
    const int = (v: unknown, min: number, max: number, fallback: number) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fallback);
    const lines = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : []).map(s => String(s).trim()).filter(Boolean);
    return {
        enabled: input.enabled === undefined ? DEFAULTS.enabled : Boolean(input.enabled),
        hour: int(input.hour, 0, 23, DEFAULTS.hour),
        count: int(input.count, 1, 20, DEFAULTS.count),
        guidance: typeof input.guidance === 'string' && input.guidance.trim() ? input.guidance.trim().slice(0, 2000) : null,
        sources: [...new Set(lines(input.sources).filter(u => /^https?:\/\/\S+$/.test(u)))].slice(0, 20),
        denylist: [...new Set(lines(input.denylist).map(t => t.slice(0, 100)))].slice(0, 500)
    };
}

export async function ideaSettings(db: D1Database): Promise<IdeaSettings> {
    return cleanIdeaSettings(await getSetting<Partial<IdeaSettings>>(db, 'ideas', {}));
}

export async function saveIdeaSettings(db: D1Database, input: Partial<IdeaSettings>): Promise<IdeaSettings> {
    const next = cleanIdeaSettings({ ...(await ideaSettings(db)), ...input });
    await setSetting(db, 'ideas', next);
    return next;
}

/** Terms from the DENYLIST variable: newline or comma separated, "#" lines are comments. */
export function envDenylist(env: Env): string[] {
    return (env.DENYLIST ?? '')
        .split(/[\n,]/)
        .map(t => t.trim())
        .filter(t => t && !t.startsWith('#'));
}

function policies(env: Env, s: IdeaSettings): Policy[] {
    const terms = [...new Set([...envDenylist(env), ...s.denylist])];
    return terms.length ? [denylist(terms)] : [];
}

export async function lastIdeaRun(db: D1Database): Promise<IdeaRun | null> {
    return getSetting<IdeaRun | null>(db, 'ideas_run', null);
}

/** For the Ideas page: when ideas come, what the last refresh did, how many are waiting. */
export async function ideaStatus(ctx: Ctx) {
    const [s, last, open] = await Promise.all([ideaSettings(ctx.db), lastIdeaRun(ctx.db), openIdeas(ctx.db)]);
    return { enabled: s.enabled, hour: s.hour, count: s.count, open, maxOpen: MAX_OPEN, ai: Boolean(ctx.options.ai?.(ctx.env)), lastRun: last };
}

async function openIdeas(db: D1Database): Promise<number> {
    return Number((await db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE status = 'new'").first<{ n: number }>())?.n ?? 0);
}

/**
 * Runs from the minute cron. Once the day's hour has come and nothing ran
 * since, it refreshes; a failed refresh is tried again at the next hourly
 * check, three times at most.
 */
export async function scheduledIdeas(ctx: Ctx, at: Date): Promise<void> {
    const s = await ideaSettings(ctx.db);
    if (!s.enabled) return;
    const due = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), s.hour);
    if (at.getTime() < due) return;
    const last = await lastIdeaRun(ctx.db);
    const ranToday = !!last && Date.parse(last.at) >= due;
    if (ranToday && !(last!.error && (last!.tries ?? 1) < 3)) return;
    await refreshIdeas(ctx, 'schedule', ranToday ? (last!.tries ?? 1) + 1 : 1);
}

/** One refresh, recorded as the last run whatever happens. Only one runs at a time. */
export async function refreshIdeas(ctx: Ctx, trigger: IdeaRun['trigger'], tries = 1): Promise<IdeaRun> {
    const out: IdeaRun = { at: now(), trigger, read: 0, fresh: 0, used: 0, added: 0, blocked: 0, sources: [], ...(tries > 1 ? { tries } : {}) };
    if (!(await lock(ctx.db))) return { ...out, skipped: 'Another refresh is running.' };
    const t0 = Date.now();
    try {
        await run(ctx, out);
    } catch (err) {
        out.error = err instanceof Error ? err.message : String(err);
        console.error('idea refresh failed', err);
    } finally {
        out.ms = Date.now() - t0;
        await setSetting(ctx.db, 'ideas_run', out);
        await ctx.db.prepare("DELETE FROM settings WHERE key = 'ideas_lock'").run();
    }
    return out;
}

/** Takes the refresh lock unless another refresh holds it (a lock older than ten minutes is stale). */
async function lock(db: D1Database): Promise<boolean> {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const res = await db
        .prepare("INSERT INTO settings (key, value) VALUES ('ideas_lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE json_extract(settings.value, '$') < ?")
        .bind(JSON.stringify(until), now())
        .run();
    return (res.meta.changes ?? 0) > 0;
}

async function run(ctx: Ctx, out: IdeaRun): Promise<void> {
    const ai = ctx.options.ai?.(ctx.env);
    if (!ai) throw new Error('No AI provider is configured. Set PREDEV_API_KEY.');
    const [s, conf, site, memory, open] = await Promise.all([ideaSettings(ctx.db), aiSettings(ctx.env, ctx.db), siteSettings(ctx.env, ctx.db), listMemory(ctx.db), openIdeas(ctx.db)]);
    if (!conf.textModel) throw new Error('Choose a text model in Settings, AI.');
    if (out.trigger === 'schedule' && open >= MAX_OPEN) {
        out.skipped = `${open} ideas are waiting. New ones come once fewer than ${MAX_OPEN} are open.`;
        return;
    }
    const urls = [...new Set([...conf.knowledgeSources, ...s.sources])];
    if (!urls.length) {
        out.skipped = 'No sources to read. Add knowledge sources (Settings, AI) or idea sources (Settings, Ideas).';
        return;
    }

    const reads = await readSources(ctx.env, urls);
    const saveReads = () => Promise.all(reads.map(r => r.save()));
    out.sources = reads.map(r => ({ url: r.url, items: r.items.length, fresh: r.fresh.length, ...(r.error ? { error: r.error } : {}) }));
    out.read = reads.reduce((n, r) => n + r.items.length, 0);
    const rules = policies(ctx.env, s);
    // Material that names someone on the denylist never reaches the model.
    const fresh = toSignals(reads, 'fresh').filter(x => admitSignal(rules, x));
    out.fresh = fresh.length;
    // Asked for by hand with nothing new: the last two weeks, which the existing ideas below keep from repeating.
    const signals = fresh.length || out.trigger === 'schedule' ? fresh : toSignals(reads, 'recent').filter(x => admitSignal(rules, x));
    if (!signals.length) {
        out.skipped = reads.every(r => r.error) ? 'No source could be read.' : 'Nothing new since the last refresh.';
        await saveReads();
        return;
    }

    const numbered = interleaveSignals(signals, PROMPT_SIGNALS);
    out.used = numbered.length;
    const existing = await existingTitles(ctx.db);
    const pages = background(reads, s.sources, rules);
    // No more ideas than there is material for: one quiet day's single change is one story, not five takes on it.
    const count = Math.min(s.count, numbered.length + (pages.length ? 1 : 0));
    const { system, user } = ideaPrompt({
        site: site.title,
        voice: conf.voice,
        memory: memory.map(m => m.text),
        guidance: s.guidance,
        signals: numbered,
        background: pages,
        existing: existing.lines,
        count
    });
    const res = await ai.text({ model: conf.textModel, system, messages: [{ role: 'user', content: user }], json: true, maxTokens: Math.min(8000, 1500 + 700 * count), temperature: 0.7 });
    out.model = res.model;
    const taken = new Set(existing.open);
    const keep = [];
    for (const idea of readIdeas(res.text, numbered, pages)) {
        if (ideaBlocked(rules, idea)) {
            out.blocked++;
            continue;
        }
        if (taken.has(normal(idea.title))) continue;
        taken.add(normal(idea.title));
        keep.push({ title: idea.title, angle: idea.angle, series: idea.series, score: idea.score, sources: idea.sources.map(x => ({ ref: x.ref, title: x.title, url: x.url, summary: x.summary.slice(0, 600) })) });
        if (keep.length >= count) break;
    }
    out.added = (await addIdeas(ctx, keep)).added;
    // Only now is this read what the next one compares with: a failed refresh tries the same material again.
    await saveReads();
}

/** Posts and ideas that exist, so ideas don't repeat them; ideas someone turned down stay turned down. */
async function existingTitles(db: D1Database): Promise<{ lines: string[]; open: string[] }> {
    const since = new Date(Date.now() - 180 * 86400_000).toISOString();
    const [posts, ideas] = await db.batch([
        db.prepare("SELECT title, status FROM posts WHERE type = 'post' AND title != '' ORDER BY COALESCE(published_at, updated_at) DESC LIMIT 300"),
        db.prepare("SELECT title, status FROM ideas WHERE status = 'new' OR updated_at > ? ORDER BY created_at DESC LIMIT 300").bind(since)
    ]);
    const p = posts.results as { title: string; status: string }[];
    const i = ideas.results as { title: string; status: string }[];
    return {
        lines: [
            ...p.map(x => (x.status === 'draft' ? `${x.title} (draft in progress)` : x.title)),
            ...i.filter(x => x.status !== 'drafted').map(x => (x.status === 'new' ? `${x.title} (already suggested)` : `${x.title} (turned down)`))
        ],
        open: i.filter(x => x.status === 'new').map(x => normal(x.title))
    };
}

/** The idea sources' own text, the start of each page, with denylisted names masked. */
function background(reads: SourceRead[], ideaSources: string[], rules: Policy[]): Background[] {
    let room = 6000;
    const out: Background[] = [];
    for (const r of reads) {
        if (!ideaSources.includes(r.url) || !r.text || room <= 0) continue;
        const text = r.text.slice(0, Math.min(2500, room));
        room -= text.length;
        const masked = rules.reduce((e, p) => (p.redact ? p.redact(e) : e), { ref: r.url, title: label(r.url), body: text });
        out.push({ title: masked.title, text: masked.body, url: r.url });
    }
    return out;
}

const normal = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
