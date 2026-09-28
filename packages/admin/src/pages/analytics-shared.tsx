import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, base, session } from '../api';
import { BarList, fmtInt, pct, shortDate, type BarItem, type Unit } from '../charts';
import { Pill } from '../ui';

// ------------------------------------------------------------------ what the server answers

export type RangeKey = '7' | '30' | '90' | 'all';

export interface Range {
    key: RangeKey;
    days: number | null;
    start: string;
    end: string;
    prevStart: string | null;
    prevEnd: string | null;
    unit: Unit;
    buckets: string[];
    prevBuckets: string[] | null;
}

export interface Setup {
    tracking: boolean;
    key: boolean;
    project: boolean;
    app: string;
}

export interface ChannelRow {
    channel: string;
    visits: number;
    visitors: number;
    sources: { source: string; visits: number; visitors: number }[];
}

export interface Campaign {
    campaign: string;
    source: string;
    medium: string;
    visits: number;
    visitors: number;
}

/** A PostHog-backed answer: off (not connected), error, or ok with data, possibly a few minutes old. */
export interface FromPosthog<T> {
    status: 'ok' | 'off' | 'error';
    setup: Setup;
    range: Range;
    error?: string;
    updatedAt?: string;
    stale?: boolean;
    data?: T;
}

interface Totals {
    visitors: number;
    visits: number;
    pageviews: number;
}

interface Dim {
    value: string;
    visitors: number;
    views: number;
}

export interface WebData {
    totals: Totals;
    prevTotals: Totals | null;
    series: (Totals & { bucket: string })[];
    prevSeries: (Totals & { bucket: string })[] | null;
    pages: { path: string; visitors: number; views: number }[];
    posts: { slug: string | null; views: number; readers: number; finished: number; readSeconds: number | null; ctaClicks: number; shares: number; subscribes: number }[];
    channels: ChannelRow[];
    campaigns: Campaign[];
    countries: Dim[];
    devices: Dim[];
    browsers: Dim[];
    os: Dim[];
    signups: { slug: string; signups: number }[];
}

export type WebReport = FromPosthog<WebData> & { titles?: Record<string, { id: string; title: string; type: string }> };

export interface SendRow {
    id: string | null;
    postId: string | null;
    slug: string | null;
    title: string;
    subject: string;
    at: string;
    source: 'masthead' | 'ghost';
    sent: number;
    delivered: number | null;
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
    webhooks: boolean;
    totals: EmailTotals;
    prevTotals: EmailTotals | null;
    sends: SendRow[];
    links: { url: string; people: number; clicks: number }[];
    testSends: number;
}

export interface MembersReport {
    range: Range;
    subscribers: number;
    sendable: number;
    pending: number;
    startSubscribers: number;
    totals: { newSubscribers: number; unsubscribes: number };
    prevTotals: { newSubscribers: number; unsubscribes: number } | null;
    series: { bucket: string; subscribers: number; newSubscribers: number; unsubscribes: number }[];
    methods: { method: string; count: number }[];
    channels: { channel: string; count: number; sources: { source: string; count: number }[] }[];
    posts: { slug: string; id: string | null; title: string | null; count: number }[];
    placements: { placement: string; count: number }[];
    unrecorded: number;
    confirmation: { requested: number; confirmed: number };
}

// ------------------------------------------------------------------ shared pieces

const RANGES: { key: RangeKey; label: string }[] = [
    { key: '7', label: '7 days' },
    { key: '30', label: '30 days' },
    { key: '90', label: '90 days' },
    { key: 'all', label: 'All time' }
];

const reports = new Map<string, { at: number; data: unknown }>();

/**
 * Loads a report and keeps the last one on screen (dimmed) while the next loads,
 * so changing the range never flashes. Answers are reused for a minute across tabs.
 */
export function useReport<T>(path: string | null) {
    const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>(() => {
        const hit = path ? reports.get(path) : undefined;
        return { data: (hit?.data as T) ?? null, error: null, loading: Boolean(path) && !hit };
    });
    const latest = useRef(path);
    const load = useCallback(
        (refresh = false) => {
            latest.current = path;
            if (!path) return;
            const hit = reports.get(path);
            if (hit && !refresh && Date.now() - hit.at < 60_000) {
                setState({ data: hit.data as T, error: null, loading: false });
                return;
            }
            setState(s => ({ ...s, loading: true }));
            api<T>(refresh ? `${path}${path.includes('?') ? '&' : '?'}refresh=1` : path)
                .then(data => {
                    reports.set(path, { at: Date.now(), data });
                    if (latest.current === path) setState({ data, error: null, loading: false });
                })
                .catch(err => latest.current === path && setState(s => ({ ...s, error: err?.message ?? String(err), loading: false })));
        },
        [path]
    );
    useEffect(() => load(), [load]);
    // A few-minutes-old PostHog answer is being refreshed on the server: pick up the fresh one shortly.
    const stale = (state.data as { stale?: boolean; error?: string } | null)?.stale && !(state.data as { error?: string }).error;
    useEffect(() => {
        if (!stale || !path) return;
        const t = setTimeout(() => (reports.delete(path), load()), 8000);
        return () => clearTimeout(t);
    }, [stale, path]);
    return { ...state, reload: load };
}

export const vsText = (r: Range | undefined) => (r?.days ? `vs the ${r.days} days before` : '');
export const periodText = (r: Range | undefined) => (!r ? '' : r.days ? `the last ${r.days} days` : 'all time');

export function ago(iso: string): string {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
    return shortDate(iso);
}

export const isEditor = () => ['owner', 'admin', 'editor'].includes(session.value?.user.role ?? '');

/** The range picker, and when the PostHog numbers are from. */
export function Toolbar({ range, setRange, web, onRefresh }: { range: RangeKey; setRange: (r: RangeKey) => void; web?: FromPosthog<unknown> | null; onRefresh?: () => void }) {
    return (
        <div class="an-toolbar">
            <div class="an-toolbar-range">
                <div class="tabs" role="tablist" aria-label="Date range">
                    {RANGES.map(r => (
                        <button key={r.key} type="button" role="tab" aria-selected={r.key === range} class={`tab ${r.key === range ? 'on' : ''}`} onClick={() => setRange(r.key)}>
                            {r.label}
                        </button>
                    ))}
                </div>
                {range !== 'all' ? <span class="an-updated">Changes compare with the {range} days before.</span> : null}
            </div>
            {web?.status === 'ok' && web.updatedAt ? (
                <span class="an-updated">
                    Traffic from PostHog, {ago(web.updatedAt)}
                    {web.stale && !web.error ? ', updating' : ''}
                    {onRefresh ? (
                        <>
                            {' · '}
                            <button type="button" class="link-btn" onClick={onRefresh}>
                                Refresh
                            </button>
                        </>
                    ) : null}
                </span>
            ) : null}
        </div>
    );
}

export function Panel({ title, action, children, wide }: { title: string; action?: ComponentChildren; children: ComponentChildren; wide?: boolean }) {
    return (
        <section class={`panel an-panel ${wide ? 'wide' : ''}`}>
            <div class="an-panel-head">
                <h2>{title}</h2>
                {action}
            </div>
            {children}
        </section>
    );
}

/** Two or three views of one panel, e.g. channels and the sites within them. */
export function Switch<K extends string>({ value, options, onChange, label }: { value: K; options: [K, string][]; onChange: (k: K) => void; label: string }) {
    return (
        <div class="an-switch" role="tablist" aria-label={label}>
            {options.map(([k, text]) => (
                <button key={k} type="button" role="tab" aria-selected={k === value} class={k === value ? 'on' : ''} onClick={() => onChange(k)}>
                    {text}
                </button>
            ))}
        </div>
    );
}

export function channelName(channel: string): string {
    const host = (() => {
        try {
            return new URL(session.value?.site.url ?? location.href).hostname.replace(/^www\./, '');
        } catch {
            return 'Your site';
        }
    })();
    return (
        (
            {
                search: 'Search',
                ai: 'AI assistants',
                social: 'Social',
                email: 'Email',
                site: `${host} (your site)`,
                blog: 'Blog pages',
                direct: 'Direct',
                other: 'Other sites'
            } as Record<string, string>
        )[channel] ?? channel
    );
}

export function ChannelList({ channels, measure = 'visits' }: { channels: ChannelRow[]; measure?: 'visits' | 'visitors' }) {
    const [view, setView] = useState<'channels' | 'sources'>('channels');
    const total = channels.reduce((n, c) => n + c[measure], 0);
    const items: BarItem[] =
        view === 'channels'
            ? channels.map(c => ({
                  key: c.channel,
                  label: channelName(c.channel),
                  value: c[measure],
                  title: c.sources
                      .slice(0, 5)
                      .map(s => s.source)
                      .join(', ')
              }))
            : channels
                  .flatMap(c => c.sources.map(s => ({ ...s, channel: c.channel })))
                  .sort((a, b) => b[measure] - a[measure])
                  .map(s => ({
                      key: `${s.channel}:${s.source}`,
                      label: (
                          <>
                              {s.source}
                              <span class="an-tag">{channelName(s.channel)}</span>
                          </>
                      ),
                      value: s[measure]
                  }));
    return (
        <>
            <Switch
                label="Group sources"
                value={view}
                onChange={setView}
                options={[
                    ['channels', 'Channels'],
                    ['sources', 'Sites']
                ]}
            />
            <BarList items={items} total={total} empty="No visits in this period." />
        </>
    );
}

/** How to connect PostHog: what is set already, and the two settings that are left. */
export function ConnectPosthog({ setup, brief }: { setup: Setup; brief?: boolean }) {
    if (brief)
        return (
            <div class="an-connect brief">
                <span class="an-connect-mark" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 3v18h18" />
                        <path d="m7 15 4-4 3 3 5-6" />
                    </svg>
                </span>
                <span>
                    <b>See your readers here.</b> Connect PostHog for visitors, sources, countries and read-through. Newsletters and growth already work.
                </span>
                <a class="btn ghost" href="#/analytics/traffic">
                    Connect PostHog
                </a>
            </div>
        );
    const steps: { done: boolean; title: string; body: ComponentChildren }[] = [
        {
            done: setup.tracking,
            title: 'Pages send events',
            body: (
                <>
                    Set <code>POSTHOG_KEY</code> to your project key (<code>phc_…</code>) under <code>[vars]</code>. The theme then records views, reads, clicks into your product, shares and signups.
                </>
            )
        },
        {
            done: setup.key,
            title: 'A key that can read them',
            body: (
                <>
                    In PostHog, create a{' '}
                    <a href={`${setup.app}/settings/user-api-keys`} target="_blank" rel="noreferrer">
                        personal API key
                    </a>{' '}
                    with <b>Query: read</b> access to this project, then store it as a secret:
                    <Command text="npx wrangler secret put POSTHOG_PERSONAL_API_KEY" />
                </>
            )
        },
        {
            done: setup.project,
            title: 'Which project to read',
            body: (
                <>
                    The number in your PostHog project's address, under <code>[vars]</code> in <code>wrangler.toml</code>, then deploy:
                    <Command text={'POSTHOG_PROJECT_ID = "12345"'} />
                </>
            )
        }
    ];
    return (
        <section class="an-connect">
            <div class="an-connect-copy">
                <h2>Connect PostHog to see your readers</h2>
                <p class="muted">Pages can send what readers do to PostHog. Two settings let this page read it back, kept for ten minutes at a time so PostHog is asked rarely.</p>
                <ol class="an-steps">
                    {steps.map((st, i) => (
                        <li key={st.title} class={st.done ? 'done' : ''}>
                            <span class="an-step-mark" aria-hidden="true">
                                {st.done ? '✓' : i + 1}
                            </span>
                            <div>
                                <b>{st.title}</b>
                                {st.done ? <span class="an-step-done">Set</span> : null}
                                <div class="muted small an-step-body">{st.body}</div>
                            </div>
                        </li>
                    ))}
                </ol>
            </div>
            <div class="an-connect-side">
                <svg class="an-preview" viewBox="0 0 240 64" preserveAspectRatio="none" aria-hidden="true">
                    <path class="an-preview-fill" d="M0,50 C20,46 30,40 48,42 S80,30 100,33 S130,18 150,24 S190,10 210,14 S232,6 240,4 V64 H0 Z" />
                    <path class="an-preview-line" d="M0,50 C20,46 30,40 48,42 S80,30 100,33 S130,18 150,24 S190,10 210,14 S232,6 240,4" />
                </svg>
                <b>What you will see</b>
                <ul class="an-gets">
                    <li>Visitors, visits and pageviews, day by day, against the period before</li>
                    <li>Where they came from: search, AI assistants, social, email, your own site</li>
                    <li>Countries, devices and browsers</li>
                    <li>How many read each post to the end, and clicks into your product</li>
                    <li>Product signups after reading, by post</li>
                </ul>
                <p class="muted small">Only production pages count, and bots are left out.</p>
                {isEditor() ? (
                    <p class="muted small">
                        Newsletters and growth work without it: <a href="#/analytics/newsletters">Newsletters</a>, <a href="#/analytics/growth">Growth</a>.
                    </p>
                ) : null}
            </div>
        </section>
    );
}

/** A setting or command to paste, with a copy button. */
function Command({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <span class="an-cmd">
            <code>{text}</code>
            <button
                type="button"
                class="an-toggle"
                onClick={() =>
                    navigator.clipboard?.writeText(text).then(
                        () => (setCopied(true), setTimeout(() => setCopied(false), 1500)),
                        () => {}
                    )
                }
            >
                {copied ? 'Copied' : 'Copy'}
            </button>
        </span>
    );
}

export function PosthogProblem({ report, onRetry }: { report: FromPosthog<unknown>; onRetry: () => void }) {
    return (
        <div class="note warn an-problem">
            <b>PostHog did not answer.</b> {report.error}{' '}
            <button type="button" class="link-btn" onClick={onRetry}>
                Try again
            </button>
        </div>
    );
}

export function SendsTable({ sends, compactView, limit = 12 }: { sends: SendRow[]; compactView?: boolean; limit?: number }) {
    const [all, setAll] = useState(false);
    if (!sends.length) return <p class="muted small an-none">No newsletters in this period.</p>;
    const shown = all ? sends : sends.slice(0, limit);
    const rate = (n: number | null, d: number | null, r: number | null, digits = 1) =>
        n === null || d === null || !d ? (
            <span class="muted">–</span>
        ) : (
            <>
                <b>{pct(r ?? n / d, digits)}</b>
                <span class="an-sub">{fmtInt(n)}</span>
            </>
        );
    return (
        <div class="table-wrap an-table-scroll">
            <table class="table an-sends-table">
                <thead>
                    <tr>
                        {compactView ? <th>Sent</th> : <th>Newsletter</th>}
                        <th class="num">Recipients</th>
                        <th class="num">Delivered</th>
                        <th class="num">Opened</th>
                        <th class="num">Clicked</th>
                        <th class="num">Unsubscribed</th>
                        <th class="num">Bounced</th>
                    </tr>
                </thead>
                <tbody>
                    {shown.map(s => (
                        <tr key={`${s.id ?? s.postId}${s.at}`}>
                            <td>
                                {compactView ? null : s.postId ? (
                                    <a class="title-cell" href={`#/analytics/post/${s.postId}`}>
                                        {s.title}
                                    </a>
                                ) : (
                                    <span class="title-cell">{s.title}</span>
                                )}
                                <span class="an-sub">
                                    {shortDate(s.at)}
                                    {s.source === 'ghost' ? (
                                        <>
                                            {' '}
                                            <Pill>sent by Ghost</Pill>
                                        </>
                                    ) : null}
                                </span>
                            </td>
                            <td class="num" data-label="Recipients">
                                {fmtInt(s.sent)}
                            </td>
                            <td class="num" data-label="Delivered">
                                {rate(s.delivered, s.sent, null)}
                            </td>
                            <td class="num" data-label="Opened">
                                {rate(s.opened, s.delivered, s.openRate)}
                            </td>
                            <td class="num" data-label="Clicked">
                                {rate(s.clicked, s.delivered, s.clickRate)}
                            </td>
                            <td class="num" data-label="Unsubscribed">
                                {rate(s.unsubscribed, s.delivered, null, 2)}
                            </td>
                            <td class="num" data-label="Bounced">
                                {s.bounced === null ? <span class="muted">–</span> : fmtInt(s.bounced)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {sends.length > limit ? (
                <button type="button" class="link-btn an-more an-table-more" onClick={() => setAll(!all)}>
                    {all ? 'Show fewer' : `Show all ${sends.length}`}
                </button>
            ) : null}
        </div>
    );
}
