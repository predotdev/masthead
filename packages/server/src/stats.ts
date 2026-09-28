/**
 * Newsletter and audience numbers from the database. They need nothing else
 * configured, so these parts of Analytics always work. Days are UTC days.
 */
import { classify, siteRoot, type Channel } from './channels';
import type { Env } from './env';

// ---------------------------------------------------------------- date ranges

export type RangeKey = '7' | '30' | '90' | 'all';
export type Unit = 'day' | 'week' | 'month';

export interface Range {
    key: RangeKey;
    /** Length in days; null for all time. */
    days: number | null;
    /** The first bucket's start and now. */
    start: string;
    end: string;
    /** The period before, cut at the same time of day, for "vs previous" changes. None for all time. */
    prevStart: string | null;
    prevEnd: string | null;
    unit: Unit;
    /** Bucket starts (YYYY-MM-DD) for charts, and the previous period's, bucket for bucket. */
    buckets: string[];
    prevBuckets: string[] | null;
}

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function rangeKey(v: string | null | undefined): RangeKey {
    return v === '7' || v === '90' || v === 'all' ? v : '30';
}

/** The start of the bucket a date falls in: the day, the Monday of its week, or the first of its month. */
export function bucketOf(iso: string, unit: Unit): string {
    const d = utcDay(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso));
    if (unit === 'week') return ymd(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY));
    if (unit === 'month') return `${ymd(d).slice(0, 7)}-01`;
    return ymd(d);
}

function stepBuckets(from: Date, unit: Unit, until: Date): string[] {
    const out: string[] = [];
    let d = new Date(`${bucketOf(from.toISOString(), unit)}T00:00:00Z`);
    while (d.getTime() <= until.getTime() && out.length < 5000) {
        out.push(ymd(d));
        d = unit === 'day' ? new Date(d.getTime() + DAY) : unit === 'week' ? new Date(d.getTime() + 7 * DAY) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
    return out;
}

/**
 * "7", "30" and "90" are the last N days including today, compared with the N
 * days before cut at the same time of day. "all" starts at the first recorded
 * activity and uses weeks or months when days would be too many.
 */
export function makeRange(key: RangeKey, first: string | null, now = new Date()): Range {
    const today = utcDay(now);
    if (key !== 'all') {
        const days = Number(key);
        const start = new Date(today.getTime() - (days - 1) * DAY);
        const prevStart = new Date(start.getTime() - days * DAY);
        return {
            key,
            days,
            start: start.toISOString(),
            end: now.toISOString(),
            prevStart: prevStart.toISOString(),
            prevEnd: new Date(now.getTime() - days * DAY).toISOString(),
            unit: 'day',
            buckets: stepBuckets(start, 'day', today),
            prevBuckets: stepBuckets(prevStart, 'day', new Date(start.getTime() - DAY))
        };
    }
    const firstDay = first && !Number.isNaN(Date.parse(first)) ? utcDay(new Date(first)) : new Date(today.getTime() - 29 * DAY);
    const span = Math.round((today.getTime() - Math.min(firstDay.getTime(), today.getTime())) / DAY) + 1;
    const unit: Unit = span <= 92 ? 'day' : span <= 1100 ? 'week' : 'month';
    const buckets = stepBuckets(firstDay, unit, today);
    return { key, days: null, start: `${buckets[0]}T00:00:00.000Z`, end: now.toISOString(), prevStart: null, prevEnd: null, unit, buckets, prevBuckets: null };
}

/** The earliest thing the blog has on record: a published post, a member, or a subscription change. */
export async function firstActivity(db: D1Database): Promise<string | null> {
    const row = await db
        .prepare(
            `SELECT MIN(t) AS t FROM (
               SELECT MIN(created_at) AS t FROM members
               UNION ALL SELECT MIN(published_at) FROM posts WHERE type = 'post' AND status = 'published'
               UNION ALL SELECT MIN(at) FROM member_events)`
        )
        .first<{ t: string | null }>();
    return row?.t ?? null;
}

/** Sums rows keyed by day into the range's buckets. */
function fill<T extends Record<string, number>>(buckets: string[], unit: Unit, rows: { day: string; values: T }[], zero: () => T): T[] {
    const at = new Map(buckets.map((b, i) => [b, i]));
    const out = buckets.map(zero);
    for (const r of rows) {
        const i = at.get(bucketOf(r.day, unit));
        if (i === undefined) continue;
        for (const k of Object.keys(r.values)) (out[i] as Record<string, number>)[k] += r.values[k];
    }
    return out;
}

// ---------------------------------------------------------------- audience growth

export interface MembersReport {
    range: Range;
    /** Right now. */
    subscribers: number;
    sendable: number;
    pending: number;
    /** Subscribers when the range began, from subscribe and unsubscribe history. */
    startSubscribers: number;
    totals: { newSubscribers: number; unsubscribes: number };
    prevTotals: { newSubscribers: number; unsubscribes: number } | null;
    /** Per bucket: subscribers at its end, new subscribers and unsubscribes in it. */
    series: { bucket: string; subscribers: number; newSubscribers: number; unsubscribes: number }[];
    /** How the new subscribers joined: the signup form, your product (API), staff, or an import. */
    methods: { method: string; count: number }[];
    /** Form signups by where the visit came from, the post they signed up on, and where on the page. */
    channels: { channel: Channel; count: number; sources: { source: string; count: number }[] }[];
    posts: { slug: string; id: string | null; title: string | null; count: number }[];
    placements: { placement: string; count: number }[];
    /** Form signups from before signups recorded where they came from. */
    unrecorded: number;
    /** Form signups asked for in the range and how many confirmed. */
    confirmation: { requested: number; confirmed: number };
}

export async function membersReport(env: Env, db: D1Database, range: Range): Promise<MembersReport> {
    const [counts, daily, prev, origins, confirmation] = await db.batch([
        db.prepare(`SELECT SUM(status = 'subscribed') AS subscribers, SUM(status = 'subscribed' AND suppressed IS NULL) AS sendable, SUM(status = 'pending') AS pending FROM members`),
        db
            .prepare(
                `SELECT substr(at, 1, 10) AS day, SUM(type = 'subscribed') AS subscribed, SUM(type = 'unsubscribed') AS unsubscribed
                 FROM member_events WHERE at >= ? AND type IN ('subscribed', 'unsubscribed') GROUP BY day`
            )
            .bind(range.start),
        db
            .prepare(`SELECT SUM(type = 'subscribed') AS subscribed, SUM(type = 'unsubscribed') AS unsubscribed FROM member_events WHERE at >= ? AND at < ? AND type IN ('subscribed', 'unsubscribed')`)
            .bind(range.prevStart ?? range.end, range.prevEnd ?? range.end),
        db
            .prepare(
                `SELECT e.source AS method, m.attribution IS NOT NULL AS known,
                   json_extract(m.attribution, '$.post') AS post, json_extract(m.attribution, '$.placement') AS placement,
                   json_extract(m.attribution, '$.referrer') AS referrer, json_extract(m.attribution, '$.utmSource') AS utm_source,
                   json_extract(m.attribution, '$.utmMedium') AS utm_medium, COUNT(*) AS n
                 FROM member_events e LEFT JOIN members m ON m.id = e.member_id
                 WHERE e.type = 'subscribed' AND e.at >= ?
                 GROUP BY 1, 2, 3, 4, 5, 6, 7`
            )
            .bind(range.start),
        db.prepare(`SELECT COUNT(*) AS requested, SUM(status = 'subscribed') AS confirmed FROM members WHERE attribution IS NOT NULL AND json_extract(attribution, '$.at') >= ?`).bind(range.start)
    ]);
    const now = (counts.results[0] ?? {}) as Record<string, number | null>;
    const subscribers = Number(now.subscribers ?? 0);
    const days = (daily.results as { day: string; subscribed: number; unsubscribed: number }[]).map(r => ({ day: r.day, sub: Number(r.subscribed), unsub: Number(r.unsubscribed) }));

    // Walk back from today's count: subscribers at the end of a bucket are today's minus every change after it.
    const perBucket = fill(
        range.buckets,
        range.unit,
        days.map(d => ({ day: d.day, values: { newSubscribers: d.sub, unsubscribes: d.unsub } })),
        () => ({ newSubscribers: 0, unsubscribes: 0 })
    );
    let after = 0;
    const series = range.buckets
        .map((bucket, i) => ({ bucket, ...perBucket[i] }))
        .reverse()
        .map(b => {
            const row = { ...b, subscribers: Math.max(0, subscribers - after) };
            after += b.newSubscribers - b.unsubscribes;
            return row;
        })
        .reverse();
    const totals = { newSubscribers: days.reduce((n, d) => n + d.sub, 0), unsubscribes: days.reduce((n, d) => n + d.unsub, 0) };
    const p = (prev.results[0] ?? {}) as Record<string, number | null>;

    // Where new subscribers came from.
    const methods = new Map<string, number>();
    const channels = new Map<Channel, Map<string, number>>();
    const posts = new Map<string, number>();
    const placements = new Map<string, number>();
    let unrecorded = 0;
    const root = siteRoot(new URL(env.SITE_URL).hostname);
    for (const r of origins.results as {
        method: string;
        known: number;
        post: string | null;
        placement: string | null;
        referrer: string | null;
        utm_source: string | null;
        utm_medium: string | null;
        n: number;
    }[]) {
        const n = Number(r.n);
        methods.set(r.method, (methods.get(r.method) ?? 0) + n);
        if (r.method !== 'member') continue;
        if (!r.known) {
            unrecorded += n;
            continue;
        }
        const { channel, source } = classify({ referrer: r.referrer, utmSource: r.utm_source, utmMedium: r.utm_medium }, root);
        const sources = channels.get(channel) ?? new Map<string, number>();
        sources.set(source, (sources.get(source) ?? 0) + n);
        channels.set(channel, sources);
        if (r.post) posts.set(r.post, (posts.get(r.post) ?? 0) + n);
        placements.set(r.placement || 'page', (placements.get(r.placement || 'page') ?? 0) + n);
    }
    const topPosts = [...posts].sort((a, b) => b[1] - a[1]).slice(0, 20);
    const titles = await postsBySlug(
        db,
        topPosts.map(([slug]) => slug)
    );
    const c = (confirmation.results[0] ?? {}) as Record<string, number | null>;

    return {
        range,
        subscribers,
        sendable: Number(now.sendable ?? 0),
        pending: Number(now.pending ?? 0),
        startSubscribers: Math.max(0, subscribers - (totals.newSubscribers - totals.unsubscribes)),
        totals,
        prevTotals: range.prevStart ? { newSubscribers: Number(p.subscribed ?? 0), unsubscribes: Number(p.unsubscribed ?? 0) } : null,
        series,
        methods: [...methods].map(([method, count]) => ({ method, count })).sort((a, b) => b.count - a.count),
        channels: [...channels]
            .map(([channel, sources]) => ({
                channel,
                count: [...sources.values()].reduce((a, b) => a + b, 0),
                sources: [...sources].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count)
            }))
            .sort((a, b) => b.count - a.count),
        posts: topPosts.map(([slug, count]) => ({ slug, count, id: titles.get(slug)?.id ?? null, title: titles.get(slug)?.title ?? null })),
        placements: [...placements].map(([placement, count]) => ({ placement, count })).sort((a, b) => b.count - a.count),
        unrecorded,
        confirmation: { requested: Number(c.requested ?? 0), confirmed: Number(c.confirmed ?? 0) }
    };
}

/** Titles and ids for post slugs, e.g. from analytics events. */
export async function postsBySlug(db: D1Database, slugs: string[]): Promise<Map<string, { id: string; title: string; type: string }>> {
    const out = new Map<string, { id: string; title: string; type: string }>();
    // D1 allows 100 bound values per statement.
    for (let i = 0; i < slugs.length; i += 90) {
        const chunk = slugs.slice(i, i + 90);
        if (!chunk.length) continue;
        const { results } = await db
            .prepare(`SELECT id, slug, title, type FROM posts WHERE slug IN (${chunk.map(() => '?').join(',')})`)
            .bind(...chunk)
            .all<{ id: string; slug: string; title: string; type: string }>();
        for (const r of results) out.set(r.slug, { id: r.id, title: r.title, type: r.type });
    }
    return out;
}

// ---------------------------------------------------------------- newsletters

export interface SendRow {
    /** The send here; null for a newsletter Ghost sent before the move. */
    id: string | null;
    postId: string | null;
    slug: string | null;
    title: string;
    subject: string;
    at: string;
    source: 'masthead' | 'ghost';
    sent: number;
    delivered: number | null;
    /** People, not events: each person counts once however often they open or click. */
    opened: number | null;
    clicked: number | null;
    bounced: number | null;
    complained: number | null;
    unsubscribed: number | null;
    openRate: number | null;
    clickRate: number | null;
}

export interface EmailTotals {
    sends: number;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    unsubscribed: number;
    bounced: number;
    complained: number;
    openRate: number | null;
    clickRate: number | null;
    unsubscribeRate: number | null;
}

export interface EmailReport {
    range: Range;
    /** Delivery, open and click events arrive from the email provider's webhook. */
    webhooks: boolean;
    totals: EmailTotals;
    prevTotals: EmailTotals | null;
    sends: SendRow[];
    links: { url: string; people: number; clicks: number }[];
    /** Test-mode sends in the range, which are left out. */
    testSends: number;
}

const SEND_COLUMNS = `s.id, s.post_id, s.subject, s.sent, s.delivered, s.bounced, s.complained, s.unique_opens, s.unique_clicks, s.unsubscribed,
    COALESCE(s.started_at, s.created_at) AS at, p.title AS post_title, p.slug AS post_slug`;

function sendRow(r: any): SendRow {
    const delivered = Number(r.delivered ?? 0);
    return {
        id: r.id,
        postId: r.post_id,
        slug: r.post_slug ?? null,
        title: r.post_title ?? r.subject,
        subject: r.subject,
        at: r.at,
        source: 'masthead',
        sent: Number(r.sent ?? 0),
        delivered,
        opened: Number(r.unique_opens ?? 0),
        clicked: Number(r.unique_clicks ?? 0),
        bounced: Number(r.bounced ?? 0),
        complained: Number(r.complained ?? 0),
        unsubscribed: Number(r.unsubscribed ?? 0),
        openRate: delivered ? Number(r.unique_opens ?? 0) / delivered : null,
        clickRate: delivered ? Number(r.unique_clicks ?? 0) / delivered : null
    };
}

/** A newsletter Ghost sent, with the numbers Ghost recorded (it kept no clicks or unsubscribes per email). */
function ghostRow(p: { id: string; slug: string; title: string; newsletter: unknown }): SendRow | null {
    let n: { sentAt?: string | null; recipients?: number; delivered?: number; opened?: number } | null;
    try {
        n = typeof p.newsletter === 'string' ? JSON.parse(p.newsletter) : (p.newsletter as typeof n);
    } catch {
        return null;
    }
    if (!n?.sentAt) return null;
    const delivered = Number(n.delivered ?? 0);
    return {
        id: null,
        postId: p.id,
        slug: p.slug,
        title: p.title,
        subject: p.title,
        at: n.sentAt,
        source: 'ghost',
        sent: Number(n.recipients ?? 0),
        delivered,
        opened: Number(n.opened ?? 0),
        clicked: null,
        bounced: null,
        complained: null,
        unsubscribed: null,
        openRate: delivered ? Number(n.opened ?? 0) / delivered : null,
        clickRate: null
    };
}

/** Rates are weighted by delivered emails, counting only sends that recorded them. */
export function emailTotals(rows: SendRow[]): EmailTotals {
    const t = { sends: rows.length, sent: 0, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0, bounced: 0, complained: 0 };
    let openBase = 0;
    let clickBase = 0;
    let unsubscribeBase = 0;
    for (const r of rows) {
        t.sent += r.sent;
        t.delivered += r.delivered ?? 0;
        t.bounced += r.bounced ?? 0;
        t.complained += r.complained ?? 0;
        if (r.delivered && r.opened !== null) (t.opened += r.opened), (openBase += r.delivered);
        if (r.delivered && r.clicked !== null) (t.clicked += r.clicked), (clickBase += r.delivered);
        if (r.delivered && r.unsubscribed !== null) (t.unsubscribed += r.unsubscribed), (unsubscribeBase += r.delivered);
    }
    return {
        ...t,
        openRate: openBase ? t.opened / openBase : null,
        clickRate: clickBase ? t.clicked / clickBase : null,
        unsubscribeRate: unsubscribeBase ? t.unsubscribed / unsubscribeBase : null
    };
}

export async function emailReport(env: Env, db: D1Database, range: Range): Promise<EmailReport> {
    const from = range.prevStart ?? range.start;
    const [sends, ghost, tests, links] = await db.batch([
        db
            .prepare(`SELECT ${SEND_COLUMNS} FROM sends s LEFT JOIN posts p ON p.id = s.post_id WHERE s.test_mode = 0 AND s.sent > 0 AND COALESCE(s.started_at, s.created_at) >= ? ORDER BY at DESC`)
            .bind(from),
        db.prepare(
            `SELECT id, slug, title, newsletter FROM posts WHERE newsletter IS NOT NULL
             AND id NOT IN (SELECT post_id FROM sends WHERE test_mode = 0 AND sent > 0)`
        ),
        db.prepare('SELECT COUNT(*) AS n FROM sends WHERE test_mode = 1 AND COALESCE(started_at, created_at) >= ?').bind(range.start),
        db
            .prepare(
                `SELECT url, COUNT(DISTINCT member_id) AS people, COUNT(*) AS clicks FROM email_events
                 WHERE type = 'clicked' AND url IS NOT NULL
                   AND send_id IN (SELECT id FROM sends WHERE test_mode = 0 AND COALESCE(started_at, created_at) >= ?)
                 GROUP BY url ORDER BY people DESC, clicks DESC LIMIT 15`
            )
            .bind(range.start)
    ]);
    const all = [...(sends.results as any[]).map(sendRow), ...(ghost.results as any[]).map(ghostRow).filter((r): r is SendRow => r !== null && r.at >= from)].sort((a, b) => b.at.localeCompare(a.at));
    const current = all.filter(r => r.at >= range.start);
    const earlier = range.prevStart ? all.filter(r => r.at >= range.prevStart! && r.at < range.prevEnd!) : null;
    return {
        range,
        webhooks: Boolean(env.RESEND_WEBHOOK_SECRET),
        totals: emailTotals(current),
        prevTotals: earlier ? emailTotals(earlier) : null,
        sends: current,
        links: (links.results as any[]).map(r => ({ url: String(r.url), people: Number(r.people), clicks: Number(r.clicks) })),
        testSends: Number((tests.results[0] as any)?.n ?? 0)
    };
}

// ---------------------------------------------------------------- one post

export interface PostReport {
    post: { id: string; slug: string; title: string; type: string; status: string; publishedAt: string | null; url: string };
    range: Range;
    /** Its newsletter: every send of it here, or what Ghost recorded. */
    newsletter: { sends: SendRow[]; totals: EmailTotals; links: { url: string; people: number; clicks: number }[] } | null;
    /** People who signed up on this post, in the range, by where their visit came from. */
    members: { requested: number; confirmed: number; prevRequested: number | null; channels: { channel: Channel; count: number }[] };
}

export async function postReport(
    env: Env,
    db: D1Database,
    post: { id: string; slug: string; title: string; type: string; status: string; publishedAt: string | null; newsletter?: unknown },
    range: Range
): Promise<PostReport> {
    const [sends, links, signups] = await db.batch([
        db.prepare(`SELECT ${SEND_COLUMNS} FROM sends s LEFT JOIN posts p ON p.id = s.post_id WHERE s.post_id = ? AND s.test_mode = 0 AND s.sent > 0 ORDER BY at DESC`).bind(post.id),
        db
            .prepare(
                `SELECT url, COUNT(DISTINCT member_id) AS people, COUNT(*) AS clicks FROM email_events
                 WHERE type = 'clicked' AND url IS NOT NULL AND send_id IN (SELECT id FROM sends WHERE post_id = ? AND test_mode = 0)
                 GROUP BY url ORDER BY people DESC, clicks DESC LIMIT 10`
            )
            .bind(post.id),
        db
            .prepare(
                `SELECT json_extract(attribution, '$.at') AS at, status, json_extract(attribution, '$.referrer') AS referrer,
                   json_extract(attribution, '$.utmSource') AS utm_source, json_extract(attribution, '$.utmMedium') AS utm_medium
                 FROM members WHERE attribution IS NOT NULL AND json_extract(attribution, '$.post') = ? AND json_extract(attribution, '$.at') >= ?`
            )
            .bind(post.slug, range.prevStart ?? range.start)
    ]);
    let rows = (sends.results as any[]).map(sendRow);
    if (!rows.length && post.newsletter) {
        const g = ghostRow({ id: post.id, slug: post.slug, title: post.title, newsletter: post.newsletter });
        if (g) rows = [g];
    }
    const root = siteRoot(new URL(env.SITE_URL).hostname);
    const people = signups.results as { at: string; status: string; referrer: string | null; utm_source: string | null; utm_medium: string | null }[];
    const inRange = people.filter(p => p.at >= range.start);
    const channels = new Map<Channel, number>();
    for (const p of inRange) {
        const { channel } = classify({ referrer: p.referrer, utmSource: p.utm_source, utmMedium: p.utm_medium }, root);
        channels.set(channel, (channels.get(channel) ?? 0) + 1);
    }
    const siteUrl = env.SITE_URL.endsWith('/') ? env.SITE_URL : `${env.SITE_URL}/`;
    return {
        post: { id: post.id, slug: post.slug, title: post.title, type: post.type, status: post.status, publishedAt: post.publishedAt, url: `${siteUrl}${post.slug}/` },
        range,
        newsletter: rows.length
            ? { sends: rows, totals: emailTotals(rows), links: (links.results as any[]).map(r => ({ url: String(r.url), people: Number(r.people), clicks: Number(r.clicks) })) }
            : null,
        members: {
            requested: inRange.length,
            confirmed: inRange.filter(p => p.status === 'subscribed').length,
            prevRequested: range.prevStart ? people.filter(p => p.at < range.prevEnd! && p.at >= range.prevStart!).length : null,
            channels: [...channels].map(([channel, count]) => ({ channel, count })).sort((a, b) => b.count - a.count)
        }
    };
}
