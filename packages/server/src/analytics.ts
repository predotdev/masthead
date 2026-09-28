/**
 * PostHog: the pages' analytics config, events the server records (they
 * complete what a reader started in the browser), and the stats the admin
 * shows writers. All optional: without POSTHOG_KEY nothing is loaded or sent.
 */
import type { AnalyticsConfig } from '@masthead/core';
import type { Env } from './env';

const DEFAULT_HOST = 'https://us.i.posthog.com';

export function analyticsConfig(env: Env): AnalyticsConfig | undefined {
    if (!env.POSTHOG_KEY) return undefined;
    return {
        posthog: {
            key: env.POSTHOG_KEY,
            host: (env.POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, ''),
            canonicalHost: new URL(env.SITE_URL).hostname.replace(/^www\./, ''),
            trackPreview: env.POSTHOG_TRACK_PREVIEW === 'true'
        }
    };
}

/** The id a reader's browser analytics used, if the form sent one we can trust the shape of. */
export function cleanAnalyticsId(v: unknown): string | null {
    return typeof v === 'string' && /^[\w.:@$-]{1,200}$/.test(v) ? v : null;
}

/** Server events join the reader's visit when we have their browser id, else they are keyed by email, as the product does. */
export function distinctId(member: { analytics_id?: string | null; analyticsId?: string | null; email: string }): string {
    return member.analyticsId || member.analytics_id || `email:${member.email.toLowerCase()}`;
}

/**
 * Records one server event. Never throws and never delays the response: pass
 * the ExecutionContext's waitUntil. Previews are skipped unless tracked.
 */
export function capture(
    env: Env,
    waitUntil: (p: Promise<unknown>) => void,
    event: string,
    id: string,
    properties: Record<string, unknown> = {},
    person: { set?: Record<string, unknown>; setOnce?: Record<string, unknown> } = {}
): void {
    if (!env.POSTHOG_KEY) return;
    const host = (env.POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, '');
    const body = {
        api_key: env.POSTHOG_KEY,
        event,
        distinct_id: id,
        timestamp: new Date().toISOString(),
        // The server's own IP would otherwise overwrite the reader's location on their person.
        properties: { ...properties, source: 'server', app: 'masthead', $geoip_disable: true, ...(person.set ? { $set: person.set } : {}), ...(person.setOnce ? { $set_once: person.setOnce } : {}) }
    };
    waitUntil(
        fetch(`${host}/i/v0/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
            .then(r => (r.ok ? undefined : console.warn(`posthog capture ${event}: HTTP ${r.status}`)))
            .catch(err => console.warn(`posthog capture ${event}: ${err?.message ?? err}`))
    );
}

// ---------------------------------------------------------------- stats for writers

export interface PostStats {
    slug: string;
    views: number;
    readers: number;
    reads: number;
    ctaClicks: number;
    subscribes: number;
}

export interface SiteStats {
    configured: boolean;
    days: number;
    posts: PostStats[];
    daily: { day: string; views: number; readers: number }[];
    sources: { source: string; views: number }[];
    /** People who viewed a post and later signed up for the product (auth_signup_success carrying blog_ref_post_slug). */
    signups: { slug: string; signups: number }[];
    updatedAt: string;
}

const cache = new Map<string, { at: number; stats: SiteStats }>();

async function hogql<T extends unknown[]>(env: Env, query: string): Promise<T[]> {
    const host = (env.POSTHOG_HOST || DEFAULT_HOST).replace('.i.posthog.com', '.posthog.com').replace(/\/+$/, '');
    const res = await fetch(`${host}/api/projects/${encodeURIComponent(env.POSTHOG_PROJECT_ID!)}/query/`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
        signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) throw new Error(`PostHog answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { results?: T[] }).results ?? [];
}

/** Per-post and site stats from PostHog, cached for ten minutes. */
export async function siteStats(env: Env, days = 30): Promise<SiteStats> {
    const empty: SiteStats = { configured: false, days, posts: [], daily: [], sources: [], signups: [], updatedAt: new Date().toISOString() };
    if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) return empty;
    const d = Math.max(1, Math.min(365, Math.floor(days)));
    const key = `${d}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 600_000) return hit.stats;
    const since = `timestamp > now() - INTERVAL ${d} DAY AND properties.environment = 'production'`;
    const [posts, daily, sources, signups] = await Promise.all([
        hogql<[string, number, number, number, number, number]>(
            env,
            `SELECT properties.post_slug AS slug,
                countIf(event = 'blog_post_viewed') AS views,
                uniqIf(person_id, event = 'blog_post_viewed') AS readers,
                countIf(event = 'blog_post_read') AS reads,
                countIf(event = 'blog_cta_clicked') AS cta_clicks,
                countIf(event = 'blog_subscribe_submitted') AS subscribes
             FROM events
             WHERE ${since} AND event IN ('blog_post_viewed', 'blog_post_read', 'blog_cta_clicked', 'blog_subscribe_submitted') AND properties.post_slug IS NOT NULL
             GROUP BY slug ORDER BY views DESC LIMIT 500`
        ),
        hogql<[string, number, number]>(
            env,
            `SELECT toString(toDate(timestamp)) AS day, count() AS views, uniq(person_id) AS readers
             FROM events WHERE ${since} AND event = 'blog_post_viewed' GROUP BY day ORDER BY day`
        ),
        hogql<[string, number]>(
            env,
            `SELECT coalesce(nullIf(properties.$referring_domain, ''), '$direct') AS source, count() AS views
             FROM events WHERE ${since} AND event = 'blog_post_viewed' GROUP BY source ORDER BY views DESC LIMIT 12`
        ),
        hogql<[string, number]>(
            env,
            `SELECT properties.blog_ref_post_slug AS slug, uniq(person_id) AS signups
             FROM events WHERE timestamp > now() - INTERVAL ${d} DAY AND event = 'auth_signup_success' AND properties.blog_ref_post_slug IS NOT NULL
             GROUP BY slug ORDER BY signups DESC LIMIT 100`
        )
    ]);
    const stats: SiteStats = {
        configured: true,
        days: d,
        posts: posts.map(([slug, views, readers, reads, ctaClicks, subscribes]) => ({ slug, views: Number(views), readers: Number(readers), reads: Number(reads), ctaClicks: Number(ctaClicks), subscribes: Number(subscribes) })),
        daily: daily.map(([day, views, readers]) => ({ day, views: Number(views), readers: Number(readers) })),
        sources: sources.map(([source, views]) => ({ source, views: Number(views) })),
        signups: signups.map(([slug, n]) => ({ slug, signups: Number(n) })),
        updatedAt: new Date().toISOString()
    };
    cache.set(key, { at: Date.now(), stats });
    return stats;
}
