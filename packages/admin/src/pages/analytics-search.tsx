/**
 * Google Search Console in Analytics: the Search tab (clicks, impressions, click
 * rate and position, the searches and pages behind them, and the opportunities
 * worth a writer's time), each post's search section, the steps that connect it,
 * and the dialog that rewrites a post's search title and description.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, session, type Post } from '../api';
import { BarList, Delta, Kpi, Segments, TrendChart, compact, fmtInt, pct, shortDate } from '../charts';
import { Icon, type IconName } from '../icons';
import { modelFor } from '../models';
import { Answered, Caret, StopButton, Working, useAiRun } from '../streaming';
import { Button, Dialog, Empty, ErrorNote, Loading, Segmented, errorToast, toast, useLoad } from '../ui';
import { Panel, Toolbar, ago, countryName, flag, forgetReports, isEditor, pageName, periodText, useReport, vsText, type Range, type RangeKey } from './analytics-shared';

// ------------------------------------------------------------------ what the server answers

interface Metrics {
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
}

interface SearchRange extends Range {
    first: string;
    last: string;
    prevFirst: string | null;
    prevLast: string | null;
}

interface Setup {
    key: boolean;
    keyError: string | null;
    email: string | null;
    project: string | null;
    property: string | null;
    suggested: string;
    enableUrl: string | null;
    local: boolean;
}

interface Problem {
    kind: 'key' | 'token' | 'api' | 'access' | 'quota' | 'unavailable';
    message: string;
    project?: string;
    enableUrl?: string;
}

interface PostRef {
    id: string;
    slug: string;
    title: string;
    type: string;
    status: string;
    metaTitle: string | null;
    metaDescription: string | null;
    excerpt: string | null;
    authors: string[];
}

interface Searched {
    query: string;
    clicks: number;
    impressions: number;
    position: number;
}

interface Opportunity {
    kind: 'rank' | 'snippet' | 'drop' | 'gap';
    gain: number;
    slug?: string;
    query?: string;
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
    typicalCtr?: number;
    target?: number;
    before?: Metrics;
    cause?: 'position' | 'demand' | 'ctr';
    queries?: Searched[];
    searches?: number;
    best?: { path: string; slug: string | null; position: number } | null;
    idea?: boolean;
}

interface SearchData {
    range: SearchRange;
    totals: Metrics;
    prevTotals: Metrics | null;
    series: (Metrics & { bucket: string })[];
    prevSeries: (Metrics & { bucket: string })[] | null;
    queries: (Metrics & { query: string; prevClicks: number | null })[];
    pages: (Metrics & { path: string; slug: string | null; prevClicks: number | null })[];
    countries: (Metrics & { code: string })[];
    devices: (Metrics & { device: string })[];
    opportunities: Opportunity[];
    hidden: { clicks: number; impressions: number } | null;
}

interface PostSearchData {
    range: SearchRange;
    totals: Metrics;
    prevTotals: Metrics | null;
    series: (Metrics & { bucket: string })[];
    prevSeries: (Metrics & { bucket: string })[] | null;
    queries: (Metrics & { query: string; prev: Metrics | null })[];
    shown: { impressions: number; clicks: number; typicalCtr: number } | null;
}

/** A Search Console answer: off (not set up), blocked (Google refuses, and why), error (try again), or ok. */
interface FromSearch<T> {
    status: 'ok' | 'off' | 'blocked' | 'error';
    setup: Setup;
    problem?: Problem;
    error?: string;
    updatedAt?: string;
    stale?: boolean;
    data?: T;
}

type SearchReport = FromSearch<SearchData> & { posts?: Record<string, PostRef> };
type PostSearchReport = FromSearch<PostSearchData> & { post?: PostRef & { url: string } };

// ------------------------------------------------------------------ small pieces

type Metric = 'clicks' | 'impressions' | 'ctr' | 'position';
const NAMES: Record<Metric, string> = { clicks: 'Clicks', impressions: 'Impressions', ctr: 'Click rate', position: 'Average position' };

/** 7.4; positions read best with one decimal. */
const place = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '–' : n.toFixed(1));

const canEdit = (post: PostRef | undefined) => Boolean(post) && (isEditor() || post!.authors.includes(session.value?.user.staffId ?? ''));

/** A position's change: smaller is better, so moving from 9.1 to 7.4 is up 1.7. */
function Moved({ now, before, vs }: { now: number | null; before: number | null; vs: string }) {
    if (now === null || before === null) return null;
    const d = before - now;
    if (Math.abs(d) < 0.05) return <span class="an-delta flat">No change</span>;
    const up = d > 0;
    return (
        <span class={`an-delta ${up ? 'good' : 'bad'}`} title={`${up ? 'Up' : 'Down'} ${Math.abs(d).toFixed(1)} places ${vs}`}>
            <span aria-hidden="true">{up ? '▲' : '▼'}</span>
            <span class="an-sr">{up ? 'Up' : 'Down'}</span> {Math.abs(d).toFixed(1)}
        </span>
    );
}

function MetricTiles({ t, p, r, metric, setMetric, small }: { t: Metrics; p: Metrics | null; r: Range; metric: Metric; setMetric: (m: Metric) => void; small?: boolean }) {
    const vs = vsText(r);
    return (
        <div class={`an-kpis sc-kpis ${small ? 'an-kpis-sm' : ''}`} role="tablist" aria-label="Show on the chart">
            <Kpi label="Clicks" value={compact(t.clicks)} exact={fmtInt(t.clicks)} delta={p ? <Delta now={t.clicks} before={p.clicks} vs={vs} /> : null} selected={metric === 'clicks'} onSelect={() => setMetric('clicks')} />
            <Kpi
                label="Impressions"
                value={compact(t.impressions)}
                exact={fmtInt(t.impressions)}
                delta={p ? <Delta now={t.impressions} before={p.impressions} vs={vs} /> : null}
                selected={metric === 'impressions'}
                onSelect={() => setMetric('impressions')}
            />
            <Kpi
                label="Click rate"
                value={pct(t.ctr)}
                delta={p && t.ctr !== null && p.ctr !== null ? <Delta rate now={t.ctr} before={p.ctr} vs={vs} /> : null}
                selected={metric === 'ctr'}
                onSelect={() => setMetric('ctr')}
            />
            <Kpi
                label="Average position"
                value={place(t.position)}
                delta={p ? <Moved now={t.position} before={p.position} vs={vs} /> : null}
                selected={metric === 'position'}
                onSelect={() => setMetric('position')}
            />
        </div>
    );
}

function MetricChart({ d, metric, height, what }: { d: { range: SearchRange; series: (Metrics & { bucket: string })[]; prevSeries: (Metrics & { bucket: string })[] | null }; metric: Metric; height?: number; what?: string }) {
    const r = d.range;
    const name = NAMES[metric];
    return (
        <TrendChart
            label={`${name}${what ? ` ${what}` : ''} in Google search, ${periodText(r)}, through ${shortDate(r.last)}`}
            labels={r.buckets}
            unit={r.unit}
            height={height}
            percent={metric === 'ctr'}
            invert={metric === 'position'}
            format={metric === 'ctr' ? v => pct(v) : metric === 'position' ? v => place(v) : fmtInt}
            empty="No searches showed these pages in this period."
            series={[
                { name: r.days ? 'This period' : name, values: d.series.map(s => s[metric]) },
                ...(d.prevSeries ? [{ name: 'Period before', values: d.prevSeries.map(s => s[metric]), tone: 'compare' as const, labels: r.prevBuckets ?? undefined }] : [])
            ]}
        />
    );
}

/** Where the numbers come from, and how fresh: Search Console's days end two to three days back. */
function Freshness({ report, last, onRefresh }: { report: FromSearch<unknown>; last: string; onRefresh: () => void }) {
    return (
        <span title="Google finalizes search data two to three days late, so the range ends on the last complete day.">
            Search Console, through {shortDate(last)}
            {report.updatedAt ? ` · updated ${ago(report.updatedAt)}` : ''}
            {report.stale && !report.error ? ', refreshing' : ''}
            {' · '}
            <button type="button" class="link-btn" onClick={onRefresh}>
                Refresh
            </button>
        </span>
    );
}

function Trouble({ text, onRetry }: { text?: string; onRetry: () => void }) {
    return (
        <div class="note warn an-problem">
            <b>Search Console did not answer.</b> {text}{' '}
            <button type="button" class="link-btn" onClick={onRetry}>
                Try again
            </button>
        </div>
    );
}

// ------------------------------------------------------------------ the Search tab

export function SearchTab({ range, setRange }: { range: RangeKey; setRange: (r: RangeKey) => void }) {
    const report = useReport<SearchReport>(`/analytics/search?range=${range}`);
    const [metric, setMetric] = useState<Metric>('clicks');
    const [rewriting, setRewriting] = useState<Opportunity | null>(null);
    const [edited, setEdited] = useState<Record<string, Partial<PostRef>>>({});
    const s = report.data;
    if (report.error && !s) return <ErrorNote text={report.error} />;
    if (!s) return <Loading />;
    const d = s.status === 'ok' ? s.data : undefined;
    const toolbar = <Toolbar range={range} setRange={setRange} status={d ? <Freshness report={s} last={d.range.last} onRefresh={() => report.reload(true)} /> : undefined} />;
    if (s.status === 'off' || s.status === 'blocked')
        return (
            <>
                {toolbar}
                <ConnectSearch report={s} onRetry={() => report.reload(true)} busy={report.loading} />
            </>
        );
    if (!d)
        return (
            <>
                {toolbar}
                <Trouble text={s.error} onRetry={() => report.reload(true)} />
            </>
        );
    const r = d.range;
    const host = (() => {
        try {
            return new URL(session.value?.site.url ?? location.href).host;
        } catch {
            return 'the blog';
        }
    })();
    if (!d.totals.impressions && !d.prevTotals?.impressions)
        return (
            <>
                {toolbar}
                <Empty title="No searches yet" icon="search">
                    Google showed no pages under {host}
                    {new URL(session.value?.site.url ?? location.href).pathname} in this period. New pages take a few days to appear, and Search Console runs two to three days behind. If the blog has
                    been live for a while, check that {s.setup.property} is the property that holds it.
                </Empty>
            </>
        );
    const posts: Record<string, PostRef> = { ...s.posts };
    for (const [slug, patch] of Object.entries(edited)) if (posts[slug]) posts[slug] = { ...posts[slug], ...patch };
    const clicksTotal = d.countries.reduce((n, c) => n + c.clicks, 0);
    return (
        <div class={report.loading ? 'an-busy' : ''}>
            {toolbar}
            {s.error ? <Trouble text={s.error} onRetry={() => report.reload(true)} /> : null}
            <MetricTiles t={d.totals} p={d.prevTotals} r={r} metric={metric} setMetric={setMetric} />
            <section class="panel an-panel an-main">
                <MetricChart d={d} metric={metric} />
            </section>
            <Opportunities list={d.opportunities} posts={posts} onRewrite={setRewriting} rewritten={new Set(Object.keys(edited))} />
            <Panel title="Searches" wide>
                <SearchTable
                    caption={`Searches that showed the blog, ${periodText(r)}`}
                    first="Search"
                    empty="No searches in this period."
                    rows={d.queries.map(q => ({ key: q.query, label: q.query, ...q }))}
                />
            </Panel>
            <Panel title="Pages" wide>
                <SearchTable
                    caption={`Pages Google showed, ${periodText(r)}`}
                    first="Page"
                    empty="No pages showed in this period."
                    rows={d.pages.map(p => {
                        const name = pageName(p.path, posts);
                        return { key: p.path, label: name.label, href: name.post && name.post.type === 'post' ? `#/analytics/post/${name.post.id}` : undefined, ...p };
                    })}
                />
            </Panel>
            <div class="an-grid">
                <Panel title="Countries">
                    <BarList
                        items={d.countries.map(c => ({
                            key: c.code || 'unknown',
                            label: (
                                <>
                                    <span class="an-flag" aria-hidden="true">
                                        {flag(c.code)}
                                    </span>
                                    {countryName(c.code)}
                                </>
                            ),
                            value: c.clicks,
                            title: `${countryName(c.code)}: ${fmtInt(c.clicks)} clicks, ${fmtInt(c.impressions)} impressions, position ${place(c.position)}`
                        }))}
                        total={clicksTotal}
                        empty="No clicks in this period."
                    />
                </Panel>
                <Panel title="Devices">
                    <Segments label="Clicks by device" items={d.devices.map(x => ({ key: x.device, label: deviceName(x.device), value: x.clicks }))} />
                    {d.devices.length ? (
                        <table class="table an-table sc-devices">
                            <caption class="an-sr">Search by device</caption>
                            <thead>
                                <tr>
                                    <th scope="col">Device</th>
                                    <th scope="col" class="num">
                                        Clicks
                                    </th>
                                    <th scope="col" class="num">
                                        Click rate
                                    </th>
                                    <th scope="col" class="num">
                                        Position
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {d.devices.map(x => (
                                    <tr key={x.device}>
                                        <td>{deviceName(x.device)}</td>
                                        <td class="num">{fmtInt(x.clicks)}</td>
                                        <td class="num">{pct(x.ctr)}</td>
                                        <td class="num">{place(x.position)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : null}
                </Panel>
            </div>
            <p class="an-foot">
                Google web search, pages under {new URL(session.value?.site.url ?? location.href).pathname} only, counted by page. Search Console runs two to three days behind, so this view ends on {shortDate(r.last)}.
                {d.hidden && d.totals.clicks && d.hidden.clicks / d.totals.clicks >= 0.001
                    ? ` Searches Google keeps private (${pct(d.hidden.clicks / d.totals.clicks, d.hidden.clicks / d.totals.clicks < 0.1 ? 1 : 0)} of clicks) count in the totals but are not listed.`
                    : ''}{' '}
                Estimated clicks use typical click rates for each position.
            </p>
            {rewriting && rewriting.slug && posts[rewriting.slug] ? (
                <SnippetDialog
                    post={posts[rewriting.slug]}
                    searches={rewriting.queries ?? []}
                    stats={{ position: rewriting.position, ctr: rewriting.ctr, typicalCtr: rewriting.typicalCtr ?? null, impressions: rewriting.impressions }}
                    onClose={() => setRewriting(null)}
                    onSaved={patch => setEdited(e => ({ ...e, [rewriting.slug!]: patch }))}
                />
            ) : null}
        </div>
    );
}

const deviceName = (d: string) => ({ desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet' })[d] ?? d;

// ------------------------------------------------------------------ opportunities

const KINDS: Record<Opportunity['kind'], { label: string; plural: string; icon: IconName }> = {
    rank: { label: 'Almost page one', plural: 'Almost page one', icon: 'trendingUp' },
    snippet: { label: 'Low click rate', plural: 'Low click rate', icon: 'pointer' },
    drop: { label: 'Losing clicks', plural: 'Losing clicks', icon: 'trendingDown' },
    gap: { label: 'Content gap', plural: 'Content gaps', icon: 'ideas' }
};

const SHOWN = 6;

function Opportunities({ list, posts, onRewrite, rewritten }: { list: Opportunity[]; posts: Record<string, PostRef>; onRewrite: (o: Opportunity) => void; rewritten: Set<string> }) {
    const [picked, setKind] = useState<'all' | Opportunity['kind']>('all');
    const [all, setAll] = useState(false);
    const [added, setAdded] = useState<Set<string>>(() => new Set());
    useEffect(() => setAll(false), [picked]);
    const count = (k: Opportunity['kind']) => list.filter(o => o.kind === k).length;
    // A kind the new range has none of falls back to all of them.
    const kind = picked !== 'all' && !count(picked) ? 'all' : picked;
    const shown = list.filter(o => kind === 'all' || o.kind === kind);
    return (
        <section class="panel an-panel sc-opps-panel" aria-labelledby="sc-opps-title">
            <div class="sc-opps-head">
                <h2 id="sc-opps-title">Opportunities</h2>
                <p class="muted small sc-sub">Where a little work brings the most clicks, ranked by an estimate of the clicks each could add a month.</p>
            </div>
            {list.length ? (
                <>
                    <div class="sc-filter">
                        <Segmented
                            label="Kind of opportunity"
                            value={kind}
                            onChange={setKind}
                            options={[
                                { value: 'all' as const, label: 'All', count: list.length },
                                ...(['rank', 'snippet', 'drop', 'gap'] as const).filter(k => count(k)).map(k => ({ value: k, label: KINDS[k].plural, count: count(k) }))
                            ]}
                        />
                    </div>
                    <ul class="sc-opps">
                        {(all ? shown : shown.slice(0, SHOWN)).map(o => (
                            <OpportunityRow
                                key={`${o.kind}:${o.slug ?? o.query}`}
                                o={o}
                                posts={posts}
                                onRewrite={onRewrite}
                                rewritten={Boolean(o.slug && rewritten.has(o.slug))}
                                added={Boolean(o.idea || (o.query && added.has(o.query)))}
                                onAdded={() => setAdded(s => new Set([...s, o.query!]))}
                            />
                        ))}
                    </ul>
                    {shown.length > SHOWN ? (
                        <button type="button" class="link-btn an-more" onClick={() => setAll(!all)}>
                            {all ? 'Show fewer' : `Show all ${shown.length}`}
                        </button>
                    ) : null}
                </>
            ) : (
                <p class="muted small an-none">Nothing stands out in this period: no post is close to page one, clicks match positions, and nothing dropped.</p>
            )}
        </section>
    );
}

function why(o: Opportunity, posts: Record<string, PostRef>): string {
    const n = o.searches ?? o.queries?.length ?? 0;
    const across = `across ${n === 1 ? 'one search' : `${n} searches`} with ${compact(o.impressions)} impressions`;
    switch (o.kind) {
        case 'rank':
            return o.target === 3
                ? `Average position ${place(o.position)} ${across}. In the top 3 it could get about ${fmtInt(o.gain)} more clicks a month.`
                : `Average position ${place(o.position)}, on page two, ${across}. On page one it could get about ${fmtInt(o.gain)} more clicks a month.`;
        case 'snippet':
            return `Shows at position ${place(o.position)} ${across}, but ${pct(o.ctr)} click it where results usually get about ${pct(o.typicalCtr, 0)}. A clearer title and description could bring about ${fmtInt(o.gain)} more clicks a month.`;
        case 'drop': {
            const b = o.before!;
            const fell = `Clicks fell ${pct(b.clicks ? (b.clicks - o.clicks) / b.clicks : 0, 0)}, from ${fmtInt(b.clicks)} to ${fmtInt(o.clicks)}.`;
            if (o.cause === 'position') return `${fell} It slipped from position ${place(b.position)} to ${place(o.position)}.`;
            if (o.cause === 'demand') return `${fell} Fewer people searched: impressions fell ${pct(b.impressions ? (b.impressions - o.impressions) / b.impressions : 0, 0)} at about the same position.`;
            return `${fell} It ranks about the same, but fewer people click it: check what else now shows for its searches.`;
        }
        case 'gap': {
            const best = o.best;
            const closest = best ? `the closest is ${placeName(best.path, posts)} at position ${place(best.position)}` : 'nothing from the blog ranks for it';
            return `${compact(o.impressions)} impressions and no post ranks for it: ${closest}. A post in the top 5 could get about ${fmtInt(o.gain)} clicks a month.`;
        }
    }
}

/** A blog page as a sentence names it: a post's title, the front page, a tag's page. */
function placeName(path: string, posts: Record<string, PostRef>): string {
    const n = pageName(path, posts);
    if (n.post) return `“${n.label}”`;
    if (n.label === 'Front page') return 'the front page';
    const m = n.label.match(/^(Tag|Author): (.+)$/);
    if (m) return m[1] === 'Tag' ? `the “${m[2]}” tag page` : `${m[2]}’s author page`;
    return n.label;
}

function OpportunityRow({
    o,
    posts,
    onRewrite,
    rewritten,
    added,
    onAdded
}: {
    o: Opportunity;
    posts: Record<string, PostRef>;
    onRewrite: (o: Opportunity) => void;
    rewritten: boolean;
    added: boolean;
    onAdded: () => void;
}) {
    const k = KINDS[o.kind];
    const post = o.slug ? posts[o.slug] : undefined;
    const [adding, setAdding] = useState(false);
    const addIdea = async () => {
        setAdding(true);
        try {
            const q = o.query!;
            await api('/ideas', {
                body: {
                    ideas: [
                        {
                            title: q.charAt(0).toUpperCase() + q.slice(1),
                            angle: `People search Google for “${q}” and no post on the blog answers it yet. Answer it plainly in the opening paragraph, then cover what someone searching this wants to know next.`,
                            sources: [{ title: `Google results for “${q}”`, url: `https://www.google.com/search?q=${encodeURIComponent(q)}` }],
                            score: Math.max(1, Math.min(10, Math.round(2 + 2 * Math.log10(Math.max(1, o.gain)))))
                        }
                    ]
                }
            });
            onAdded();
            toast('Added to Ideas');
        } catch (err) {
            errorToast(err);
        }
        setAdding(false);
    };
    const searches = post ? (
        <a class="btn ghost sm" href={`#/analytics/post/${post.id}`}>
            See its searches
        </a>
    ) : null;
    const actions: ComponentChildren =
        o.kind === 'snippet' ? (
            canEdit(post) ? (
                <Button size="sm" icon="sparkles" onClick={() => onRewrite(o)}>
                    Rewrite title and description
                </Button>
            ) : (
                searches
            )
        ) : o.kind === 'gap' ? (
            added ? (
                <a class="btn ghost sm sc-added" href="#/ideas">
                    <Icon name="check" size={14} />
                    In Ideas
                </a>
            ) : isEditor() ? (
                <Button size="sm" icon="plus" busy={adding} onClick={addIdea}>
                    Add as idea
                </Button>
            ) : null
        ) : (
            <>
                {searches}
                {post && canEdit(post) ? (
                    <a class="btn ghost sm" href={`#/edit/${post.id}`}>
                        {o.kind === 'rank' ? 'Improve the post' : 'Edit'}
                    </a>
                ) : null}
            </>
        );
    return (
        <li class={`sc-opp kind-${o.kind}`}>
            <div class="sc-opp-main">
                <span class={`sc-kind kind-${o.kind}`}>
                    <Icon name={k.icon} size={13} />
                    {k.label}
                </span>
                <h3 class="sc-opp-title">
                    {o.kind === 'gap' ? (
                        <span class="sc-query">{o.query}</span>
                    ) : post ? (
                        <a href={`#/analytics/post/${post.id}`}>{post.title}</a>
                    ) : (
                        o.slug
                    )}
                </h3>
                <p class="sc-why">{why(o, posts)}</p>
                {o.kind === 'snippet' && post ? <SerpPreview url={postUrl(post.slug)} title={post.metaTitle || post.title} description={post.metaDescription || post.excerpt} small /> : null}
                {o.kind === 'snippet' && rewritten ? (
                    <span class="sc-rewritten" role="status">
                        <Icon name="checkCircle" size={14} />
                        Rewritten. Google shows it once it recrawls the post, usually within days.
                    </span>
                ) : null}
                {o.queries?.length ? (
                    <ul class="sc-chips" aria-label="Top searches">
                        {o.queries.slice(0, 4).map(q => (
                            <li key={q.query} title={`${q.query}: position ${place(q.position)}, ${fmtInt(q.impressions)} impressions, ${fmtInt(q.clicks)} clicks`}>
                                <span class="sc-chip-q">{q.query}</span>
                                <span class="sc-chip-pos">{place(q.position)}</span>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
            <div class="sc-opp-side">
                <span class="sc-gain">
                    <b>+{fmtInt(o.gain)}</b>
                    <span>clicks a month</span>
                </span>
                <div class="sc-actions">{actions}</div>
            </div>
        </li>
    );
}

const postUrl = (slug: string) => {
    const site = session.value?.site.url ?? location.origin;
    return `${site.endsWith('/') ? site : `${site}/`}${slug}/`;
};

// ------------------------------------------------------------------ tables

interface TableRow extends Metrics {
    key: string;
    label: ComponentChildren;
    href?: string;
    prevClicks?: number | null;
    tag?: ComponentChildren;
}

type SortKey = Metric;

/** Searches or pages with their four numbers; any column sorts, and a bar behind each name shows the sorted number. */
function SearchTable({ rows, caption, first, empty, limit = 10 }: { rows: TableRow[]; caption: string; first: string; empty: string; limit?: number }) {
    const [sort, setSort] = useState<{ by: SortKey; asc: boolean }>({ by: 'clicks', asc: false });
    const [all, setAll] = useState(false);
    const sorted = useMemo(() => {
        const v = (r: TableRow) => r[sort.by] ?? (sort.asc ? Infinity : -Infinity);
        return [...rows].sort((a, b) => (sort.asc ? v(a) - v(b) : v(b) - v(a)) || b.clicks - a.clicks);
    }, [rows, sort.by, sort.asc]);
    if (!rows.length) return <p class="muted small an-none">{empty}</p>;
    const barBy = sort.by === 'position' ? 'clicks' : sort.by;
    const max = Math.max(1e-9, ...rows.map(r => r[barBy] ?? 0));
    const change = rows.some(r => r.prevClicks !== undefined && r.prevClicks !== null);
    const shown = all ? sorted : sorted.slice(0, limit);
    const head = (key: SortKey, text: string, cls = '') => (
        <th scope="col" class={`num ${cls}`} aria-sort={sort.by === key ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
            <button
                type="button"
                class={`sc-sort ${sort.by === key ? 'on' : ''}`}
                onClick={() => setSort(s => (s.by === key ? { by: key, asc: !s.asc } : { by: key, asc: key === 'position' }))}
            >
                {text}
                <span class="sc-sort-mark" aria-hidden="true">
                    {sort.by === key ? (sort.asc ? '↑' : '↓') : ''}
                </span>
            </button>
        </th>
    );
    return (
        <div class="sc-table">
            <table class="table sc-grid-table">
                <caption class="an-sr">{caption}. Choose a column heading to sort.</caption>
                <thead>
                    <tr>
                        <th scope="col">{first}</th>
                        {head('clicks', 'Clicks')}
                        {head('impressions', 'Impressions', 'sc-col-imp')}
                        {head('ctr', 'Click rate', 'sc-col-ctr')}
                        {head('position', 'Position')}
                        {change ? (
                            <th scope="col" class="num sc-col-change">
                                Change
                            </th>
                        ) : null}
                    </tr>
                </thead>
                <tbody>
                    {shown.map(r => (
                        <tr key={r.key}>
                            <td class="sc-name">
                                <span class="sc-track">
                                    <span class="sc-bar" style={{ width: `${Math.max(0.5, ((r[barBy] ?? 0) / max) * 100)}%` }} aria-hidden="true" />
                                    <span class="sc-label">{r.href ? <a href={r.href}>{r.label}</a> : r.label}</span>
                                    {r.tag}
                                </span>
                            </td>
                            <td class="num">{fmtInt(r.clicks)}</td>
                            <td class="num sc-col-imp">{fmtInt(r.impressions)}</td>
                            <td class="num sc-col-ctr">{pct(r.ctr)}</td>
                            <td class="num">{place(r.position)}</td>
                            {change ? <td class="num sc-col-change">{r.prevClicks === null || r.prevClicks === undefined ? '' : <Delta now={r.clicks} before={r.prevClicks} vs={'vs the period before'} />}</td> : null}
                        </tr>
                    ))}
                </tbody>
            </table>
            {rows.length > limit ? (
                <button type="button" class="link-btn an-more sc-more" onClick={() => setAll(!all)}>
                    {all ? 'Show fewer' : `Show all ${rows.length}`}
                </button>
            ) : null}
        </div>
    );
}

// ------------------------------------------------------------------ one post

/** A post's search section: its numbers, how it shows in Google, and the searches that bring it. */
export function PostSearch({ id, range }: { id: string; range: RangeKey }) {
    const report = useReport<PostSearchReport>(`/analytics/posts/${id}/search?range=${range}`);
    const [metric, setMetric] = useState<Metric>('clicks');
    const [rewriting, setRewriting] = useState(false);
    const [edited, setEdited] = useState<Partial<PostRef>>({});
    const s = report.data;
    if (!s) return report.error ? <ErrorNote text={report.error} /> : null;
    if (s.status === 'off' || s.status === 'blocked') return <ConnectSearch report={s} brief />;
    if (s.status === 'error' || !s.data) return <Trouble text={s.error} onRetry={() => report.reload(true)} />;
    const d = s.data;
    const post = s.post ? { ...s.post, ...edited } : undefined;
    // Nothing yet (a new post, say): the snippet can still be written before Google shows it.
    const none = !d.totals.impressions && !d.prevTotals?.impressions;
    const days = d.range.days ?? 30;
    const shown = d.shown;
    const low = shown && shown.impressions >= Math.max(80, (100 * days) / 30) && shown.clicks < 0.55 * shown.impressions * shown.typicalCtr ? shown : null;
    // What people search most, which the title and description should answer.
    const top = [...d.queries]
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 5)
        .map(q => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, position: q.position ?? 0 }));
    return (
        <section class={`panel an-panel sc-post ${report.loading ? 'an-busy' : ''}`} aria-labelledby="sc-post-title">
            <div class="an-panel-head">
                <h2 id="sc-post-title">Google search</h2>
                <span class="an-updated">
                    <Freshness report={s} last={d.range.last} onRefresh={() => report.reload(true)} />
                </span>
            </div>
            {s.error ? <Trouble text={s.error} onRetry={() => report.reload(true)} /> : null}
            {none ? (
                <p class="muted small an-none">Google has not shown this post in search in this period. New posts take a few days to appear, and Search Console runs two to three days behind.</p>
            ) : (
                <>
                    <MetricTiles t={d.totals} p={d.prevTotals} r={d.range} metric={metric} setMetric={setMetric} small />
                    <MetricChart d={d} metric={metric} height={180} what="for this post" />
                </>
            )}
            {post ? (
                <div class="sc-snippet">
                    <div class="sc-snippet-preview">
                        <h3 class="an-h3">How it shows in Google</h3>
                        <SerpPreview url={post.url} title={post.metaTitle || post.title} description={post.metaDescription || post.excerpt} />
                    </div>
                    <div class="sc-snippet-side">
                        {low ? (
                            <p class="sc-callout">
                                <Icon name="pointer" size={15} />
                                <span>
                                    <b>Few people click it.</b> {pct(low.clicks / low.impressions)} of {compact(low.impressions)} page-one impressions clicked, where results usually get about {pct(low.typicalCtr, 0)}.
                                </span>
                            </p>
                        ) : (
                            <p class="muted small">The title and description people see in search results.{none ? '' : ' Write them for the searches below.'}</p>
                        )}
                        {canEdit(post) ? (
                            <Button icon="sparkles" size="sm" onClick={() => setRewriting(true)}>
                                Rewrite title and description
                            </Button>
                        ) : null}
                    </div>
                </div>
            ) : null}
            {none ? null : (
                <>
                    <h3 class="an-h3">Searches</h3>
                    <SearchTable
                        caption={`Searches that showed this post, ${periodText(d.range)}`}
                        first="Search"
                        empty="No searches showed this post in this period."
                        rows={d.queries.map(q => {
                            const near = q.position !== null && q.position >= 5 && q.position < 21 && q.impressions >= 10;
                            return {
                                key: q.query,
                                label: q.query,
                                ...q,
                                prevClicks: q.prev ? q.prev.clicks : undefined,
                                tag: near ? <span class="sc-tag kind-rank">Almost page one</span> : null
                            };
                        })}
                    />
                </>
            )}
            {rewriting && post ? (
                <SnippetDialog
                    post={post}
                    searches={top}
                    stats={low ? { position: null, ctr: low.clicks / low.impressions, typicalCtr: low.typicalCtr, impressions: low.impressions } : null}
                    onClose={() => setRewriting(false)}
                    onSaved={patch => setEdited(e => ({ ...e, ...patch }))}
                />
            ) : null}
        </section>
    );
}

// ------------------------------------------------------------------ how a result looks

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A search result as Google draws it: site, address, title and description (titles cut near 60 characters, descriptions near 160). */
function SerpPreview({ url, title, description, small }: { url: string; title: string; description: string | null; small?: boolean }) {
    const site = session.value?.site;
    let crumbs = url;
    try {
        const u = new URL(url);
        crumbs = [u.hostname.replace(/^www\./, ''), ...u.pathname.split('/').filter(Boolean)].join(' › ');
    } catch {
        // Shown as it is.
    }
    return (
        <div class={`sc-serp ${small ? 'small' : ''}`}>
            <div class="sc-serp-top">
                <span class="sc-serp-icon" aria-hidden="true">
                    {site?.icon ? <img src={site.icon} alt="" width={18} height={18} /> : (site?.title ?? '?').slice(0, 1)}
                </span>
                <span class="sc-serp-site">
                    <span class="sc-serp-name">{site?.title}</span>
                    <span class="sc-serp-url">{crumbs}</span>
                </span>
            </div>
            <p class="sc-serp-title">{cut(title, 62)}</p>
            <p class={`sc-serp-desc ${description ? '' : 'auto'}`}>{description ? cut(description, 160) : 'No description: Google picks a passage from the post.'}</p>
        </div>
    );
}

// ------------------------------------------------------------------ rewriting the title and description

/** The suggestions in text that is still arriving, one per line; the last line may be half written. */
function suggestions(text: string, finished: boolean): { kind: 'title' | 'description'; text: string; done: boolean }[] {
    const lines = text.split('\n');
    const out: { kind: 'title' | 'description'; text: string; done: boolean }[] = [];
    lines.forEach((line, i) => {
        const done = finished || i < lines.length - 1;
        const m = line.replace(/^[\s>*_\-\d.)]+/, '').match(/^(title|description)\**\s*:\s*\**\s*(.*)$/i);
        if (!m) return;
        let value = m[2].replace(/\**$/, '').trim().replace(/^["“]/, '');
        if (done) value = value.replace(/["”]$/, '');
        value = value.trim();
        if (value || !done) out.push({ kind: m[1].toLowerCase() as 'title' | 'description', text: value, done });
    });
    return out;
}

/**
 * The post's search settings: its search title and description beside a live preview of
 * the result, the searches that show it, and better options drafted (streamed) from those
 * searches with the editor's /ai/meta flow. Saving a live post updates the site.
 */
function SnippetDialog({
    post: ref,
    searches,
    stats,
    onClose,
    onSaved
}: {
    post: PostRef;
    searches: Searched[];
    stats: { position: number | null; ctr: number | null; typicalCtr: number | null; impressions: number } | null;
    onClose: () => void;
    onSaved: (patch: Partial<PostRef>) => void;
}) {
    const { data: post, error } = useLoad(() => api<Post>(`/posts/${ref.id}`), [ref.id]);
    const [title, setTitle] = useState<string | null>(null);
    const [desc, setDesc] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const run = useAiRun<{ titles: string[]; descriptions: string[]; finishReason?: string }>();
    const ask = (p: Post) =>
        run.start('/ai/meta', {
            title: p.title,
            markdown: p.markdown ?? p.html ?? '',
            model: modelFor('text'),
            searches: searches.map(s => s.query),
            current: { title: p.metaTitle || p.title, description: p.metaDescription || p.customExcerpt || '' }
        });
    useEffect(() => {
        if (post) ask(post);
    }, [post?.id]);
    const writing = run.state === 'working';
    const items = suggestions(run.text, !writing);
    const t = title ?? post?.metaTitle ?? '';
    const dsc = desc ?? post?.metaDescription ?? '';
    const dirty = Boolean(post) && (t.trim() !== (post!.metaTitle ?? '').trim() || dsc.trim() !== (post!.metaDescription ?? '').trim());
    const live = post?.status === 'published';
    const save = async () => {
        setSaving(true);
        try {
            const saved = await api<Post>(`/posts/${ref.id}`, { method: 'PUT', body: { metaTitle: t.trim() || null, metaDescription: dsc.trim() || null } });
            // Search views read titles fresh; the numbers stay cached on the server.
            forgetReports('/analytics/search');
            forgetReports(`/analytics/posts/${ref.id}/search`);
            onSaved({ metaTitle: saved.metaTitle, metaDescription: saved.metaDescription });
            toast(saved.status === 'published' ? 'Saved. The live post is updating.' : 'Saved');
            onClose();
        } catch (err) {
            errorToast(err);
            setSaving(false);
        }
    };
    const pick = (kind: 'title' | 'description', text: string) => (kind === 'title' ? setTitle(text) : setDesc(text));
    const inUse = (kind: 'title' | 'description', text: string) => (kind === 'title' ? t : dsc).trim() === text.trim();
    return (
        <Dialog title="Search title and description" description={ref.title} onClose={onClose} wide>
            {error ? (
                <ErrorNote text={error} />
            ) : !post ? (
                <Loading />
            ) : (
                <div class="sc-rewrite">
                    <div class="sc-rewrite-look">
                        <div class="sc-rewrite-label">
                            <span class="field-label">{dirty ? 'Preview' : 'In Google now'}</span>
                            {stats && stats.ctr !== null && stats.typicalCtr ? (
                                <span class="sc-rewrite-stat">
                                    {pct(stats.ctr)} click{stats.position ? ` at position ${place(stats.position)}` : ''}, typical {pct(stats.typicalCtr, 0)}
                                </span>
                            ) : null}
                        </div>
                        <SerpPreview url={postUrl(post.slug)} title={t.trim() || post.title} description={dsc.trim() || post.customExcerpt} />
                        {searches.length ? (
                            <div class="sc-rewrite-searches">
                                <span class="field-label">What people search</span>
                                <ul class="sc-chips">
                                    {searches.slice(0, 5).map(q => (
                                        <li key={q.query} title={`Position ${place(q.position)}, ${fmtInt(q.impressions)} impressions, ${fmtInt(q.clicks)} clicks`}>
                                            <span class="sc-chip-q">{q.query}</span>
                                            <span class="sc-chip-pos">{compact(q.impressions)}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                    </div>
                    <div class="sc-rewrite-fields">
                        <label class="field">
                            <span class="field-label sc-count-row">
                                Search title
                                <span class={`sc-count ${t.length > 60 ? 'over' : ''}`}>{t.length}/60</span>
                            </span>
                            <input value={t} placeholder={post.title} onInput={e => setTitle(e.currentTarget.value)} />
                        </label>
                        <label class="field">
                            <span class="field-label sc-count-row">
                                Search description
                                <span class={`sc-count ${dsc.length > 155 ? 'over' : ''}`}>{dsc.length}/155</span>
                            </span>
                            <textarea rows={3} value={dsc} placeholder={post.customExcerpt ?? 'Google picks a passage from the post.'} onInput={e => setDesc(e.currentTarget.value)} />
                        </label>
                    </div>
                    <div class="sc-rewrite-ideas" aria-busy={writing}>
                        <div class="sc-rewrite-label">
                            <span class="field-label">
                                <Icon name="sparkles" size={13} /> Better options
                            </span>
                            {!writing && run.state !== 'idle' ? (
                                <button type="button" class="link-btn small" onClick={() => ask(post)}>
                                    {run.state === 'error' ? 'Try again' : 'Suggest again'}
                                </button>
                            ) : null}
                        </div>
                        {writing && !items.length ? <p class="muted small">Written from the post and the searches that show it. They appear here as they are written.</p> : null}
                        {(['title', 'description'] as const).map(kind =>
                            items.some(i => i.kind === kind) ? (
                                <div key={kind} class="sc-options">
                                    <p class="sc-options-head">{kind === 'title' ? 'Titles' : 'Descriptions'}</p>
                                    {items
                                        .filter(i => i.kind === kind)
                                        .map((item, n) => (
                                            <div class={`sc-option ${item.done && inUse(kind, item.text) ? 'used' : ''}`} key={n}>
                                                <span class="sc-option-text">
                                                    {item.text}
                                                    {item.done ? null : <Caret />}
                                                </span>
                                                {item.done ? (
                                                    <span class="sc-option-side">
                                                        <span class={`sc-count ${item.text.length > (kind === 'title' ? 60 : 155) ? 'over' : ''}`}>{item.text.length}</span>
                                                        {inUse(kind, item.text) ? (
                                                            <span class="sc-used">
                                                                <Icon name="check" size={13} />
                                                                In use
                                                            </span>
                                                        ) : (
                                                            <Button size="sm" onClick={() => pick(kind, item.text)}>
                                                                Use
                                                            </Button>
                                                        )}
                                                    </span>
                                                ) : null}
                                            </div>
                                        ))}
                                </div>
                            ) : null
                        )}
                        {run.state === 'error' ? <ErrorNote text={run.error ?? ''} /> : null}
                        {run.state === 'stopped' ? <p class="ai-note sc-flush">Stopped.</p> : null}
                        {run.state === 'done' && !items.length ? (
                            <ErrorNote text={run.result?.finishReason === 'length' ? 'The model stopped before writing any options. Try again.' : 'The model answered in the wrong shape. Try again.'} />
                        ) : null}
                    </div>
                </div>
            )}
            <div class="dialog-actions">
                {writing ? (
                    <>
                        <Working label={run.stage === 'reading' || !run.stage ? 'Reading the post' : items.length ? 'Writing' : 'Thinking'} since={run.startedAt} />
                        <StopButton onClick={run.stop} />
                    </>
                ) : (
                    <Answered run={run} />
                )}
                <a class="btn plain" href={`#/edit/${ref.id}`} onClick={onClose}>
                    Open in the editor
                </a>
                <Button tone="primary" busy={saving} disabled={!dirty} onClick={save}>
                    {live ? 'Save and update the post' : 'Save'}
                </Button>
            </div>
        </Dialog>
    );
}

// ------------------------------------------------------------------ connecting

const usersUrl = (property: string) => `https://search.google.com/search-console/users?resource_id=${encodeURIComponent(property)}`;

function Copy({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <span class="an-cmd sc-copy">
            <code>{text}</code>
            <button
                type="button"
                class="an-toggle"
                aria-label={`Copy ${label}`}
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

/**
 * The four things Search Console needs, each marked done, to do now, or next. Which one is
 * "now" comes from Google's own answer: the API is off, or the account cannot read the property.
 */
function ConnectSearch({ report, onRetry, busy, brief }: { report: FromSearch<unknown>; onRetry?: () => void; busy?: boolean; brief?: boolean }) {
    const s = report.setup;
    const p = report.status === 'blocked' ? report.problem : undefined;
    if (brief)
        return (
            <div class="an-connect brief sc-connect-brief">
                <span class="an-connect-mark sc-mark" aria-hidden="true">
                    <Icon name="search" size={18} />
                </span>
                <span>
                    <b>See the searches that bring readers here.</b>{' '}
                    {p?.kind === 'api'
                        ? 'Search Console is almost connected: its API needs turning on.'
                        : p?.kind === 'access'
                          ? 'Search Console is almost connected: the service account needs access to the property.'
                          : 'Connect Google Search Console to see them with each post.'}
                </span>
                <a class="btn ghost" href="#/analytics/search">
                    {p ? 'Finish setup' : 'Connect'}
                </a>
            </div>
        );
    const keyTrouble = s.keyError ?? (p?.kind === 'key' || p?.kind === 'token' ? p.message : null);
    const done = { key: s.key && !keyTrouble, property: Boolean(s.property), api: p?.kind === 'access', access: false };
    const order = ['key', 'property', 'api', 'access'] as const;
    const now = order.find(k => !done[k]);
    const state = (k: (typeof order)[number]) => (done[k] ? 'done' : k === now ? 'now' : 'next');
    const project = p?.kind === 'api' && p.project ? p.project : s.project;
    const enable = (p?.kind === 'api' ? p.enableUrl : null) ?? s.enableUrl;
    const steps: { id: (typeof order)[number]; title: string; body: ComponentChildren }[] = [
        {
            id: 'key',
            title: 'A service account key',
            body: done.key ? (
                <>
                    <span class="sc-done-value">{s.email}</span>
                    {s.project ? <span class="muted"> in project {s.project}</span> : null}
                </>
            ) : (
                <>
                    {keyTrouble ? <span class="sc-step-error">{keyTrouble}</span> : null}
                    In Google Cloud, open IAM and admin, then Service accounts. Create one (it needs no roles), then under Keys add a JSON key. Store the file as a secret, as it is or base64 encoded:
                    <Copy text="npx wrangler secret put GOOGLE_SERVICE_ACCOUNT" label="the command" />
                </>
            )
        },
        {
            id: 'property',
            title: 'Which property to read',
            body: done.property ? (
                <span class="sc-done-value">{s.property}</span>
            ) : (
                <>
                    Name the property the way Search Console does, under <code>[vars]</code> in <code>wrangler.toml</code>, then deploy. A domain property starts with <code>sc-domain:</code>; a URL-prefix one is the full address.
                    <Copy text={`GSC_PROPERTY = "${s.suggested}"`} label="the setting" />
                </>
            )
        },
        {
            id: 'api',
            title: 'Turn on the Search Console API',
            body: done.api ? (
                <span class="muted">On. Google answered about the property, so the API is working.</span>
            ) : (
                <>
                    {state('api') === 'now' ? 'Google says the API is off in the key’s project' : 'In the Google Cloud project the key belongs to'}
                    {project ? (
                        <>
                            {' '}
                            (<b>{s.project && project !== s.project ? `${s.project}, number ${project}` : project}</b>)
                        </>
                    ) : null}
                    {state('api') === 'now' ? '. Turn it on, wait a minute, then check again.' : ', turn on the Google Search Console API.'}
                    {enable ? (
                        <span class="sc-step-actions">
                            <a class={`btn ${state('api') === 'now' ? 'primary' : 'ghost'} sm`} href={enable} target="_blank" rel="noreferrer">
                                Enable the API
                                <Icon name="arrowUpRight" size={13} />
                            </a>
                        </span>
                    ) : null}
                </>
            )
        },
        {
            id: 'access',
            title: 'Let the service account read the property',
            body: (
                <>
                    {state('access') === 'now' ? 'Google says this account cannot read the property yet. ' : ''}In Search Console, open Settings, then Users and permissions{s.property ? <> for <b>{s.property}</b></> : null}. Choose Add user, enter this address and pick <b>Restricted</b>:
                    {s.email ? <Copy text={s.email} label="the service account address" /> : <span class="muted"> (the service account’s address, shown once the key is set)</span>}
                    {s.property ? (
                        <span class="sc-step-actions">
                            <a class={`btn ${state('access') === 'now' ? 'primary' : 'ghost'} sm`} href={usersUrl(s.property)} target="_blank" rel="noreferrer">
                                Open Users and permissions
                                <Icon name="arrowUpRight" size={13} />
                            </a>
                        </span>
                    ) : null}
                    {state('access') === 'now' ? <span class="sc-step-hint">If the property has another name in Search Console, set GSC_PROPERTY to it exactly.</span> : null}
                </>
            )
        }
    ];
    const left = steps.filter(st => !done[st.id]).length;
    return (
        <section class="an-connect sc-connect" aria-labelledby="sc-connect-title">
            <div class="an-connect-copy">
                <h2 id="sc-connect-title">Connect Google Search Console</h2>
                <p class="muted">
                    See the searches that bring readers to each post, and the posts one push away from more clicks.{' '}
                    {p ? `${left === 1 ? 'One step' : `${left} steps`} left.` : ''}
                </p>
                <ol class="an-steps sc-steps">
                    {steps.map((st, i) => (
                        <li key={st.id} class={`sc-step ${state(st.id)}`} aria-current={state(st.id) === 'now' ? 'step' : undefined}>
                            <span class="an-step-mark" aria-hidden="true">
                                {done[st.id] ? '✓' : i + 1}
                            </span>
                            <div>
                                <b>{st.title}</b>
                                {done[st.id] ? <span class="an-step-done">Done</span> : state(st.id) === 'now' ? <span class="sc-step-now">Do this now</span> : null}
                                <div class="muted small an-step-body">{st.body}</div>
                            </div>
                        </li>
                    ))}
                </ol>
                {onRetry && (p || report.status === 'error') ? (
                    <div class="sc-connect-foot">
                        <Button icon="refresh" busy={busy} onClick={onRetry}>
                            Check again
                        </Button>
                        {p && p.kind !== 'key' && p.kind !== 'token' ? (
                            <details class="sc-said">
                                <summary>What Google said</summary>
                                <p>{p.message}</p>
                            </details>
                        ) : null}
                    </div>
                ) : null}
            </div>
            <div class="an-connect-side">
                <svg class="an-preview" viewBox="0 0 240 64" preserveAspectRatio="none" aria-hidden="true">
                    <path class="an-preview-fill" d="M0,54 C18,50 30,52 46,44 S78,40 96,36 S126,30 146,22 S186,20 206,12 S230,8 240,6 V64 H0 Z" />
                    <path class="an-preview-line" d="M0,54 C18,50 30,52 46,44 S78,40 96,36 S126,30 146,22 S186,20 206,12 S230,8 240,6" />
                </svg>
                <b>What you will see</b>
                <ul class="an-gets">
                    <li>Clicks, impressions, click rate and position, day by day, against the period before</li>
                    <li>The searches behind every post</li>
                    <li>Posts almost on page one, and the clicks the top would bring</li>
                    <li>Titles that draw few clicks for their rank, with better ones drafted for you</li>
                    <li>Searches no post answers yet, one click from an idea</li>
                </ul>
                <p class="muted small">Only pages under the blog’s address count. Search Console runs two to three days behind, and so will this.</p>
            </div>
        </section>
    );
}
