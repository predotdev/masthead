import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { base } from '../api';
import { BarList, Delta, Kpi, PointsChart, Segments, TrendChart, compact, fmtInt, pct, shortDate, type BarItem } from '../charts';
import { ErrorNote, Loading, PageHead } from '../ui';
import {
    ChannelList,
    ConnectPosthog,
    Panel,
    PosthogProblem,
    SendsTable,
    Switch,
    Toolbar,
    channelName,
    countryName,
    flag,
    isEditor,
    pageName,
    periodText,
    useReport,
    vsText,
    type EmailReport,
    type MembersReport,
    type RangeKey,
    type SendRow,
    type WebData,
    type WebReport
} from './analytics-shared';
import { SearchTab } from './analytics-search';
import { PostAnalytics } from './post-analytics';

function useRange(): [RangeKey, (r: RangeKey) => void] {
    const [range, set] = useState<RangeKey>(() => {
        try {
            const v = localStorage.getItem('mh-analytics-range');
            return v === '7' || v === '90' || v === 'all' ? v : '30';
        } catch {
            return '30';
        }
    });
    return [
        range,
        (r: RangeKey) => {
            set(r);
            try {
                localStorage.setItem('mh-analytics-range', r);
            } catch {
                // Private windows: the choice lasts until reload.
            }
        }
    ];
}

function useHash(): string {
    const [hash, setHash] = useState(location.hash);
    useEffect(() => {
        const on = () => setHash(location.hash);
        window.addEventListener('hashchange', on);
        return () => window.removeEventListener('hashchange', on);
    }, []);
    return hash;
}

// ------------------------------------------------------------------ the page

const TABS: { key: string; label: string; editor?: boolean }[] = [
    { key: '', label: 'Overview' },
    { key: 'traffic', label: 'Web traffic' },
    { key: 'search', label: 'Search' },
    { key: 'newsletters', label: 'Newsletters', editor: true },
    { key: 'growth', label: 'Growth', editor: true }
];

/** Readers, newsletters and growth; PostHog adds the reader side when connected. */
export function Analytics() {
    const hash = useHash();
    const [range, setRange] = useRange();
    const [, , sub = '', arg] = hash.replace(/^#/, '').split('?')[0].split('/');
    if (sub === 'post' && arg) return <PostAnalytics id={arg} range={range} setRange={setRange} />;
    const tabs = TABS.filter(t => !t.editor || isEditor());
    const tab = tabs.find(t => t.key === sub)?.key ?? '';
    return (
        <div class="an">
            <PageHead title="Analytics" />
            <nav class="an-nav" aria-label="Analytics">
                {tabs.map(t => (
                    <a key={t.key} href={`#/analytics${t.key ? `/${t.key}` : ''}`} aria-current={t.key === tab ? 'page' : undefined} class={t.key === tab ? 'on' : ''}>
                        {t.label}
                    </a>
                ))}
            </nav>
            {tab === 'traffic' ? (
                <Traffic range={range} setRange={setRange} />
            ) : tab === 'search' ? (
                <SearchTab range={range} setRange={setRange} />
            ) : tab === 'newsletters' ? (
                <Newsletters range={range} setRange={setRange} />
            ) : tab === 'growth' ? (
                <Growth range={range} setRange={setRange} />
            ) : (
                <Overview range={range} setRange={setRange} />
            )}
        </div>
    );
}

type TabProps = { range: RangeKey; setRange: (r: RangeKey) => void };

// ------------------------------------------------------------------ overview

type OverviewMetric = 'visitors' | 'pageviews' | 'subscribers' | 'new' | 'open' | 'click';

function Overview({ range, setRange }: TabProps) {
    const editor = isEditor();
    const web = useReport<WebReport>(`/analytics/web?range=${range}`);
    const email = useReport<EmailReport>(editor ? `/analytics/email?range=${range}` : null);
    const members = useReport<MembersReport>(editor ? `/analytics/members?range=${range}` : null);
    const [picked, setPicked] = useState<OverviewMetric | null>(null);
    const w = web.data;
    const ok = w?.status === 'ok' && w.data ? w.data : null;
    const off = w?.status === 'off';
    const r = w?.range ?? email.data?.range ?? members.data?.range;
    const metric: OverviewMetric = picked ?? (ok || !editor ? 'visitors' : 'subscribers');
    const m = members.data;
    const e = email.data;
    if (web.error && email.error) return <ErrorNote text={web.error} />;

    const busy = web.loading || email.loading || members.loading;
    const visitorsTile = (key: 'visitors' | 'pageviews', label: string) => (
        <Kpi
            label={label}
            value={ok ? compact(ok.totals[key]) : off ? 'Not connected' : w?.status === 'error' ? 'Unavailable' : '…'}
            exact={ok ? fmtInt(ok.totals[key]) : undefined}
            delta={ok && ok.prevTotals ? <Delta now={ok.totals[key]} before={ok.prevTotals[key]} vs={vsText(r)} /> : null}
            selected={metric === key}
            onSelect={() => setPicked(key)}
            dim={!ok}
        />
    );

    let chart: ComponentChildren = null;
    if ((metric === 'visitors' || metric === 'pageviews') && !ok) {
        chart = off ? <ConnectPosthog setup={w!.setup} brief /> : w?.status === 'error' ? <PosthogProblem report={w} onRetry={() => web.reload(true)} /> : <Loading />;
    } else if ((metric === 'visitors' || metric === 'pageviews') && ok && r) {
        const name = metric === 'visitors' ? 'Unique visitors' : 'Pageviews';
        chart = (
            <TrendChart
                label={`${name}, ${periodText(r)}`}
                labels={r.buckets}
                unit={r.unit}
                series={[
                    { name: r.days ? 'This period' : name, values: ok.series.map(s => s[metric]) },
                    ...(ok.prevSeries ? [{ name: 'Period before', values: ok.prevSeries.map(s => s[metric]), tone: 'compare' as const, labels: r.prevBuckets ?? undefined }] : [])
                ]}
            />
        );
    } else if ((metric === 'subscribers' || metric === 'new') && m) {
        chart =
            metric === 'subscribers' ? (
                <TrendChart
                    label={`Subscribers, ${periodText(m.range)}`}
                    labels={m.range.buckets}
                    unit={m.range.unit}
                    fit
                    series={[{ name: 'Subscribers', values: m.series.map(s => s.subscribers) }]}
                />
            ) : (
                <TrendChart
                    label={`New subscribers, ${periodText(m.range)}`}
                    labels={m.range.buckets}
                    unit={m.range.unit}
                    kind="bars"
                    series={[{ name: 'New subscribers', values: m.series.map(s => s.newSubscribers) }]}
                />
            );
    } else if ((metric === 'open' || metric === 'click') && e) {
        const key = metric === 'open' ? 'openRate' : 'clickRate';
        chart = (
            <PointsChart
                label={`${metric === 'open' ? 'Open rate' : 'Click rate'} of each newsletter, ${periodText(e.range)}`}
                name={metric === 'open' ? 'Open rate' : 'Click rate'}
                points={e.sends.map(s => ({ at: s.at, value: s[key], label: s.title }))}
            />
        );
    } else chart = <Loading />;

    return (
        <div class={busy ? 'an-busy' : ''}>
            <Toolbar range={range} setRange={setRange} web={w} onRefresh={() => web.reload(true)} />
            <div class="an-kpis" role="tablist" aria-label="Show on the chart">
                {visitorsTile('visitors', 'Unique visitors')}
                {visitorsTile('pageviews', 'Pageviews')}
                {editor ? (
                    <>
                        <Kpi
                            label="Subscribers"
                            value={m ? compact(m.subscribers) : '…'}
                            exact={m ? fmtInt(m.subscribers) : undefined}
                            delta={m && m.range.days ? <Delta now={m.subscribers} before={m.startSubscribers} vs={`since ${shortDate(m.range.start)}`} /> : null}
                            note={m && m.range.days ? `${m.subscribers - m.startSubscribers >= 0 ? '+' : ''}${fmtInt(m.subscribers - m.startSubscribers)} in ${m.range.days} days` : null}
                            selected={metric === 'subscribers'}
                            onSelect={() => setPicked('subscribers')}
                        />
                        <Kpi
                            label="New subscribers"
                            value={m ? compact(m.totals.newSubscribers) : '…'}
                            delta={m?.prevTotals ? <Delta now={m.totals.newSubscribers} before={m.prevTotals.newSubscribers} vs={vsText(m.range)} /> : null}
                            selected={metric === 'new'}
                            onSelect={() => setPicked('new')}
                        />
                        <Kpi
                            label="Open rate"
                            value={e ? pct(e.totals.openRate) : '…'}
                            delta={e?.prevTotals ? <Delta rate now={e.totals.openRate} before={e.prevTotals.openRate} vs={vsText(e.range)} /> : null}
                            note={e ? `${e.totals.sends} newsletter${e.totals.sends === 1 ? '' : 's'}` : null}
                            selected={metric === 'open'}
                            onSelect={() => setPicked('open')}
                        />
                        <Kpi
                            label="Click rate"
                            value={e ? pct(e.totals.clickRate) : '…'}
                            delta={e?.prevTotals ? <Delta rate now={e.totals.clickRate} before={e.prevTotals.clickRate} vs={vsText(e.range)} /> : null}
                            note={e && e.totals.clickRate === null ? 'no clicks recorded' : null}
                            selected={metric === 'click'}
                            onSelect={() => setPicked('click')}
                        />
                    </>
                ) : null}
            </div>
            <section class="panel an-panel an-main">{chart}</section>
            {off && metric !== 'visitors' && metric !== 'pageviews' ? <ConnectPosthog setup={w!.setup} brief /> : null}
            {w?.status === 'error' && metric !== 'visitors' && metric !== 'pageviews' ? <PosthogProblem report={w} onRetry={() => web.reload(true)} /> : null}
            <div class="an-grid">
                {ok ? (
                    <Panel title="Top content" action={<a href="#/analytics/traffic">All traffic</a>}>
                        <TopPosts web={w!} data={ok} limit={6} />
                    </Panel>
                ) : m ? (
                    <Panel title="Posts that brought subscribers" action={<a href="#/analytics/growth">Growth</a>}>
                        <SignupPosts m={m} limit={6} />
                    </Panel>
                ) : null}
                {e ? (
                    <Panel title="Latest newsletters" action={<a href="#/analytics/newsletters">All newsletters</a>}>
                        <LatestSends sends={e.sends.slice(0, 5)} />
                    </Panel>
                ) : null}
            </div>
        </div>
    );
}

function TopPosts({ web, data, limit = 10 }: { web: WebReport; data: WebData; limit?: number }) {
    const reads = new Map(data.posts.filter(p => p.slug).map(p => [p.slug!, p]));
    const items: BarItem[] = data.pages.map(p => {
        const { label, post } = pageName(p.path, web.titles);
        const slug = p.path.slice(base.length).replace(/\/$/, '');
        const eng = reads.get(slug);
        return {
            key: p.path,
            label,
            href: post && post.type === 'post' ? `#/analytics/post/${post.id}` : undefined,
            value: p.visitors,
            note: eng && eng.readers ? `${pct(eng.finished / eng.readers, 0)} read` : `${compact(p.views)} views`,
            title: `${label}: ${fmtInt(p.visitors)} visitors, ${fmtInt(p.views)} views${eng?.readers ? `, ${pct(eng.finished / eng.readers)} read to the end` : ''}`
        };
    });
    return <BarList items={items} limit={limit} empty="No visits in this period." />;
}

function SignupPosts({ m, limit = 10 }: { m: MembersReport; limit?: number }) {
    return (
        <BarList
            items={m.posts.map(p => ({ key: p.slug, label: p.title ?? p.slug, href: p.id ? `#/analytics/post/${p.id}` : undefined, value: p.count }))}
            limit={limit}
            empty={m.unrecorded ? 'Signups from before sources were recorded do not name a post.' : 'No signups from posts in this period.'}
        />
    );
}

function LatestSends({ sends }: { sends: SendRow[] }) {
    if (!sends.length) return <p class="muted small an-none">No newsletters in this period.</p>;
    return (
        <ul class="an-sends">
            {sends.map(s => (
                <li key={`${s.id ?? s.postId}`}>
                    <div class="an-sends-title">
                        {s.postId ? <a href={`#/analytics/post/${s.postId}`}>{s.title}</a> : s.title}
                        <span class="muted small">
                            {shortDate(s.at)} · {fmtInt(s.sent)} sent
                        </span>
                    </div>
                    <div class="an-sends-rates">
                        <span>
                            <b>{pct(s.openRate)}</b> opened
                        </span>
                        {s.clickRate !== null ? (
                            <span>
                                <b>{pct(s.clickRate)}</b> clicked
                            </span>
                        ) : null}
                    </div>
                </li>
            ))}
        </ul>
    );
}

// ------------------------------------------------------------------ web traffic

type TrafficMetric = 'visitors' | 'visits' | 'pageviews';

function Traffic({ range, setRange }: TabProps) {
    const web = useReport<WebReport>(`/analytics/web?range=${range}`);
    const [metric, setMetric] = useState<TrafficMetric>('visitors');
    const [tech, setTech] = useState<'browsers' | 'os'>('browsers');
    const w = web.data;
    if (web.error && !w) return <ErrorNote text={web.error} />;
    if (!w) return <Loading />;
    const toolbar = <Toolbar range={range} setRange={setRange} web={w} onRefresh={() => web.reload(true)} />;
    if (w.status === 'off')
        return (
            <>
                {toolbar}
                <ConnectPosthog setup={w.setup} />
            </>
        );
    if (w.status === 'error' || !w.data)
        return (
            <>
                {toolbar}
                <PosthogProblem report={w} onRetry={() => web.reload(true)} />
            </>
        );
    const d = w.data;
    const r = w.range;
    const names: Record<TrafficMetric, string> = { visitors: 'Unique visitors', visits: 'Visits', pageviews: 'Pageviews' };
    const posts = d.posts.filter(p => p.slug);
    const readers = posts.reduce((n, p) => n + p.readers, 0);
    const finished = posts.reduce((n, p) => n + p.finished, 0);
    const timed = posts.filter(p => p.readSeconds !== null && p.finished);
    const seconds = timed.length ? Math.round(timed.reduce((n, p) => n + p.readSeconds! * p.finished, 0) / timed.reduce((n, p) => n + p.finished, 0)) : null;
    const cta = d.posts.reduce((n, p) => n + p.ctaClicks, 0);
    const signups = d.signups.reduce((n, s) => n + s.signups, 0);
    const visitorsTotal = d.countries.reduce((n, c) => n + c.visitors, 0);

    return (
        <div class={web.loading ? 'an-busy' : ''}>
            {toolbar}
            {w.error ? <PosthogProblem report={w} onRetry={() => web.reload(true)} /> : null}
            <div class="an-kpis" role="tablist" aria-label="Show on the chart">
                {(['visitors', 'visits', 'pageviews'] as TrafficMetric[]).map(k => (
                    <Kpi
                        key={k}
                        label={names[k]}
                        value={compact(d.totals[k])}
                        exact={fmtInt(d.totals[k])}
                        delta={d.prevTotals ? <Delta now={d.totals[k]} before={d.prevTotals[k]} vs={vsText(r)} /> : null}
                        selected={metric === k}
                        onSelect={() => setMetric(k)}
                    />
                ))}
                <Kpi label="Read to the end" value={readers ? pct(finished / readers, 0) : '–'} note={seconds !== null ? `in ${seconds} s on average` : 'of post readers'} />
                <Kpi label="Clicks into your product" value={compact(cta)} note={d.totals.visitors ? `${pct(cta / d.totals.visitors, 1)} of visitors` : null} />
                <Kpi label="Signups after reading" value={compact(signups)} note="product signups" />
            </div>
            <section class="panel an-panel an-main">
                <TrendChart
                    label={`${names[metric]}, ${periodText(r)}`}
                    labels={r.buckets}
                    unit={r.unit}
                    series={[
                        { name: r.days ? 'This period' : names[metric], values: d.series.map(s => s[metric]) },
                        ...(d.prevSeries ? [{ name: 'Period before', values: d.prevSeries.map(s => s[metric]), tone: 'compare' as const, labels: r.prevBuckets ?? undefined }] : [])
                    ]}
                />
            </section>
            <div class="an-grid">
                <Panel title="Top content">
                    <TopPosts web={w} data={d} />
                </Panel>
                <Panel title="Where visitors came from">
                    <ChannelList channels={d.channels} />
                </Panel>
                <Panel title="Countries">
                    <BarList
                        items={d.countries.map(c => ({
                            key: c.value || 'unknown',
                            label: (
                                <>
                                    <span class="an-flag" aria-hidden="true">
                                        {flag(c.value)}
                                    </span>
                                    {countryName(c.value)}
                                </>
                            ),
                            value: c.visitors
                        }))}
                        total={visitorsTotal}
                        empty="No visits in this period."
                    />
                </Panel>
                <Panel title="Devices">
                    <Segments label="Visitors by device" items={d.devices.map(x => ({ key: x.value || 'unknown', label: x.value || 'Unknown', value: x.visitors }))} />
                    <Switch
                        label="Browsers or operating systems"
                        value={tech}
                        onChange={setTech}
                        options={[
                            ['browsers', 'Browsers'],
                            ['os', 'Operating systems']
                        ]}
                    />
                    <BarList items={d[tech].map(x => ({ key: x.value || 'unknown', label: x.value || 'Unknown', value: x.visitors }))} limit={6} total={d[tech].reduce((n, x) => n + x.visitors, 0)} />
                </Panel>
                <Panel title="Campaigns">
                    <BarList
                        items={d.campaigns.map(c => ({
                            key: `${c.campaign}|${c.source}|${c.medium}`,
                            label: (
                                <>
                                    {c.campaign || '(no campaign)'}
                                    <span class="an-tag">{[c.source, c.medium].filter(Boolean).join(' / ')}</span>
                                </>
                            ),
                            value: c.visits
                        }))}
                        empty="No visits with utm_ tags in this period."
                    />
                </Panel>
                <Panel title="Product signups after reading">
                    <BarList
                        items={d.signups.map(s => {
                            const t = w.titles?.[s.slug];
                            return { key: s.slug, label: t?.title ?? s.slug, href: t ? `#/analytics/post/${t.id}` : undefined, value: s.signups };
                        })}
                        empty="None in this period. They count people who read a post and later signed up for your product."
                    />
                </Panel>
            </div>
            <p class="an-foot">Production pages under {base} only; bots are left out. Visits are sessions, sorted by where they began.</p>
        </div>
    );
}

// ------------------------------------------------------------------ newsletters

type EmailMetric = 'subscribers' | 'sent' | 'open' | 'click';

function Newsletters({ range, setRange }: TabProps) {
    const email = useReport<EmailReport>(`/analytics/email?range=${range}`);
    const members = useReport<MembersReport>(`/analytics/members?range=${range}`);
    const [metric, setMetric] = useState<EmailMetric>('open');
    const e = email.data;
    const m = members.data;
    if (email.error && !e) return <ErrorNote text={email.error} />;
    if (!e) return <Loading />;
    const t = e.totals;
    const p = e.prevTotals;
    const r = e.range;
    const chart =
        metric === 'subscribers' ? (
            m ? (
                <TrendChart label={`Subscribers, ${periodText(r)}`} labels={m.range.buckets} unit={m.range.unit} fit series={[{ name: 'Subscribers', values: m.series.map(s => s.subscribers) }]} />
            ) : (
                <Loading />
            )
        ) : metric === 'sent' ? (
            <PointsChart label={`Emails sent per newsletter, ${periodText(r)}`} name="Sent" percent={false} format={fmtInt} points={e.sends.map(s => ({ at: s.at, value: s.sent, label: s.title }))} />
        ) : (
            <PointsChart
                label={`${metric === 'open' ? 'Open' : 'Click'} rate of each newsletter, ${periodText(r)}`}
                name={metric === 'open' ? 'Open rate' : 'Click rate'}
                points={e.sends.map(s => ({ at: s.at, value: metric === 'open' ? s.openRate : s.clickRate, label: s.title }))}
            />
        );
    return (
        <div class={email.loading || members.loading ? 'an-busy' : ''}>
            <Toolbar range={range} setRange={setRange} />
            <div class="an-kpis" role="tablist" aria-label="Show on the chart">
                <Kpi
                    label="Subscribers"
                    value={m ? compact(m.subscribers) : '…'}
                    exact={m ? fmtInt(m.subscribers) : undefined}
                    delta={m && r.days ? <Delta now={m.subscribers} before={m.startSubscribers} vs={`since ${shortDate(r.start)}`} /> : null}
                    note={m && m.sendable !== m.subscribers ? `${fmtInt(m.sendable)} can receive email` : null}
                    selected={metric === 'subscribers'}
                    onSelect={() => setMetric('subscribers')}
                />
                <Kpi
                    label="Newsletters sent"
                    value={fmtInt(t.sends)}
                    delta={p ? <Delta now={t.sends} before={p.sends} vs={vsText(r)} /> : null}
                    note={`${compact(t.sent)} emails`}
                    selected={metric === 'sent'}
                    onSelect={() => setMetric('sent')}
                />
                <Kpi
                    label="Open rate"
                    value={pct(t.openRate)}
                    delta={p ? <Delta rate now={t.openRate} before={p.openRate} vs={vsText(r)} /> : null}
                    note={`${compact(t.opened)} people`}
                    selected={metric === 'open'}
                    onSelect={() => setMetric('open')}
                />
                <Kpi
                    label="Click rate"
                    value={pct(t.clickRate)}
                    delta={p ? <Delta rate now={t.clickRate} before={p.clickRate} vs={vsText(r)} /> : null}
                    note={`${compact(t.clicked)} people`}
                    selected={metric === 'click'}
                    onSelect={() => setMetric('click')}
                />
                <Kpi
                    label="Unsubscribed"
                    value={fmtInt(t.unsubscribed)}
                    delta={p ? <Delta now={t.unsubscribed} before={p.unsubscribed} upIsGood={false} vs={vsText(r)} /> : null}
                    note={t.unsubscribeRate !== null ? `${pct(t.unsubscribeRate, 2)} of delivered` : null}
                />
            </div>
            <section class="panel an-panel an-main">{chart}</section>
            <Panel title="Each newsletter" wide>
                <SendsTable sends={e.sends} />
            </Panel>
            <div class="an-grid">
                <Panel title="Links clicked">
                    <BarList
                        items={e.links.map(l => ({ key: l.url, label: linkName(l.url), title: `${l.url}: ${fmtInt(l.people)} people, ${fmtInt(l.clicks)} clicks`, value: l.people }))}
                        empty={e.webhooks ? 'No clicks recorded in this period.' : 'Clicks arrive from the email provider’s webhook once it is set up.'}
                    />
                </Panel>
                <Panel title="Deliverability">
                    <dl class="an-facts">
                        <dt>Delivered</dt>
                        <dd>{t.sent ? pct(t.delivered / t.sent) : '–'}</dd>
                        <dt>Bounced</dt>
                        <dd>{fmtInt(t.bounced)}</dd>
                        <dt>Marked as spam</dt>
                        <dd>{fmtInt(t.complained)}</dd>
                        <dt>Unsubscribed</dt>
                        <dd>{fmtInt(t.unsubscribed)}</dd>
                    </dl>
                </Panel>
            </div>
            <p class="an-foot">
                Opens and clicks count people, once each, and arrive from the email provider’s webhook{e.webhooks ? '' : ', which is not set up yet (RESEND_WEBHOOK_SECRET)'}. Newsletters sent before
                the move from Ghost show the numbers Ghost kept (no clicks or unsubscribes).
                {e.testSends ? ` ${e.testSends} test-mode ${e.testSends === 1 ? 'send is' : 'sends are'} left out.` : ''}
            </p>
        </div>
    );
}

function linkName(url: string): string {
    try {
        const u = new URL(url);
        if (u.pathname.endsWith('/api/unsubscribe')) return 'Unsubscribe link';
        return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}${u.search}`;
    } catch {
        return url;
    }
}

// ------------------------------------------------------------------ growth

type GrowthMetric = 'subscribers' | 'new' | 'unsubscribes' | 'net';

const METHOD_NAMES: Record<string, string> = { member: 'Signup form', api: 'Your product (API)', admin: 'Added by staff', import: 'Imported' };
const PLACEMENT_NAMES: Record<string, string> = { post: 'On a post', home: 'Front page', page: 'Other pages' };

function Growth({ range, setRange }: TabProps) {
    const members = useReport<MembersReport>(`/analytics/members?range=${range}`);
    const web = useReport<WebReport>(`/analytics/web?range=${range}`);
    const [metric, setMetric] = useState<GrowthMetric>('subscribers');
    const [view, setView] = useState<'channels' | 'sources'>('channels');
    const m = members.data;
    if (members.error && !m) return <ErrorNote text={members.error} />;
    if (!m) return <Loading />;
    const r = m.range;
    const net = m.totals.newSubscribers - m.totals.unsubscribes;
    const prevNet = m.prevTotals ? m.prevTotals.newSubscribers - m.prevTotals.unsubscribes : null;
    const signupTotal = m.channels.reduce((n, c) => n + c.count, 0);
    const w = web.data?.status === 'ok' ? web.data : null;
    const chart =
        metric === 'subscribers' ? (
            <TrendChart label={`Subscribers, ${periodText(r)}`} labels={r.buckets} unit={r.unit} fit series={[{ name: 'Subscribers', values: m.series.map(s => s.subscribers) }]} />
        ) : metric === 'net' ? (
            <TrendChart
                label={`New subscribers and unsubscribes, ${periodText(r)}`}
                labels={r.buckets}
                unit={r.unit}
                series={[
                    { name: 'New subscribers', values: m.series.map(s => s.newSubscribers) },
                    { name: 'Unsubscribes', values: m.series.map(s => s.unsubscribes), tone: 'down' }
                ]}
            />
        ) : (
            <TrendChart
                label={`${metric === 'new' ? 'New subscribers' : 'Unsubscribes'}, ${periodText(r)}`}
                labels={r.buckets}
                unit={r.unit}
                kind="bars"
                series={[
                    {
                        name: metric === 'new' ? 'New subscribers' : 'Unsubscribes',
                        values: m.series.map(s => (metric === 'new' ? s.newSubscribers : s.unsubscribes)),
                        tone: metric === 'new' ? 'main' : 'down'
                    }
                ]}
            />
        );
    const channelItems: BarItem[] =
        view === 'channels'
            ? m.channels.map(c => ({
                  key: c.channel,
                  label: channelName(c.channel),
                  value: c.count,
                  title: c.sources
                      .slice(0, 5)
                      .map(s => s.source)
                      .join(', ')
              }))
            : m.channels
                  .flatMap(c => c.sources.map(s => ({ ...s, channel: c.channel })))
                  .sort((a, b) => b.count - a.count)
                  .map(s => ({
                      key: `${s.channel}:${s.source}`,
                      label: (
                          <>
                              {s.source}
                              <span class="an-tag">{channelName(s.channel)}</span>
                          </>
                      ),
                      value: s.count
                  }));
    return (
        <div class={members.loading ? 'an-busy' : ''}>
            <Toolbar range={range} setRange={setRange} />
            <div class="an-kpis" role="tablist" aria-label="Show on the chart">
                <Kpi
                    label="Subscribers"
                    value={compact(m.subscribers)}
                    exact={fmtInt(m.subscribers)}
                    delta={r.days ? <Delta now={m.subscribers} before={m.startSubscribers} vs={`since ${shortDate(r.start)}`} /> : null}
                    note={m.sendable !== m.subscribers ? `${fmtInt(m.sendable)} can receive email` : null}
                    selected={metric === 'subscribers'}
                    onSelect={() => setMetric('subscribers')}
                />
                <Kpi
                    label="New subscribers"
                    value={compact(m.totals.newSubscribers)}
                    delta={m.prevTotals ? <Delta now={m.totals.newSubscribers} before={m.prevTotals.newSubscribers} vs={vsText(r)} /> : null}
                    selected={metric === 'new'}
                    onSelect={() => setMetric('new')}
                />
                <Kpi
                    label="Unsubscribes"
                    value={compact(m.totals.unsubscribes)}
                    delta={m.prevTotals ? <Delta now={m.totals.unsubscribes} before={m.prevTotals.unsubscribes} upIsGood={false} vs={vsText(r)} /> : null}
                    selected={metric === 'unsubscribes'}
                    onSelect={() => setMetric('unsubscribes')}
                />
                <Kpi
                    label="Net growth"
                    value={`${net > 0 ? '+' : ''}${compact(net)}`}
                    delta={prevNet !== null ? <Delta now={net} before={prevNet} vs={vsText(r)} /> : null}
                    selected={metric === 'net'}
                    onSelect={() => setMetric('net')}
                />
                <Kpi
                    label="Confirmed their signup"
                    value={m.confirmation.requested ? pct(m.confirmation.confirmed / m.confirmation.requested, 0) : '–'}
                    note={`${fmtInt(m.confirmation.confirmed)} of ${fmtInt(m.confirmation.requested)} form signups`}
                />
                <Kpi label="Awaiting confirmation" value={fmtInt(m.pending)} note="signed up, not confirmed" />
            </div>
            <section class="panel an-panel an-main">{chart}</section>
            <div class="an-grid">
                <Panel title="Where signups came from">
                    <Switch
                        label="Group sources"
                        value={view}
                        onChange={setView}
                        options={[
                            ['channels', 'Channels'],
                            ['sources', 'Sites']
                        ]}
                    />
                    <BarList items={channelItems} total={signupTotal} empty={m.unrecorded ? 'Signups before this was recorded have no source.' : 'No form signups in this period.'} />
                    {m.unrecorded ? <p class="muted small">{fmtInt(m.unrecorded)} form signups from before sources were recorded are not shown.</p> : null}
                </Panel>
                <Panel title="How they joined">
                    <BarList
                        items={m.methods.map(x => ({ key: x.method, label: METHOD_NAMES[x.method] ?? x.method, value: x.count }))}
                        total={m.totals.newSubscribers}
                        empty="Nobody joined in this period."
                    />
                </Panel>
                <Panel title="Posts that brought subscribers">
                    <SignupPosts m={m} />
                </Panel>
                <Panel title="Where on the page">
                    <BarList
                        items={m.placements.map(x => ({ key: x.placement, label: PLACEMENT_NAMES[x.placement] ?? x.placement, value: x.count }))}
                        total={signupTotal}
                        empty="No form signups in this period."
                    />
                </Panel>
                {w?.data ? (
                    <Panel title="Product signups after reading" wide>
                        <BarList
                            items={w.data.signups.map(s => {
                                const t = w.titles?.[s.slug];
                                return { key: s.slug, label: t?.title ?? s.slug, href: t ? `#/analytics/post/${t.id}` : undefined, value: s.signups };
                            })}
                            empty="None in this period. They count people who read a post and later signed up for your product."
                        />
                    </Panel>
                ) : null}
            </div>
            <p class="an-foot">Subscribers over time are worked back from today’s count using subscribe and unsubscribe history. Where a signup came from is recorded from the signup form.</p>
        </div>
    );
}
