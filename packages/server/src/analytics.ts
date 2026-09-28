/**
 * PostHog: the pages' analytics config and the events the server records (they
 * complete what a reader started in the browser). The admin reads the numbers
 * back in posthog.ts. All optional: without POSTHOG_KEY nothing is loaded or sent.
 */
import type { AnalyticsConfig } from '@masthead/core';
import type { Env } from './env';

const DEFAULT_HOST = 'https://us.i.posthog.com';

export function analyticsConfig(env: Env): AnalyticsConfig | undefined {
    if (!env.POSTHOG_KEY) return undefined;
    const site = new URL(env.SITE_URL);
    return {
        posthog: {
            key: env.POSTHOG_KEY,
            host: (env.POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, ''),
            canonicalHost: site.hostname.replace(/^www\./, ''),
            canonicalPath: site.pathname.endsWith('/') ? site.pathname : `${site.pathname}/`,
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
