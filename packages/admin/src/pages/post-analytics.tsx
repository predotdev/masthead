import { useState } from 'preact/hooks';
import { fmtDate } from '../api';
import { BarList, Delta, Kpi, TrendChart, compact, fmtInt, pct } from '../charts';
import { ErrorNote, Loading, PageHead } from '../ui';
import {
    ChannelList,
    ConnectPosthog,
    Panel,
    SendsTable,
    Toolbar,
    channelName,
    periodText,
    useReport,
    vsText,
    type Campaign,
    type ChannelRow,
    type EmailTotals,
    type FromPosthog,
    type RangeKey,
    type Range,
    type SendRow
} from './analytics-shared';
import { PostSearch } from './analytics-search';

interface PostTotals {
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

interface PostWeb {
    totals: PostTotals;
    prevTotals: PostTotals | null;
    series: { bucket: string; visitors: number; views: number }[];
    prevSeries: { bucket: string; visitors: number; views: number }[] | null;
    channels: ChannelRow[];
    campaigns: Campaign[];
}

interface PostReport {
    post: { id: string; slug: string; title: string; type: string; status: string; publishedAt: string | null; url: string };
    range: Range;
    newsletter: { sends: SendRow[]; totals: EmailTotals; links: { url: string; people: number; clicks: number }[] } | null;
    members: { requested: number; confirmed: number; prevRequested: number | null; channels: { channel: string; count: number }[] };
}

/** One post: who read it and how far, where they came from, its newsletter, and the subscribers it brought. */
export function PostAnalytics({ id, range, setRange }: { id: string; range: RangeKey; setRange: (r: RangeKey) => void }) {
    const report = useReport<PostReport>(`/analytics/posts/${id}?range=${range}`);
    const web = useReport<FromPosthog<PostWeb>>(`/analytics/posts/${id}/web?range=${range}`);
    const [metric, setMetric] = useState<'visitors' | 'views'>('visitors');
    const p = report.data;
    const w = web.data;
    const d = w?.status === 'ok' ? w.data : null;
    const r = w?.range ?? p?.range;
    if (report.error && web.error) return <ErrorNote text={report.error} />;
    if (!p && !w) return <Loading />;
    const t = d?.totals;
    const prev = d?.prevTotals;
    const missing = w?.status === 'off' ? 'Not connected' : w?.status === 'error' ? 'Unavailable' : '…';
    const post = p?.post;
    return (
        <div class={`an ${report.loading || web.loading ? 'an-busy' : ''}`}>
            <a class="back" href="#/analytics">
                ← Analytics
            </a>
            <PageHead title={post?.title ?? 'Post'}>
                {post ? (
                    <>
                        <a class="btn ghost" href={post.url} target="_blank" rel="noreferrer">
                            View post
                        </a>
                        <a class="btn ghost" href={`#/edit/${post.id}`}>
                            Edit
                        </a>
                    </>
                ) : null}
            </PageHead>
            {post?.publishedAt ? <p class="muted an-lead">Published {fmtDate(post.publishedAt)}. "All time" starts then.</p> : null}
            <Toolbar range={range} setRange={setRange} web={w} onRefresh={() => web.reload(true)} />
            {report.error ? <ErrorNote text={report.error} /> : null}
            <div class="an-kpis" role="tablist" aria-label="Show on the chart">
                <Kpi
                    label="Unique visitors"
                    value={t ? compact(t.visitors) : missing}
                    exact={t ? fmtInt(t.visitors) : undefined}
                    delta={t && prev ? <Delta now={t.visitors} before={prev.visitors} vs={vsText(r)} /> : null}
                    selected={metric === 'visitors'}
                    onSelect={() => setMetric('visitors')}
                    dim={!t}
                />
                <Kpi
                    label="Views"
                    value={t ? compact(t.views) : missing}
                    exact={t ? fmtInt(t.views) : undefined}
                    delta={t && prev ? <Delta now={t.views} before={prev.views} vs={vsText(r)} /> : null}
                    selected={metric === 'views'}
                    onSelect={() => setMetric('views')}
                    dim={!t}
                />
                <Kpi
                    label="Read to the end"
                    value={t && t.readers ? pct(t.finished / t.readers, 0) : '–'}
                    note={t?.readSeconds ? `in ${t.readSeconds} s on average` : 'scrolled past 60%'}
                    delta={t && prev && prev.readers && t.readers ? <Delta rate now={t.finished / t.readers} before={prev.finished / prev.readers} vs={vsText(r)} /> : null}
                    dim={!t}
                />
                <Kpi label="Clicks into your product" value={t ? compact(t.ctaClicks) : '–'} note={t ? `${fmtInt(t.shares)} shares` : null} dim={!t} />
                <Kpi
                    label="Subscribers gained"
                    value={p ? fmtInt(p.members.confirmed) : '…'}
                    note={p ? `${fmtInt(p.members.requested)} signed up here` : null}
                    delta={p && p.members.prevRequested !== null ? <Delta now={p.members.requested} before={p.members.prevRequested} vs={vsText(r)} /> : null}
                />
                <Kpi label="Signups after reading" value={t ? compact(t.signups) : '–'} note="product signups" dim={!t} />
            </div>
            <section class="panel an-panel an-main">
                {d && r ? (
                    <TrendChart
                        label={`${metric === 'visitors' ? 'Unique visitors' : 'Views'} of this post, ${periodText(r)}`}
                        labels={r.buckets}
                        unit={r.unit}
                        series={[
                            { name: r.days ? 'This period' : metric === 'visitors' ? 'Unique visitors' : 'Views', values: d.series.map(s => s[metric]) },
                            ...(d.prevSeries ? [{ name: 'Period before', values: d.prevSeries.map(s => s[metric]), tone: 'compare' as const, labels: r.prevBuckets ?? undefined }] : [])
                        ]}
                    />
                ) : w?.status === 'off' ? (
                    <ConnectPosthog setup={w.setup} brief />
                ) : w?.status === 'error' ? (
                    <div class="note warn">
                        <b>PostHog did not answer.</b> {w.error}
                    </div>
                ) : (
                    <Loading />
                )}
            </section>
            <PostSearch id={id} range={range} />
            <div class="an-grid">
                {d ? (
                    <Panel title="Where readers came from">
                        <ChannelList channels={d.channels} />
                    </Panel>
                ) : null}
                {p ? (
                    <Panel title="Subscribers it brought">
                        <p class="an-big">
                            {fmtInt(p.members.confirmed)}{' '}
                            <span class="muted small">
                                confirmed of {fmtInt(p.members.requested)} who signed up on this post, {periodText(p.range)}
                            </span>
                        </p>
                        <BarList
                            items={p.members.channels.map(c => ({ key: c.channel, label: channelName(c.channel), value: c.count }))}
                            total={p.members.requested}
                            empty="Nobody signed up on this post in this period."
                        />
                    </Panel>
                ) : null}
                {p ? (
                    <Panel title="Newsletter" wide>
                        {p.newsletter ? (
                            <>
                                <div class="an-kpis an-kpis-sm">
                                    <Kpi label="Recipients" value={compact(p.newsletter.totals.sent)} exact={fmtInt(p.newsletter.totals.sent)} />
                                    <Kpi label="Open rate" value={pct(p.newsletter.totals.openRate)} note={`${fmtInt(p.newsletter.totals.opened)} people`} />
                                    <Kpi
                                        label="Click rate"
                                        value={pct(p.newsletter.totals.clickRate)}
                                        note={p.newsletter.totals.clickRate === null ? 'not recorded' : `${fmtInt(p.newsletter.totals.clicked)} people`}
                                    />
                                    <Kpi
                                        label="Unsubscribed"
                                        value={fmtInt(p.newsletter.totals.unsubscribed)}
                                        note={p.newsletter.sends.every(s => s.source === 'ghost') ? 'not recorded by Ghost' : null}
                                    />
                                </div>
                                <SendsTable sends={p.newsletter.sends} compactView />
                                {p.newsletter.links.length ? (
                                    <>
                                        <h3 class="an-h3">Links clicked</h3>
                                        <BarList items={p.newsletter.links.map(l => ({ key: l.url, label: l.url.replace(/^https?:\/\/(www\.)?/, ''), title: l.url, value: l.people }))} />
                                    </>
                                ) : null}
                            </>
                        ) : (
                            <p class="muted small an-none">Not sent as a newsletter. Open the post and choose Send as newsletter.</p>
                        )}
                    </Panel>
                ) : null}
                {d && d.campaigns.length ? (
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
                        />
                    </Panel>
                ) : null}
            </div>
        </div>
    );
}
