/**
 * Email sequences: emails every new subscriber gets in order, each a set time after
 * they join. The welcome series is one.
 *
 * Joining: each minute the cron reads the subscribe history past the sequence's cursor
 * (member_events ids only grow), so every way in counts: a confirmed signup on the blog,
 * an add through the API or the admin, a CSV import. Only people who subscribe after the
 * sequence was turned on join; imported history and anyone who was in it before never do.
 * In test mode only the team joins, and everyone else is passed over for good, so nobody
 * gets a stale series when test mode ends.
 *
 * Sending: due emails go out in batches of up to 100, each with an idempotency key, at
 * most one per person per run. Each email's row is claimed before it is sent, so two runs
 * never send the same one. People who unsubscribe, bounce or complain leave the sequence.
 */
import type { EmailMessage, EmailTransport } from '@masthead/core';
import { autoExcerpt, readingMinutes, renderBody, renderMarkdown, tagLinks } from '@masthead/render';
import { distinctId } from './analytics';
import { atLeast } from './auth';
import { loadBodies, newsletterSettings, siteSettings } from './content';
import { UNSUBSCRIBE_PLACEHOLDER, sequenceEmail, type NewsletterEmail, type PostCard } from './email';
import type { AppOptions, Ctx, Env, Principal } from './env';
import { appUrl, fillHeaders, imageSizes, onTeam, sender, testMode, testTeam, unsubscribeUrl, utmLinks, type Team } from './newsletter';
import { cachedPostReaders } from './posthog';
import { linkTag } from './publish';
import type { Router } from './router';
import { HttpError, body, json, newId, now, sleep } from './util';

// ------------------------------------------------------------------ the model

export interface StepPosts {
    /** best: the posts readers opened and read most; pinned: the posts chosen here; none: no posts. */
    mode: 'best' | 'pinned' | 'none';
    /** How many a best-of shows. */
    count: number;
    /** Best of within these tags (slugs); empty for the whole blog. */
    tags: string[];
    /** Chosen post ids, in order. */
    pinned: string[];
    /** A small heading over the posts. */
    heading: string;
}

export interface SequenceStep {
    id: string;
    /** Minutes after joining; 0 sends at once. */
    delay: number;
    subject: string;
    /** The line inboxes show after the subject. */
    preheader: string;
    /** Markdown above the posts. */
    intro: string;
    posts: StepPosts;
    /** Markdown under the posts. */
    outro: string;
    button: { label: string; url: string } | null;
}

export interface Sequence {
    id: string;
    name: string;
    enabled: boolean;
    enabledAt: string | null;
    /** Always in the order they send: by delay. */
    steps: SequenceStep[];
    createdAt: string | null;
    updatedAt: string | null;
}

interface SequenceRow {
    id: string;
    name: string;
    enabled: number;
    enabled_at: string | null;
    steps: string;
    cursor: number;
    created_at: string;
    updated_at: string;
}

const MAX_STEPS = 12;
const BUTTON_URL = /^https?:\/\/[^\s"<>]+$/i;
const MAX_POSTS = 6;
const DAY = 1440;

function toSequence(r: SequenceRow): Sequence {
    let steps: SequenceStep[] = [];
    try {
        steps = (JSON.parse(r.steps) as unknown[]).map(cleanStep);
    } catch {
        // Unreadable steps: an empty sequence sends nothing.
    }
    return { id: r.id, name: r.name, enabled: Boolean(r.enabled), enabledAt: r.enabled_at, steps: sortSteps(steps), createdAt: r.created_at, updatedAt: r.updated_at };
}

const sortSteps = (steps: SequenceStep[]) => steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.delay - b.s.delay || a.i - b.i).map(x => x.s);

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : '');

/** A step as stored: every field present, sizes bounded. Nothing here throws; saving validates. */
function cleanStep(raw: any): SequenceStep {
    const posts = raw?.posts ?? {};
    const label = text(raw?.button?.label, 60).trim();
    const url = text(raw?.button?.url, 2000).trim();
    return {
        id: typeof raw?.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : newId().slice(0, 12),
        delay: Math.max(0, Math.min(Math.round(Number(raw?.delay) || 0), 365 * DAY)),
        subject: text(raw?.subject, 200).trim(),
        preheader: text(raw?.preheader, 300).trim(),
        intro: text(raw?.intro, 20_000),
        posts: {
            mode: posts.mode === 'pinned' || posts.mode === 'none' ? posts.mode : 'best',
            count: Math.max(1, Math.min(Math.round(Number(posts.count) || 3), MAX_POSTS)),
            tags: Array.isArray(posts.tags) ? [...new Set(posts.tags.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20) as string[] : [],
            pinned: Array.isArray(posts.pinned) ? [...new Set(posts.pinned.map(String).filter((id: string) => /^[0-9a-f]{24}$/.test(id)))].slice(0, MAX_POSTS) as string[] : [],
            heading: text(posts.heading, 80).trim()
        },
        outro: text(raw?.outro, 20_000),
        button: label || url ? { label, url } : null
    };
}

/** Steps from an editor or a settings file, checked, with problems named in words people use. */
function validSteps(input: unknown): SequenceStep[] {
    if (!Array.isArray(input)) throw new HttpError(400, 'Steps must be a list.');
    if (input.length > MAX_STEPS) throw new HttpError(400, `A series can have up to ${MAX_STEPS} emails.`);
    const steps = sortSteps(input.map(cleanStep));
    const seen = new Set<string>();
    steps.forEach((s, i) => {
        const name = `Email ${i + 1}`;
        if (seen.has(s.id)) s.id = newId().slice(0, 12);
        seen.add(s.id);
        if (!s.subject) throw new HttpError(400, `${name} needs a subject.`);
        if (i > 0 && s.delay === steps[i - 1].delay) throw new HttpError(400, `Emails ${i} and ${i + 1} are set to send at the same time. Space them apart.`);
        if (s.button && (!s.button.label || !BUTTON_URL.test(s.button.url))) throw new HttpError(400, `${name}'s button needs a label and a web address that starts with https://.`);
        if (s.posts.mode === 'pinned' && !s.posts.pinned.length) throw new HttpError(400, `${name} shows chosen posts but has none. Choose some, or switch to best of.`);
    });
    return steps;
}

/** The series a new site starts with: plain copy that fits any blog. {site} is the site's title. */
export function defaultSequence(id: string): Sequence | null {
    if (id !== 'welcome') return null;
    const step = (s: Partial<SequenceStep> & Pick<SequenceStep, 'id' | 'delay' | 'subject'>): SequenceStep => cleanStep(s);
    return {
        id,
        name: 'Welcome series',
        enabled: false,
        enabledAt: null,
        createdAt: null,
        updatedAt: null,
        steps: [
            step({
                id: 'welcome-1',
                delay: 0,
                subject: 'Welcome to {site}',
                preheader: "Thanks for subscribing. Here's where to start.",
                intro: "# Welcome to {site}\n\nThanks for subscribing. New posts will land in this inbox as they're published.\n\nUntil the next one, here are the posts readers liked most.",
                posts: { mode: 'best', count: 3, tags: [], pinned: [], heading: 'Start here' }
            }),
            step({
                id: 'welcome-2',
                delay: 3 * DAY,
                subject: 'The posts readers come back to',
                preheader: 'A few more from the archive.',
                intro: '# From the archive\n\nMore of the posts readers opened and read the most.',
                posts: { mode: 'best', count: 3, tags: [], pinned: [], heading: 'Most read' }
            }),
            step({
                id: 'welcome-3',
                delay: 7 * DAY,
                subject: 'One more from {site}',
                preheader: 'The last of the welcome emails.',
                intro: "# The last welcome email\n\nFrom here on you'll get new posts as they come out. Three more worth your time before then.",
                posts: { mode: 'best', count: 3, tags: [], pinned: [], heading: 'Worth your time' },
                outro: 'Thanks for reading.'
            })
        ]
    };
}

export async function getSequence(db: D1Database, id: string): Promise<Sequence | null> {
    const row = await db.prepare('SELECT * FROM sequences WHERE id = ?').bind(id).first<SequenceRow>();
    return row ? toSequence(row) : null;
}

/**
 * Saves a sequence's name, steps and switch. Turning it on starts it from now: its cursor
 * moves to the newest subscribe history, so only people who subscribe from here on join.
 * Nothing else here moves the cursor, so an edit never re-reads or skips history.
 */
export async function saveSequence(db: D1Database, id: string, input: { name?: unknown; steps?: unknown; enabled?: unknown }): Promise<Sequence> {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new HttpError(400, 'A sequence id is lowercase letters, digits and dashes.');
    const existing = (await getSequence(db, id)) ?? defaultSequence(id);
    if (!existing && input.steps === undefined) throw new HttpError(404, 'No such sequence.');
    const steps = input.steps !== undefined ? validSteps(input.steps) : existing!.steps;
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : (existing?.name ?? 'Sequence');
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : Boolean(existing?.enabled);
    if (enabled && !steps.length) throw new HttpError(400, 'Add an email before turning the series on.');
    const turningOn = enabled && !existing?.enabled;
    const t = now();
    await db
        .prepare(
            `INSERT INTO sequences (id, name, enabled, enabled_at, steps, cursor, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM member_events), ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, steps = excluded.steps, enabled = excluded.enabled, updated_at = excluded.updated_at${turningOn ? ', enabled_at = excluded.enabled_at, cursor = excluded.cursor' : ''}`
        )
        .bind(id, name, enabled ? 1 : 0, enabled ? t : null, JSON.stringify(steps), t, t)
        .run();
    return (await getSequence(db, id))!;
}

/** Sequences from a settings file (the CLI's `settings --file`): copy and steps, and the switch only when the file sets it. */
export async function importSequences(db: D1Database, list: unknown): Promise<number> {
    if (!Array.isArray(list)) throw new HttpError(400, 'sequences must be a list.');
    let n = 0;
    for (const raw of list) {
        if (!raw || typeof raw.id !== 'string') throw new HttpError(400, 'Each sequence needs an id, e.g. "welcome".');
        await saveSequence(db, raw.id, { name: raw.name, steps: raw.steps, enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined });
        n++;
    }
    return n;
}

// ------------------------------------------------------------------ which posts

interface Candidate {
    id: string;
    slug: string;
    title: string;
    excerpt: string | null;
    image: string | null;
    imageAlt: string | null;
    publishedAt: string;
    featured: boolean;
    /** Public tag slugs, primary first, and the primary tag's name. */
    tags: string[];
    tag: string | null;
    /** People who opened its newsletter, and readers of the post in Analytics' last answer. */
    opens: number;
    readers: number;
}

interface Ranking {
    at: number;
    list: Candidate[];
    byId: Map<string, Candidate>;
}

let ranking: Ranking | null = null;
const RANKING_MS = 10 * 60_000;

/**
 * Published posts, best first. "Best" blends two reaches, each as a percentile so neither
 * swamps the other: people who opened the post's newsletter (sent here, or by Ghost before
 * the move) and readers of the post in Analytics' last answer. With neither on record,
 * featured posts lead, then the newest.
 */
async function rankedPosts(env: Env, db: D1Database, fresh = false): Promise<Ranking> {
    if (!fresh && ranking && Date.now() - ranking.at < RANKING_MS) return ranking;
    const [posts, sends, tags] = await db.batch([
        // The card's excerpt: the post's own, else its search description; failing both, the start of the post (stepEmail).
        db.prepare(
            "SELECT id, slug, title, COALESCE(NULLIF(TRIM(custom_excerpt), ''), NULLIF(TRIM(meta_description), '')) AS excerpt, feature_image, feature_image_alt, featured, published_at, newsletter FROM posts WHERE type = 'post' AND status = 'published'"
        ),
        db.prepare('SELECT post_id, SUM(unique_opens) AS opens FROM sends WHERE test_mode = 0 AND sent > 0 GROUP BY post_id'),
        db.prepare("SELECT pt.post_id, t.slug, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.visibility = 'public' ORDER BY pt.post_id, pt.sort")
    ]);
    const readers = await cachedPostReaders(env, db).catch(() => new Map<string, number>());
    const opensHere = new Map((sends.results as { post_id: string; opens: number }[]).map(r => [r.post_id, Number(r.opens) || 0]));
    const tagsOf = new Map<string, { slug: string; name: string }[]>();
    for (const r of tags.results as { post_id: string; slug: string; name: string }[]) tagsOf.set(r.post_id, [...(tagsOf.get(r.post_id) ?? []), { slug: r.slug, name: r.name }]);
    const list: Candidate[] = (posts.results as any[]).map(p => {
        let ghost = 0;
        try {
            ghost = Number(JSON.parse(p.newsletter ?? 'null')?.opened) || 0;
        } catch {
            // Not a stats object.
        }
        const t = tagsOf.get(p.id) ?? [];
        return {
            id: p.id,
            slug: p.slug,
            title: p.title,
            excerpt: p.excerpt,
            image: p.feature_image,
            imageAlt: p.feature_image_alt,
            publishedAt: p.published_at ?? '',
            featured: Boolean(p.featured),
            tags: t.map(x => x.slug),
            tag: t[0]?.name ?? null,
            // Opens counted here win: Ghost's number is for the same newsletter sent before the move.
            opens: opensHere.has(p.id) ? opensHere.get(p.id)! : ghost,
            readers: readers.get(p.slug) ?? 0
        };
    });
    const score = scorer(list);
    list.sort((a, b) => score(b) - score(a) || b.publishedAt.localeCompare(a.publishedAt));
    ranking = { at: Date.now(), list, byId: new Map(list.map(c => [c.id, c])) };
    return ranking;
}

function scorer(list: Candidate[]): (c: Candidate) => number {
    const percentile = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        const n = sorted.length;
        // How many values sort before v (strictly, or also counting equal ones).
        const below = (v: number, orEqual: boolean) => {
            let lo = 0;
            let hi = n;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (sorted[mid] < v || (orEqual && sorted[mid] === v)) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        };
        // Ties share the middle of their run, so equal numbers score the same.
        return (v: number) => (n < 2 ? (v > 0 ? 1 : 0) : (below(v, false) + below(v, true) - 1) / 2 / (n - 1));
    };
    const hasOpens = list.some(c => c.opens > 0);
    const hasReaders = list.some(c => c.readers > 0);
    const po = percentile(list.map(c => c.opens));
    const pr = percentile(list.map(c => c.readers));
    const [wo, wr] = hasOpens && hasReaders ? [0.6, 0.4] : hasOpens ? [1, 0] : hasReaders ? [0, 1] : [0, 0];
    const cache = new Map<string, number>();
    return c => {
        let s = cache.get(c.id);
        if (s === undefined) cache.set(c.id, (s = (wo ? wo * po(c.opens) : 0) + (wr ? wr * pr(c.readers) : 0) + (c.featured ? 0.05 : 0)));
        return s;
    };
}

/** The posts one email shows someone, leaving out posts they already got. */
function pick(r: Ranking, cfg: StepPosts, got: Set<string>): Candidate[] {
    if (cfg.mode === 'none') return [];
    if (cfg.mode === 'pinned') return cfg.pinned.map(id => r.byId.get(id)).filter((c): c is Candidate => !!c && !got.has(c.id));
    const open = r.list.filter(c => !got.has(c.id));
    const wanted = new Set(cfg.tags);
    const out = (wanted.size ? open.filter(c => c.tags.some(t => wanted.has(t))) : open).slice(0, cfg.count);
    // A topic that runs short is topped up from the whole blog.
    for (const c of open) {
        if (out.length >= cfg.count) break;
        if (!out.includes(c)) out.push(c);
    }
    return out;
}

// ------------------------------------------------------------------ one email

const fill = (s: string, site: string) => s.replaceAll('{site}', site);

interface Render {
    env: Env;
    db: D1Database;
    /** Loaded once per run or preview. */
    site?: Awaited<ReturnType<typeof siteSettings>>;
    settings?: Awaited<ReturnType<typeof newsletterSettings>>;
    from?: Awaited<ReturnType<typeof sender>>;
    templates: Map<string, NewsletterEmail>;
    bodies: Map<string, string>;
}

const renderer = (env: Env, db: D1Database): Render => ({ env, db, templates: new Map(), bodies: new Map() });

/** Links in an email: outbound ones get LINK_TAG like posts do, then every one gets the newsletter's campaign tags. */
function tagged(r: Render, htmlText: string, campaign: string, content: string): string {
    const withRef = tagLinks(htmlText, r.site!.url, linkTag(r.env));
    return r.settings!.utm === false ? withRef : utmLinks(withRef, { utm_source: 'email', utm_medium: 'newsletter', utm_campaign: campaign, utm_content: content });
}

function taggedUrl(r: Render, url: string, campaign: string, content: string): string {
    return /href="([^"]*)"/.exec(tagged(r, `<a href="${url}">`, campaign, content))?.[1]?.replace(/&amp;/g, '&') ?? url;
}

/**
 * The email for one step and a set of posts, with the unsubscribe placeholder still in.
 * Post links carry the same campaign tags as that post's newsletter (utm_campaign is its
 * slug) plus utm_content naming the series and email, e.g. "welcome-2".
 */
async function stepEmail(r: Render, seq: Sequence, step: SequenceStep, posts: Candidate[]): Promise<NewsletterEmail> {
    const key = `${seq.id}:${step.id}:${seq.updatedAt}:${posts.map(p => p.id).join(',')}`;
    const known = r.templates.get(key);
    if (known) return known;
    r.site ??= await siteSettings(r.env, r.db);
    r.settings ??= await newsletterSettings(r.env, r.db);
    r.from ??= await sender(r.env, r.db).catch(() => ({ from: '', replyTo: undefined, postalAddress: r.settings?.postalAddress ?? null }));
    const site = r.site;
    const number = seq.steps.findIndex(s => s.id === step.id) + 1 || 1;
    const content = `${seq.id}-${number}`;
    const missing = posts.filter(p => !r.bodies.has(p.id)).map(p => p.id);
    if (missing.length) for (const [id, b] of await loadBodies(r.db, missing)) r.bodies.set(id, renderBody({ ...b, id } as any));
    const sizes = await imageSizes(
        r.db,
        posts.map(p => p.image)
    ).catch(() => ({}) as Record<string, { width: number; height: number }>);
    const cards: PostCard[] = posts.map((p, i) => {
        const bodyHtml = r.bodies.get(p.id) ?? '';
        const url = `${site.url}${p.slug}/`;
        return {
            title: p.title,
            url: r.settings!.utm === false ? url : `${url}?${new URLSearchParams({ utm_source: 'email', utm_medium: 'newsletter', utm_campaign: p.slug, utm_content: content })}`,
            // The lead card has room for more of the excerpt.
            excerpt: autoExcerpt(p.excerpt?.trim() || bodyHtml, i === 0 ? 220 : 130),
            image: p.image,
            imageAlt: p.imageAlt,
            size: p.image ? (sizes[p.image] ?? null) : null,
            tag: p.tag,
            minutes: bodyHtml ? readingMinutes(bodyHtml) : null
        };
    });
    const intro = fill(step.intro, site.title);
    const outro = fill(step.outro, site.title);
    const email = sequenceEmail({
        site,
        origin: new URL(appUrl(r.env)).origin,
        subject: fill(step.subject, site.title),
        preheader: fill(step.preheader, site.title),
        intro: tagged(r, renderMarkdown(intro), seq.id, content),
        outro: tagged(r, renderMarkdown(outro), seq.id, content),
        introText: intro,
        outroText: outro,
        heading: fill(step.posts.heading, site.title),
        posts: cards,
        button: step.button?.label && BUTTON_URL.test(step.button.url) ? { label: fill(step.button.label, site.title), url: taggedUrl(r, step.button.url, seq.id, content) } : null,
        postalAddress: r.from.postalAddress
    });
    r.templates.set(key, email);
    return email;
}

/**
 * What a brand-new subscriber would get from step `index`, as the steps stand (saved or
 * not): earlier steps' posts are left out, as they would be for them.
 */
async function sample(r: Render, seq: Sequence, index: number): Promise<{ email: NewsletterEmail; posts: Candidate[] }> {
    const ranked = await rankedPosts(r.env, r.db, true);
    const got = new Set<string>();
    let posts: Candidate[] = [];
    for (let i = 0; i <= index; i++) {
        posts = pick(ranked, seq.steps[i].posts, got);
        for (const p of posts) got.add(p.id);
    }
    return { email: await stepEmail(r, seq, seq.steps[index], posts), posts };
}

// ------------------------------------------------------------------ joining

const isImported = (data: string | null) => !!data && data.includes('"imported":true');

/**
 * Enrolls people whose subscribe history since the cursor makes them new subscribers, and
 * moves the cursor past everything it read, joiners or not.
 */
async function sweep(db: D1Database, row: SequenceRow, seq: Sequence, team: Team | null): Promise<number> {
    const top = await db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM member_events').first<{ id: number }>();
    const hi = Number(top?.id ?? 0);
    let lo = Number(row.cursor);
    let joined = 0;
    const first = seq.steps[0]?.delay ?? 0;
    while (lo < hi) {
        const { results } = await db
            .prepare(
                `SELECT e.id, e.member_id, e.at, e.data, m.email, m.status, m.suppressed FROM member_events e JOIN members m ON m.id = e.member_id
                 WHERE e.id > ? AND e.id <= ? AND e.type = 'subscribed' ORDER BY e.id LIMIT 500`
            )
            .bind(lo, hi)
            .all<{ id: number; member_id: string; at: string; data: string | null; email: string; status: string; suppressed: string | null }>();
        const upto = results.length === 500 ? results[results.length - 1].id : hi;
        const t = new Date();
        const joins = results.filter(
            r => r.at >= (seq.enabledAt ?? '') && !isImported(r.data) && r.status === 'subscribed' && !r.suppressed && (!team || onTeam(team, r.email))
        );
        const stmts = [...new Set(joins.map(j => j.member_id))].map(memberId =>
            db
                .prepare("INSERT OR IGNORE INTO sequence_members (sequence_id, member_id, status, enrolled_at, next_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)")
                .bind(seq.id, memberId, t.toISOString(), new Date(t.getTime() + first * 60_000).toISOString(), t.toISOString())
        );
        // The cursor moves with the last group of joins, so a failure part way reads the same history again (joins are idempotent).
        const move = db.prepare('UPDATE sequences SET cursor = ? WHERE id = ? AND cursor = ?').bind(upto, seq.id, lo);
        for (let i = 0; i < stmts.length || i === 0; i += 90) {
            const chunk = stmts.slice(i, i + 90);
            const last = i + 90 >= stmts.length;
            const res = await db.batch(last ? [...chunk, move] : chunk);
            joined += res.slice(0, chunk.length).reduce((n, x) => n + (x.meta.changes ?? 0), 0);
            if (last && !res[res.length - 1].meta.changes) return joined; // another run moved it first
        }
        lo = upto;
    }
    return joined;
}

// ------------------------------------------------------------------ sending

const BATCH = 100;
/** A claimed email not settled by then (the run stopped part way) is tried again, as the same batch. */
const RETRY_MS = 5 * 60_000;
/** An email due longer ago than this is skipped rather than sent late (the series was off, or email was down). */
const LATE_MS = 3 * 86_400_000;

export interface SequenceRun {
    enrolled: number;
    sent: number;
    failed: number;
    skipped: number;
    stopped: number;
}

interface Run {
    env: Env;
    db: D1Database;
    transport: EmailTransport;
    sequences: Map<string, Sequence>;
    team: Team | null;
    stats: SequenceRun;
    render: Render;
    /** Members emailed in this run: one email each at most. */
    emailed: Set<string>;
}

interface Due {
    sequence_id: string;
    member_id: string;
    enrolled_at: string;
    next_at: string;
    email: string | null;
    member_status: string | null;
    suppressed: string | null;
    analytics_id: string | null;
}

interface Handled {
    step_id: string;
    status: string;
    sent_at: string | null;
    posts: string;
}

/** Sends what is due: new joiners first, then every enabled sequence's due emails, within the time budget. */
export async function processSequences(env: Env, db: D1Database, options: AppOptions, budgetMs = 40_000): Promise<SequenceRun> {
    const stats: SequenceRun = { enrolled: 0, sent: 0, failed: 0, skipped: 0, stopped: 0 };
    const { results: rows } = await db.prepare('SELECT * FROM sequences').all<SequenceRow>();
    const live = rows.filter(r => r.enabled);
    const stuck = await db.prepare("SELECT COUNT(*) AS n FROM sequence_sends WHERE status = 'sending'").first<{ n: number }>();
    if (!live.length && !Number(stuck?.n)) return stats;
    const deadline = Date.now() + budgetMs;
    // Test mode: only the team joins or gets an email; checked again right before each send.
    const team = testMode(env) ? await testTeam(env, db) : null;
    const sequences = new Map(rows.map(r => [r.id, toSequence(r)]));
    for (const r of live) stats.enrolled += await sweep(db, r, sequences.get(r.id)!, team);
    const transport = options.email?.(env);
    if (!transport) return stats;
    const from = await sender(env, db).catch(() => null);
    if (!from) {
        console.error('welcome series: set EMAIL_FROM (or a sender address in Settings) to send');
        return stats;
    }
    const run: Run = { env, db, transport, sequences, team, stats, render: { ...renderer(env, db), from }, emailed: new Set() };
    if (Number(stuck?.n)) await retryStuck(run);
    const ids = live.map(r => r.id);
    let after: string[] | null = null;
    while (ids.length && Date.now() < deadline) {
        const { results: due }: { results: Due[] } = await db
            .prepare(
                `SELECT sm.sequence_id, sm.member_id, sm.enrolled_at, sm.next_at, m.email, m.status AS member_status, m.suppressed, m.analytics_id
                 FROM sequence_members sm LEFT JOIN members m ON m.id = sm.member_id
                 WHERE sm.status = 'active' AND sm.next_at <= ? AND sm.sequence_id IN (${ids.map(() => '?').join(',')})
                 ${after ? 'AND (sm.next_at, sm.sequence_id, sm.member_id) > (?, ?, ?)' : ''}
                 ORDER BY sm.next_at, sm.sequence_id, sm.member_id LIMIT ?`
            )
            .bind(now(), ...ids, ...(after ?? []), BATCH)
            .all<Due>();
        if (!due.length) break;
        const last: Due = due[due.length - 1];
        after = [last.next_at, last.sequence_id, last.member_id];
        const sent = await sendDue(run, due);
        // The provider failed the whole batch: stop, and try again next minute.
        if (sent === null) break;
        if (sent > 0) await sleep(550);
    }
    return stats;
}

/** What each person already got from sequences and newsletters, for the next step and for leaving out posts. */
async function history(db: D1Database, memberIds: string[]) {
    const handled = new Map<string, Handled[]>();
    const got = new Map<string, Set<string>>();
    const add = (m: string, post: string) => got.set(m, (got.get(m) ?? new Set()).add(post));
    for (let i = 0; i < memberIds.length; i += 90) {
        const chunk = memberIds.slice(i, i + 90);
        const marks = chunk.map(() => '?').join(',');
        const [steps, letters] = await db.batch([
            db.prepare(`SELECT sequence_id, member_id, step_id, status, sent_at, posts FROM sequence_sends WHERE member_id IN (${marks})`).bind(...chunk),
            db.prepare(`SELECT r.member_id, s.post_id FROM send_recipients r JOIN sends s ON s.id = r.send_id WHERE r.member_id IN (${marks}) AND r.status = 'sent'`).bind(...chunk)
        ]);
        for (const r of steps.results as (Handled & { sequence_id: string; member_id: string })[]) {
            const k = `${r.sequence_id}:${r.member_id}`;
            handled.set(k, [...(handled.get(k) ?? []), r]);
            if (r.status === 'sent' || r.status === 'sending') for (const p of JSON.parse(r.posts || '[]') as string[]) add(r.member_id, p);
        }
        for (const r of letters.results as { member_id: string; post_id: string }[]) add(r.member_id, r.post_id);
    }
    return { handled, got };
}

/**
 * The step someone gets next and when: the first step, in send order, that is later than
 * every step they already had and not had itself. A late email pushes the rest back so the
 * spacing between emails holds.
 */
function nextStep(seq: Sequence, enrolledAt: string, done: Handled[]): { step: SequenceStep; at: number } | null {
    const had = new Set(done.map(d => d.step_id));
    const reached = Math.max(-1, ...seq.steps.filter(s => had.has(s.id)).map(s => s.delay));
    const step = seq.steps.find(s => s.delay > reached && !had.has(s.id));
    if (!step) return null;
    let at = Date.parse(enrolledAt) + step.delay * 60_000;
    const lastSent = Math.max(0, ...done.map(d => (d.sent_at ? Date.parse(d.sent_at) : 0)));
    if (lastSent && reached >= 0) at = Math.max(at, lastSent + (step.delay - reached) * 60_000);
    return { step, at };
}

function settle(db: D1Database, seqId: string, memberId: string, next: { at: number } | null, reason?: string) {
    return next
        ? db.prepare("UPDATE sequence_members SET status = 'active', next_at = ?, updated_at = ? WHERE sequence_id = ? AND member_id = ?").bind(new Date(next.at).toISOString(), now(), seqId, memberId)
        : db.prepare('UPDATE sequence_members SET status = ?, reason = ?, next_at = NULL, updated_at = ? WHERE sequence_id = ? AND member_id = ?').bind(reason ? 'stopped' : 'done', reason ?? null, now(), seqId, memberId);
}

interface Claim {
    id: string;
    due: Due;
    seq: Sequence;
    step: SequenceStep;
    posts: Candidate[];
    done: Handled[];
}

/** One batch: settles who leaves or finishes, claims the emails that are due, sends them, records what happened. */
async function sendDue(run: Run, due: Due[]): Promise<number | null> {
    const { db, stats } = run;
    const t = Date.now();
    const { handled, got } = await history(db, [...new Set(due.map(d => d.member_id))]);
    let ranked: Ranking | null = null;
    const updates: D1PreparedStatement[] = [];
    const claims: Claim[] = [];
    const batch = newId();
    for (const d of due) {
        const seq = run.sequences.get(d.sequence_id)!;
        // Unsubscribed, bounced, complained, removed, or outside test mode's team: they leave the sequence.
        const leave = !d.email ? 'removed' : d.suppressed ? d.suppressed : d.member_status !== 'subscribed' ? 'unsubscribed' : run.team && !onTeam(run.team, d.email) ? 'test mode' : null;
        if (leave) {
            updates.push(settle(db, seq.id, d.member_id, null, leave));
            stats.stopped++;
            continue;
        }
        if (run.emailed.has(d.member_id)) continue;
        const done = handled.get(`${seq.id}:${d.member_id}`) ?? [];
        const next = nextStep(seq, d.enrolled_at, done);
        if (!next) {
            updates.push(settle(db, seq.id, d.member_id, null));
            continue;
        }
        if (next.at > t + 1000) {
            // The steps changed since this was scheduled: wait for the new time.
            updates.push(settle(db, seq.id, d.member_id, next));
            continue;
        }
        if (t - next.at > LATE_MS) {
            updates.push(
                db
                    .prepare(
                        "INSERT OR IGNORE INTO sequence_sends (id, sequence_id, step_id, member_id, email, subject, posts, status, error, test_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, '[]', 'skipped', 'Too late to send', ?, ?)"
                    )
                    .bind(newId(), seq.id, next.step.id, d.member_id, d.email, next.step.subject, run.team ? 1 : 0, now())
            );
            updates.push(settle(db, seq.id, d.member_id, nextStep(seq, d.enrolled_at, [...done, { step_id: next.step.id, status: 'skipped', sent_at: null, posts: '[]' }])));
            stats.skipped++;
            continue;
        }
        ranked ??= await rankedPosts(run.env, db);
        claims.push({ id: newId(), due: d, seq, step: next.step, posts: pick(ranked, next.step.posts, got.get(d.member_id) ?? new Set()), done });
        run.emailed.add(d.member_id);
    }
    if (updates.length) await batchAll(db, updates);
    if (!claims.length) return 0;

    // Claim every email first: the unique row per person and step means an overlapping run gets nothing to send twice.
    const at = now();
    const inserted = await db.batch(
        claims.map(c =>
            db
                .prepare(
                    "INSERT OR IGNORE INTO sequence_sends (id, sequence_id, step_id, member_id, email, subject, posts, status, batch, test_mode, created_at, tried_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?, ?)"
                )
                .bind(c.id, c.seq.id, c.step.id, c.due.member_id, c.due.email, c.step.subject, JSON.stringify(c.posts.map(p => p.id)), batch, run.team ? 1 : 0, at, at)
        )
    );
    const mine = claims.filter((_, i) => inserted[i].meta.changes).sort((a, b) => a.id.localeCompare(b.id));
    if (!mine.length) return 0;
    return deliver(run, mine);
}

/** Sends claimed emails as one batch, in id order (a retry rebuilds the same batch, so the provider's idempotency holds). */
async function deliver(run: Run, claims: Claim[]): Promise<number | null> {
    const { db, env, stats } = run;
    const r = run.render;
    const messages: EmailMessage[] = [];
    for (const c of claims) {
        const email = await stepEmail(r, c.seq, c.step, c.posts);
        const unsub = await unsubscribeUrl(env, c.due.member_id, c.id);
        const number = c.seq.steps.findIndex(s => s.id === c.step.id) + 1;
        messages.push({
            to: c.due.email!,
            from: r.from!.from,
            replyTo: r.from!.replyTo,
            subject: email.subject,
            html: email.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, unsub),
            text: email.text.replaceAll(UNSUBSCRIBE_PLACEHOLDER, unsub),
            headers: {
                ...fillHeaders(r.settings!.emailHeaders ?? {}, {
                    distinct_id: distinctId({ analytics_id: c.due.analytics_id, email: c.due.email! }),
                    analytics_id: c.due.analytics_id ?? '',
                    member_id: c.due.member_id,
                    post_slug: '',
                    send_id: c.id,
                    sequence: c.seq.id,
                    step: String(number)
                }),
                'List-Unsubscribe': `<${unsub}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            },
            idempotencyKey: `seq:${c.seq.id}:${c.step.id}:${c.due.member_id}`
        });
    }
    const results = await run.transport.send(messages);
    const t = now();
    const ok = results.filter(x => x.ok).length;
    if (!ok) {
        // Nothing went out (bad key, provider down): the claims stay, to be retried as this same batch.
        await db.batch(claims.map((c, i) => db.prepare('UPDATE sequence_sends SET error = ?, tried_at = ? WHERE id = ?').bind(results[i]?.error ?? 'Sending failed.', t, c.id)));
        console.error(`welcome series: a batch of ${claims.length} failed: ${results[0]?.error ?? 'unknown error'}`);
        return null;
    }
    // Record the outcome in one batch first: whatever happens after, these emails are never sent again.
    await db.batch(
        results.map((res, i) =>
            db
                .prepare('UPDATE sequence_sends SET status = ?, provider_id = ?, error = ?, sent_at = ?, tried_at = ? WHERE id = ?')
                .bind(res.ok ? 'sent' : 'failed', res.providerId ?? null, res.ok ? null : (res.error ?? 'Sending failed.'), res.ok ? t : null, t, claims[i].id)
        )
    );
    const after: D1PreparedStatement[] = [];
    results.forEach((res, i) => {
        const c = claims[i];
        if (res.ok) after.push(db.prepare('UPDATE members SET email_count = email_count + 1, last_emailed_at = ? WHERE id = ?').bind(t, c.due.member_id));
        after.push(settle(db, c.seq.id, c.due.member_id, nextStep(c.seq, c.due.enrolled_at, [...c.done, { step_id: c.step.id, status: res.ok ? 'sent' : 'failed', sent_at: res.ok ? t : null, posts: '[]' }])));
    });
    await batchAll(db, after);
    stats.sent += ok;
    stats.failed += results.length - ok;
    return ok;
}

/**
 * Emails a run claimed but never settled. After a failed attempt (the provider took none of
 * them) they go again. After an interruption nobody knows whether the provider took them, so
 * they go again only as the very same batch, which the provider recognizes and drops if it
 * already delivered it; when that batch can't be rebuilt (someone left since), they are
 * given up on rather than risk sending twice.
 */
async function retryStuck(run: Run): Promise<void> {
    const { db } = run;
    const cutoff = new Date(Date.now() - RETRY_MS).toISOString();
    const { results } = await db
        .prepare(
            `SELECT ss.id, ss.sequence_id, ss.step_id, ss.member_id, ss.posts, ss.batch, ss.error, ss.created_at, m.email, m.status AS member_status, m.suppressed, m.analytics_id, sm.enrolled_at, sm.next_at
             FROM sequence_sends ss LEFT JOIN members m ON m.id = ss.member_id LEFT JOIN sequence_members sm ON sm.sequence_id = ss.sequence_id AND sm.member_id = ss.member_id
             WHERE ss.status = 'sending' AND ss.tried_at < ? ORDER BY ss.batch, ss.id LIMIT 300`
        )
        .bind(cutoff)
        .all<Due & { id: string; step_id: string; posts: string; batch: string; error: string | null; created_at: string }>();
    const batches = new Map<string, typeof results>();
    for (const row of results) batches.set(row.batch, [...(batches.get(row.batch) ?? []), row]);
    if (!batches.size) return;
    const ranked = await rankedPosts(run.env, db);
    for (const [batch, rows] of batches) {
        // Claim the retry, so two runs never both retry a batch.
        const claim = await db.prepare("UPDATE sequence_sends SET tried_at = ? WHERE batch = ? AND status = 'sending' AND tried_at < ?").bind(now(), batch, cutoff).run();
        if (claim.meta.changes !== rows.length) continue;
        const claims: Claim[] = [];
        const drop: { row: (typeof rows)[number]; why: string }[] = [];
        for (const row of rows) {
            const seq = run.sequences.get(row.sequence_id);
            const step = seq?.steps.find(s => s.id === row.step_id);
            const why = !seq || !step || !row.enrolled_at ? 'Its email was removed from the series' : !row.email || row.member_status !== 'subscribed' || row.suppressed ? 'They left the list first' : Date.now() - Date.parse(row.created_at) > LATE_MS ? 'Too late to send' : null;
            if (why) drop.push({ row, why });
            else claims.push({ id: row.id, due: row, seq: seq!, step: step!, posts: (JSON.parse(row.posts || '[]') as string[]).map(id => ranked.byId.get(id)).filter((c): c is Candidate => !!c), done: [] });
        }
        const failedBefore = rows.every(r => r.error);
        if (drop.length && !failedBefore) for (const c of claims.splice(0)) drop.push({ row: c.due as (typeof rows)[number], why: 'Interrupted while sending; not sent again in case it arrived' });
        const give: D1PreparedStatement[] = [];
        for (const { row, why } of drop) {
            give.push(db.prepare("UPDATE sequence_sends SET status = 'failed', error = ? WHERE id = ?").bind(why, row.id));
            const seq = run.sequences.get(row.sequence_id);
            if (seq && row.enrolled_at) give.push(settle(db, seq.id, row.member_id, nextStep(seq, row.enrolled_at, [{ step_id: row.step_id, status: 'failed', sent_at: null, posts: '[]' }])));
            run.stats.failed++;
        }
        if (give.length) await batchAll(db, give);
        if (!claims.length) continue;
        for (const c of claims) run.emailed.add(c.due.member_id);
        if ((await deliver(run, claims.sort((a, b) => a.id.localeCompare(b.id)))) === null) return;
    }
}

async function batchAll(db: D1Database, stmts: D1PreparedStatement[]) {
    for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
}

// ------------------------------------------------------------------ numbers

export interface StepStats {
    sent: number;
    failed: number;
    skipped: number;
    delivered: number;
    opened: number;
    clicked: number;
    unsubscribed: number;
}

/** Per step: emails sent and the people who opened, clicked or unsubscribed from them. In test mode, test mode's emails; otherwise the rest. */
async function sequenceStats(env: Env, db: D1Database, seq: Sequence, withPeople: boolean) {
    const test = testMode(env) ? 1 : 0;
    const [sends, events, people, recent] = await db.batch([
        db
            .prepare(
                `SELECT step_id, SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed, SUM(status = 'skipped') AS skipped, SUM(unsubscribed_at IS NOT NULL) AS unsubscribed
                 FROM sequence_sends WHERE sequence_id = ? AND test_mode = ? GROUP BY step_id`
            )
            .bind(seq.id, test),
        db
            .prepare(
                `SELECT ss.step_id, e.type, COUNT(DISTINCT e.member_id) AS people FROM sequence_sends ss JOIN email_events e ON e.send_id = ss.id
                 WHERE ss.sequence_id = ? AND ss.test_mode = ? AND e.type IN ('delivered', 'opened', 'clicked') GROUP BY ss.step_id, e.type`
            )
            .bind(seq.id, test),
        // Someone who left the list is out of the series, even before the next email would have noticed.
        db
            .prepare(
                `SELECT CASE WHEN sm.status = 'active' AND (m.id IS NULL OR m.status != 'subscribed' OR m.suppressed IS NOT NULL) THEN 'stopped' ELSE sm.status END AS state, COUNT(*) AS n
                 FROM sequence_members sm LEFT JOIN members m ON m.id = sm.member_id WHERE sm.sequence_id = ? GROUP BY state`
            )
            .bind(seq.id),
        db
            .prepare(
                `SELECT sm.member_id AS id, m.email, sm.status, sm.reason, sm.enrolled_at, sm.next_at,
                   (SELECT COUNT(*) FROM sequence_sends ss WHERE ss.sequence_id = sm.sequence_id AND ss.member_id = sm.member_id AND ss.status = 'sent') AS sent
                 FROM sequence_members sm LEFT JOIN members m ON m.id = sm.member_id WHERE sm.sequence_id = ? ORDER BY sm.enrolled_at DESC LIMIT 8`
            )
            .bind(seq.id)
    ]);
    const steps: Record<string, StepStats> = {};
    const of = (id: string) => (steps[id] ??= { sent: 0, failed: 0, skipped: 0, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0 });
    for (const r of sends.results as any[]) Object.assign(of(r.step_id), { sent: Number(r.sent) || 0, failed: Number(r.failed) || 0, skipped: Number(r.skipped) || 0, unsubscribed: Number(r.unsubscribed) || 0 });
    for (const r of events.results as any[]) of(r.step_id)[r.type as 'delivered' | 'opened' | 'clicked'] = Number(r.people) || 0;
    const count = (s: string) => Number((people.results as any[]).find(r => r.state === s)?.n ?? 0);
    return {
        testMode: Boolean(test),
        steps,
        people: { active: count('active'), done: count('done'), stopped: count('stopped') },
        // Addresses are for admins, who can see members anyway.
        recent: withPeople ? (recent.results as any[]).map(r => ({ id: r.id, email: r.email ?? null, status: r.status, reason: r.reason, enrolledAt: r.enrolled_at, nextAt: r.next_at, sent: Number(r.sent) || 0 })) : null
    };
}

/** Marks an unsubscribe as coming from a series email, when the link was in one sent to this person. */
export async function sequenceUnsubscribe(db: D1Database, sendId: string, memberId: string): Promise<{ sequence: string; step: string } | null> {
    const row = await db
        .prepare('UPDATE sequence_sends SET unsubscribed_at = ? WHERE id = ? AND member_id = ? AND unsubscribed_at IS NULL RETURNING sequence_id, step_id')
        .bind(now(), sendId, memberId)
        .first<{ sequence_id: string; step_id: string }>();
    return row ? { sequence: row.sequence_id, step: row.step_id } : null;
}

// ------------------------------------------------------------------ admin API

type A = Ctx & { principal?: Principal };

/** A step list from the editor, or the saved one; `index` picks the step to show. */
async function draft(ctx: A, id: string, input: Record<string, any>) {
    const saved = (await getSequence(ctx.db, id)) ?? defaultSequence(id);
    if (!saved) throw new HttpError(404, 'No such sequence.');
    const steps = input.steps !== undefined ? sortSteps((Array.isArray(input.steps) ? input.steps : []).map(cleanStep)) : saved.steps;
    const index = typeof input.step === 'string' ? steps.findIndex(s => s.id === input.step) : Number(input.index ?? 0);
    if (!steps[index]) throw new HttpError(400, 'That email is not in the series.');
    return { seq: { ...saved, steps, updatedAt: now() }, index };
}

async function payload(ctx: A, id: string) {
    const stored = await getSequence(ctx.db, id);
    const seq = stored ?? defaultSequence(id);
    if (!seq) throw new HttpError(404, 'No such sequence.');
    const p = ctx.principal!;
    const team = await testTeam(ctx.env, ctx.db);
    const from = await sender(ctx.env, ctx.db).catch(() => null);
    return {
        sequence: seq,
        saved: Boolean(stored),
        stats: await sequenceStats(ctx.env, ctx.db, seq, p.role === 'owner' || p.role === 'admin'),
        environment: {
            testMode: testMode(ctx.env),
            email: Boolean(ctx.options.email?.(ctx.env)),
            webhooks: Boolean(ctx.env.RESEND_WEBHOOK_SECRET),
            // The sender's name as inboxes show it, for the editor's inbox preview.
            from: from ? (/^\s*"?([^"<]+?)"?\s*</.exec(from.from)?.[1] ?? from.from) : null,
            you: p.email ? { email: p.email, team: onTeam(team, p.email) } : null
        }
    };
}

export function sequenceRoutes(r: Router<A>) {
    r.get('/sequences/:id', async (_req, ctx, { id }) => (atLeast(ctx.principal, 'editor'), json(await payload(ctx, id))));

    r.put('/sequences/:id', async (req, ctx, { id }) => {
        atLeast(ctx.principal, 'editor');
        const input = await body(req);
        await saveSequence(ctx.db, id, { name: input.name, steps: input.steps, enabled: input.enabled });
        return json(await payload(ctx, id));
    });

    /** One email as a brand-new subscriber would get it, from the editor's unsaved steps. */
    r.post('/sequences/:id/preview', async (req, ctx, { id }) => {
        atLeast(ctx.principal, 'editor');
        const { seq, index } = await draft(ctx, id, await body(req));
        const { email, posts } = await sample(renderer(ctx.env, ctx.db), seq, index);
        return json({
            subject: email.subject,
            preheader: seq.steps[index].preheader.replaceAll('{site}', (await siteSettings(ctx.env, ctx.db)).title),
            html: email.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, '#'),
            posts: posts.map(p => ({ id: p.id, title: p.title, slug: p.slug, tag: p.tag, opens: p.opens, readers: p.readers }))
        });
    });

    /** Sends one email, as the editor has it, to the signed-in staff member. Staff are always on test mode's team. */
    r.post('/sequences/:id/test', async (req, ctx, { id }) => {
        const p = atLeast(ctx.principal, 'editor');
        const transport = ctx.options.email?.(ctx.env);
        if (!transport) throw new HttpError(500, 'No email provider is configured.');
        if (!p.email) throw new HttpError(400, 'Sign in as a staff member to get a test email.');
        if (!onTeam(await testTeam(ctx.env, ctx.db), p.email)) throw new HttpError(400, 'Tests go only to the team.');
        const { seq, index } = await draft(ctx, id, await body(req));
        const r = renderer(ctx.env, ctx.db);
        const { email } = await sample(r, seq, index);
        const [res] = await transport.send([
            {
                to: p.email,
                from: r.from!.from,
                replyTo: r.from!.replyTo,
                subject: `[Test] ${email.subject}`,
                html: email.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, '#'),
                text: email.text.replaceAll(UNSUBSCRIBE_PLACEHOLDER, '#'),
                idempotencyKey: `seqtest:${seq.id}:${seq.steps[index].id}:${p.email}:${Date.now()}`
            }
        ]);
        if (!res?.ok) throw new HttpError(502, res?.error ?? 'The test was not sent.');
        return json({ sent: 1, to: p.email });
    });
}
