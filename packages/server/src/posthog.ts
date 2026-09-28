/**
 * Reader traffic from PostHog, for the admin's Analytics: HogQL queries over the
 * events the theme sends, scoped to production pages (the canonical host and
 * the blog's path), with bots left out. Answers are kept in D1 so a page opens
 * at once and PostHog is asked at most every ten minutes per view.
 */
import { groupChannels, siteRoot, type ChannelRow, type Origin } from './channels';
import type { Ctx, Env } from './env';
import { basePath } from './publish';
import type { Range } from './stats';

const FRESH_MS = 10 * 60_000;
/** "Refresh" asks PostHog again once an answer is at least this old. */
const REFRESH_MS = 60_000;
/** Older answers are still shown (marked as such) while a fresh one loads, or when PostHog is down. */
const KEEP_MS = 7 * 86_400_000;
const BLOG_EVENTS = ['blog_post_viewed', 'blog_post_read', 'blog_cta_clicked', 'blog_post_shared', 'blog_subscribe_submitted'];

export interface PosthogSetup {
    /** POSTHOG_KEY: pages send events. */
    tracking: boolean;
    /** POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID: the admin can read them. */
    key: boolean;
    project: boolean;
    /** The PostHog app, where personal API keys are made. */
    app: string;
}

export function posthogSetup(env: Env): PosthogSetup {
    return { tracking: Boolean(env.POSTHOG_KEY), key: Boolean(env.POSTHOG_PERSONAL_API_KEY), project: Boolean(env.POSTHOG_PROJECT_ID), app: posthogApiHost(env) };
}

/** The private API (queries) lives on us.posthog.com or eu.posthog.com, not the ingestion host. */
export function posthogApiHost(env: Env): string {
    if (env.POSTHOG_API_HOST) return env.POSTHOG_API_HOST.replace(/\/+$/, '');
    const ingest = (env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');
    return /\.i\.posthog\.com$/.test(new URL(ingest).hostname) ? ingest.replace('.i.posthog.com', '.posthog.com') : ingest;
}

export function signupEvent(env: Env): string {
    return env.POSTHOG_SIGNUP_EVENT || 'auth_signup_success';
}

// ---------------------------------------------------------------- HogQL

interface Scope {
    hosts: string[];
    base: string;
    root: string;
}

function scopeOf(env: Env): Scope {
    const host = new URL(env.SITE_URL).hostname.toLowerCase().replace(/^www\./, '');
    return { hosts: [host, `www.${host}`], base: basePath(env), root: siteRoot(host) };
}

// Every value put into a query comes from configuration or is generated here, and is quoted.
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const time = (iso: string) => `toDateTime(${str(iso.slice(0, 19).replace('T', ' '))}, 'UTC')`;
const list = (xs: string[]) => xs.map(str).join(', ');

function bucket(unit: Range['unit']): string {
    const t = "toTimeZone(timestamp, 'UTC')";
    return unit === 'day' ? `toString(toDate(${t}))` : unit === 'week' ? `toString(toStartOfWeek(${t}, 1))` : `toString(toStartOfMonth(${t}))`;
}

/** Production pages of the blog: the canonical host, under the blog's path, people rather than bots. */
const onBlog = (s: Scope) => `properties.$host IN (${list(s.hosts)}) AND startsWith(properties.$pathname, ${str(s.base)}) AND NOT $virt_is_bot`;
/** The referrer was another page of the blog. */
const internalRef = (s: Scope) => `(coalesce(properties.$referring_domain, '') IN (${list(s.hosts)}) AND startsWith(path(coalesce(properties.$referrer, '')), ${str(s.base)}))`;

export class PosthogError extends Error {
    constructor(
        message: string,
        readonly status = 502
    ) {
        super(message);
    }
}

async function hogql(env: Env, name: string, query: string): Promise<unknown[][]> {
    const url = `${posthogApiHost(env)}/api/projects/${encodeURIComponent(env.POSTHOG_PROJECT_ID!)}/query/`;
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify({ query: { kind: 'HogQLQuery', query }, name: `masthead ${name}` }),
            signal: AbortSignal.timeout(25_000)
        }).catch(err => {
            throw new PosthogError(`Could not reach PostHog at ${posthogApiHost(env)}: ${err?.message ?? err}`);
        });
        if (res.ok) return ((await res.json()) as { results?: unknown[][] }).results ?? [];
        const detail = (await res.text()).slice(0, 300);
        // Too many queries at once or over budget: one short wait, then report it.
        const wait = Number(res.headers.get('retry-after')) || 2;
        if (res.status === 429 && attempt === 0 && wait <= 5) {
            await new Promise(r => setTimeout(r, wait * 1000));
            continue;
        }
        if (res.status === 401 || res.status === 403) throw new PosthogError(`PostHog refused the key (${res.status}). It needs query read access to project ${env.POSTHOG_PROJECT_ID}.`);
        if (res.status === 404) throw new PosthogError(`PostHog has no project ${env.POSTHOG_PROJECT_ID} for this key.`);
        if (res.status === 429) throw new PosthogError('PostHog is limiting queries right now. Try again in a few minutes.');
        throw new PosthogError(`PostHog answered ${res.status} to "${name}": ${detail}`);
    }
}

/** PostHog runs at most three queries per project at once. */
async function runAll(env: Env, queries: [string, string][]): Promise<unknown[][][]> {
    const out: unknown[][][] = new Array(queries.length);
    let next = 0;
    const worker = async () => {
        while (next < queries.length) {
            const i = next++;
            out[i] = await hogql(env, queries[i][0], queries[i][1]);
        }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

// ---------------------------------------------------------------- the cache

export interface Cached<T> {
    status: 'ok';
    data: T;
    updatedAt: string;
    /** Older than ten minutes: a fresh answer is on its way, or PostHog could not be reached. */
    stale: boolean;
    error?: string;
}

const memory = new Map<string, { at: number; data: unknown }>();
/** When this isolate last started refreshing a view in the background, so a burst of page loads starts one. */
const refreshing = new Map<string, number>();

/** Kept in memory and D1, fresh for `freshMs` (other sources than PostHog pass their own), then served while a new answer loads. */
export async function cached<T>(ctx: Ctx, key: string, force: boolean, compute: () => Promise<T>, freshMs = FRESH_MS): Promise<Cached<T>> {
    let hit = memory.get(key) as { at: number; data: T } | undefined;
    if (!hit) {
        const row = await ctx.db.prepare('SELECT data, fetched_at FROM analytics_cache WHERE key = ?').bind(key).first<{ data: string; fetched_at: string }>();
        if (row) memory.set(key, (hit = { at: Date.parse(row.fetched_at), data: JSON.parse(row.data) as T }));
    }
    const age = hit ? Date.now() - hit.at : Infinity;
    const load = async () => {
        const data = await compute();
        const at = Date.now();
        memory.set(key, { at, data });
        await ctx.db.batch([
            ctx.db
                .prepare('INSERT INTO analytics_cache (key, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at')
                .bind(key, JSON.stringify(data), new Date(at).toISOString()),
            ctx.db.prepare('DELETE FROM analytics_cache WHERE fetched_at < ?').bind(new Date(at - KEEP_MS).toISOString())
        ]);
        return { status: 'ok' as const, data, updatedAt: new Date(at).toISOString(), stale: false };
    };
    if (hit && age < (force ? REFRESH_MS : freshMs)) return { status: 'ok', data: hit.data, updatedAt: new Date(hit.at).toISOString(), stale: false };
    if (hit && age < KEEP_MS && !force) {
        if (Date.now() - (refreshing.get(key) ?? 0) > 30_000) {
            refreshing.set(key, Date.now());
            ctx.exec.waitUntil(load().catch(err => console.warn(`analytics refresh ${key}: ${err?.message ?? err}`)));
        }
        return { status: 'ok', data: hit.data, updatedAt: new Date(hit.at).toISOString(), stale: true };
    }
    try {
        return await load();
    } catch (err: any) {
        if (hit) return { status: 'ok', data: hit.data, updatedAt: new Date(hit.at).toISOString(), stale: true, error: err?.message ?? String(err) };
        throw err;
    }
}

const cacheKey = (env: Env, ...parts: string[]) => ['v1', env.POSTHOG_PROJECT_ID, new URL(env.SITE_URL).host, basePath(env), signupEvent(env), ...parts].join('|');

// ---------------------------------------------------------------- the whole blog

export interface Totals {
    visitors: number;
    visits: number;
    pageviews: number;
}

export interface PostEngagement {
    /** Null: events on pages other than posts, such as the front page. */
    slug: string | null;
    views: number;
    readers: number;
    /** People who scrolled past 60% of the post. */
    finished: number;
    /** Average seconds until they got there. */
    readSeconds: number | null;
    ctaClicks: number;
    shares: number;
    subscribes: number;
}

export interface Campaign {
    campaign: string;
    source: string;
    medium: string;
    visits: number;
    visitors: number;
}

export interface WebData {
    totals: Totals;
    prevTotals: Totals | null;
    series: (Totals & { bucket: string })[];
    prevSeries: (Totals & { bucket: string })[] | null;
    pages: { path: string; visitors: number; views: number }[];
    posts: PostEngagement[];
    channels: ChannelRow[];
    campaigns: Campaign[];
    countries: { value: string; visitors: number; views: number }[];
    devices: { value: string; visitors: number; views: number }[];
    browsers: { value: string; visitors: number; views: number }[];
    os: { value: string; visitors: number; views: number }[];
    /** Product signups by the post the person read last before signing up. */
    signups: { slug: string; signups: number }[];
}

function sessionSources(sc: Scope, from: string, to: string): string {
    return `SELECT domain, internal, utm_source, utm_medium, utm_campaign, count() AS visits, uniq(person) AS visitors
FROM (
  SELECT $session_id AS session,
    argMin(person_id, timestamp) AS person,
    argMin(coalesce(properties.$referring_domain, ''), timestamp) AS domain,
    argMin(${internalRef(sc)}, timestamp) AS internal,
    argMin(coalesce(properties.utm_source, ''), timestamp) AS utm_source,
    argMin(coalesce(properties.utm_medium, ''), timestamp) AS utm_medium,
    argMin(coalesce(properties.utm_campaign, ''), timestamp) AS utm_campaign
  FROM events
  WHERE event = '$pageview' AND ${onBlog(sc)} AND $session_id != ''
    AND timestamp >= ${time(from)} AND timestamp < ${time(to)}
  GROUP BY session
)
GROUP BY domain, internal, utm_source, utm_medium, utm_campaign
ORDER BY visits DESC
LIMIT 500`;
}

type SourceRow = [unknown, unknown, unknown, unknown, unknown, unknown, unknown];

function sources(rows: unknown[][], root: string): { channels: ChannelRow[]; campaigns: Campaign[] } {
    const typed = rows as SourceRow[];
    const origins = typed.map(([domain, internal, utmSource, utmMedium, , visits, visitors]) => ({
        origin: { referrer: s(domain), internal: n(internal) === 1 || internal === true, utmSource: s(utmSource), utmMedium: s(utmMedium) } as Origin,
        visits: n(visits),
        visitors: n(visitors)
    }));
    const campaigns = new Map<string, Campaign>();
    for (const [, , utmSource, utmMedium, utmCampaign, visits, visitors] of typed) {
        if (!s(utmCampaign) && !s(utmSource)) continue;
        const k = `${s(utmCampaign)}\u0000${s(utmSource)}\u0000${s(utmMedium)}`;
        const c = campaigns.get(k) ?? { campaign: s(utmCampaign), source: s(utmSource), medium: s(utmMedium), visits: 0, visitors: 0 };
        c.visits += n(visits);
        c.visitors += n(visitors);
        campaigns.set(k, c);
    }
    return { channels: groupChannels(origins, root), campaigns: [...campaigns.values()].sort((a, b) => b.visits - a.visits).slice(0, 25) };
}

export async function webStats(ctx: Ctx, range: Range, force = false): Promise<Cached<WebData>> {
    const env = ctx.env;
    return cached(ctx, cacheKey(env, 'web', range.key), force, async () => {
        const sc = scopeOf(env);
        const from = range.prevStart ?? range.start;
        const current = `timestamp >= ${time(range.start)} AND timestamp < ${time(range.end)}`;
        const pageviews = `event = '$pageview' AND ${onBlog(sc)}`;
        const [totals, series, pages, posts, src, audience, signups] = await runAll(env, [
            [
                'web totals',
                `SELECT
  uniqIf(person_id, timestamp >= ${time(range.start)}) AS visitors,
  uniqIf($session_id, timestamp >= ${time(range.start)}) AS visits,
  countIf(timestamp >= ${time(range.start)}) AS pageviews,
  uniqIf(person_id, timestamp < ${time(range.prevEnd ?? range.start)}) AS prev_visitors,
  uniqIf($session_id, timestamp < ${time(range.prevEnd ?? range.start)}) AS prev_visits,
  countIf(timestamp < ${time(range.prevEnd ?? range.start)}) AS prev_pageviews
FROM events
WHERE ${pageviews} AND timestamp >= ${time(from)} AND timestamp < ${time(range.end)}`
            ],
            [
                'web series',
                `SELECT ${bucket(range.unit)} AS bucket, uniq(person_id) AS visitors, uniq($session_id) AS visits, count() AS pageviews
FROM events
WHERE ${pageviews} AND timestamp >= ${time(from)} AND timestamp < ${time(range.end)}
GROUP BY bucket
ORDER BY bucket
LIMIT 5000`
            ],
            [
                'web pages',
                `SELECT properties.$pathname AS path, uniq(person_id) AS visitors, count() AS views
FROM events
WHERE ${pageviews} AND ${current}
GROUP BY path
ORDER BY visitors DESC, views DESC
LIMIT 100`
            ],
            [
                'web posts',
                `SELECT properties.post_slug AS slug,
  countIf(event = 'blog_post_viewed') AS views,
  uniqIf(person_id, event = 'blog_post_viewed') AS readers,
  uniqIf(person_id, event = 'blog_post_read') AS finished,
  avgIf(toFloat(properties.seconds_on_page), event = 'blog_post_read') AS read_seconds,
  countIf(event = 'blog_cta_clicked') AS cta_clicks,
  countIf(event = 'blog_post_shared') AS shares,
  countIf(event = 'blog_subscribe_submitted') AS subscribes
FROM events
WHERE event IN (${list(BLOG_EVENTS)}) AND ${onBlog(sc)} AND ${current}
GROUP BY slug
ORDER BY readers DESC
LIMIT 500`
            ],
            ['web sources', sessionSources(sc, range.start, range.end)],
            [
                'web audience',
                `SELECT dim.1 AS kind, dim.2 AS value, uniq(person_id) AS visitors, count() AS views
FROM events
ARRAY JOIN [
  tuple('country', coalesce(properties.$geoip_country_code, '')),
  tuple('device', coalesce(properties.$device_type, '')),
  tuple('browser', coalesce(properties.$browser, '')),
  tuple('os', coalesce(properties.$os, ''))
] AS dim
WHERE ${pageviews} AND ${current}
GROUP BY kind, value
ORDER BY kind, visitors DESC
LIMIT 30 BY kind
LIMIT 1000`
            ],
            [
                'web signups',
                `SELECT properties.blog_ref_post_slug AS slug, uniq(person_id) AS signups
FROM events
WHERE event = ${str(signupEvent(env))} AND ${current}
  AND properties.blog_ref_post_slug IS NOT NULL AND properties.blog_ref_post_slug != ''
GROUP BY slug
ORDER BY signups DESC
LIMIT 100`
            ]
        ]);
        const t = totals[0] ?? [];
        const byBucket = new Map((series as unknown[][]).map(r => [s(r[0]), { visitors: n(r[1]), visits: n(r[2]), pageviews: n(r[3]) }]));
        const zero = { visitors: 0, visits: 0, pageviews: 0 };
        const dims = (kind: string) => (audience as unknown[][]).filter(r => r[0] === kind).map(r => ({ value: s(r[1]), visitors: n(r[2]), views: n(r[3]) }));
        return {
            totals: { visitors: n(t[0]), visits: n(t[1]), pageviews: n(t[2]) },
            prevTotals: range.prevStart ? { visitors: n(t[3]), visits: n(t[4]), pageviews: n(t[5]) } : null,
            series: range.buckets.map(b => ({ bucket: b, ...(byBucket.get(b) ?? zero) })),
            prevSeries: range.prevBuckets ? range.prevBuckets.map(b => ({ bucket: b, ...(byBucket.get(b) ?? zero) })) : null,
            pages: (pages as unknown[][]).map(r => ({ path: s(r[0]), visitors: n(r[1]), views: n(r[2]) })),
            posts: (posts as unknown[][]).map(r => ({
                slug: r[0] === null || r[0] === undefined || r[0] === '' ? null : s(r[0]),
                views: n(r[1]),
                readers: n(r[2]),
                finished: n(r[3]),
                readSeconds: r[4] === null || !Number.isFinite(Number(r[4])) ? null : Math.round(Number(r[4])),
                ctaClicks: n(r[5]),
                shares: n(r[6]),
                subscribes: n(r[7])
            })),
            ...sources(src, sc.root),
            countries: dims('country'),
            devices: dims('device'),
            browsers: dims('browser'),
            os: dims('os'),
            signups: (signups as unknown[][]).map(r => ({ slug: s(r[0]), signups: n(r[1]) }))
        };
    });
}

// ---------------------------------------------------------------- one post

export interface PostTotals {
    visitors: number;
    views: number;
    readers: number;
    finished: number;
    readSeconds: number | null;
    ctaClicks: number;
    shares: number;
    subscribes: number;
    signups: number;
}

export interface PostWebData {
    totals: PostTotals;
    prevTotals: PostTotals | null;
    series: { bucket: string; visitors: number; views: number }[];
    prevSeries: { bucket: string; visitors: number; views: number }[] | null;
    channels: ChannelRow[];
    campaigns: Campaign[];
}

export async function postWebStats(ctx: Ctx, slug: string, range: Range, force = false): Promise<Cached<PostWebData>> {
    const env = ctx.env;
    return cached(ctx, cacheKey(env, 'post', slug, range.key), force, async () => {
        const sc = scopeOf(env);
        const from = range.prevStart ?? range.start;
        const paths = [`${sc.base}${slug}/`, `${sc.base}${slug}`];
        const onPost = `event = '$pageview' AND ${onBlog(sc)} AND properties.$pathname IN (${list(paths)})`;
        const cur = `timestamp >= ${time(range.start)}`;
        const prev = `timestamp < ${time(range.prevEnd ?? range.start)}`;
        const signup = str(signupEvent(env));
        const metrics = (when: string) => `uniqIf(person_id, event = '$pageview' AND ${when}),
  countIf(event = '$pageview' AND ${when}),
  uniqIf(person_id, event = 'blog_post_viewed' AND ${when}),
  uniqIf(person_id, event = 'blog_post_read' AND ${when}),
  avgIf(toFloat(properties.seconds_on_page), event = 'blog_post_read' AND ${when}),
  countIf(event = 'blog_cta_clicked' AND ${when}),
  countIf(event = 'blog_post_shared' AND ${when}),
  countIf(event = 'blog_subscribe_submitted' AND ${when}),
  uniqIf(person_id, event = ${signup} AND ${when})`;
        const [totals, series, src] = await runAll(env, [
            [
                'post totals',
                `SELECT
  ${metrics(cur)},
  ${metrics(prev)}
FROM events
WHERE timestamp >= ${time(from)} AND timestamp < ${time(range.end)} AND (
  (${onPost})
  OR (event IN (${list(BLOG_EVENTS)}) AND ${onBlog(sc)} AND properties.post_slug = ${str(slug)})
  OR (event = ${signup} AND properties.blog_ref_post_slug = ${str(slug)})
)`
            ],
            [
                'post series',
                `SELECT ${bucket(range.unit)} AS bucket, uniq(person_id) AS visitors, count() AS views
FROM events
WHERE ${onPost} AND timestamp >= ${time(from)} AND timestamp < ${time(range.end)}
GROUP BY bucket
ORDER BY bucket
LIMIT 5000`
            ],
            [
                'post sources',
                `SELECT
  coalesce(properties.$referring_domain, '') AS domain,
  ${internalRef(sc)} AS internal,
  coalesce(properties.utm_source, '') AS utm_source,
  coalesce(properties.utm_medium, '') AS utm_medium,
  coalesce(properties.utm_campaign, '') AS utm_campaign,
  count() AS views,
  uniq(person_id) AS visitors
FROM events
WHERE ${onPost} AND timestamp >= ${time(range.start)} AND timestamp < ${time(range.end)}
GROUP BY domain, internal, utm_source, utm_medium, utm_campaign
ORDER BY views DESC
LIMIT 300`
            ]
        ]);
        const t = totals[0] ?? [];
        const pick = (o: number): PostTotals => ({
            visitors: n(t[o]),
            views: n(t[o + 1]),
            readers: n(t[o + 2]),
            finished: n(t[o + 3]),
            readSeconds: t[o + 4] === null || !Number.isFinite(Number(t[o + 4])) ? null : Math.round(Number(t[o + 4])),
            ctaClicks: n(t[o + 5]),
            shares: n(t[o + 6]),
            subscribes: n(t[o + 7]),
            signups: n(t[o + 8])
        });
        const byBucket = new Map((series as unknown[][]).map(r => [s(r[0]), { visitors: n(r[1]), views: n(r[2]) }]));
        const zero = { visitors: 0, views: 0 };
        return {
            totals: pick(0),
            prevTotals: range.prevStart ? pick(9) : null,
            series: range.buckets.map(b => ({ bucket: b, ...(byBucket.get(b) ?? zero) })),
            prevSeries: range.prevBuckets ? range.prevBuckets.map(b => ({ bucket: b, ...(byBucket.get(b) ?? zero) })) : null,
            ...sources(src, sc.root)
        };
    });
}
