import { useState } from 'preact/hooks';
import { api, fmtNum, type Post } from '../api';
import { ErrorNote, Loading, PageHead, useLoad } from '../ui';

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
    signups: { slug: string; signups: number }[];
    updatedAt: string;
}

const RANGES = [7, 30, 90];

/** What readers do with each post: views, how many read it through, clicks into the product, subscribes and signups. */
export function Analytics() {
    const [days, setDays] = useState(30);
    const { data, error } = useLoad(() => Promise.all([api<SiteStats>(`/analytics?days=${days}`), api<{ items: Post[] }>('/posts?type=post&status=published&limit=200')]), [days]);
    if (error) return <ErrorNote text={error} />;
    if (!data) return <Loading />;
    const [stats, { items: posts }] = data;
    const titles = new Map(posts.map(p => [p.slug, p]));
    const signups = new Map(stats.signups.map(s => [s.slug, s.signups]));
    const total = stats.posts.reduce(
        (t, p) => ({ views: t.views + p.views, readers: t.readers + p.readers, reads: t.reads + p.reads, cta: t.cta + p.ctaClicks, subs: t.subs + p.subscribes }),
        { views: 0, readers: 0, reads: 0, cta: 0, subs: 0 }
    );
    const allSignups = stats.signups.reduce((n, s) => n + s.signups, 0);

    return (
        <div>
            <PageHead title="Analytics">
                <div class="tabs" role="tablist">
                    {RANGES.map(d => (
                        <button key={d} class={`tab ${d === days ? 'on' : ''}`} onClick={() => setDays(d)} role="tab" aria-selected={d === days}>
                            {d} days
                        </button>
                    ))}
                </div>
            </PageHead>
            {!stats.configured ? (
                <div class="panel">
                    <h2>Connect PostHog to see what readers do</h2>
                    <p class="muted">
                        Pages already send views, reads, clicks and subscribes to PostHog when <code>POSTHOG_KEY</code> is set. To show them here, add a personal API key with query access as the <code>POSTHOG_PERSONAL_API_KEY</code> secret and the project's id as{' '}
                        <code>POSTHOG_PROJECT_ID</code>.
                    </p>
                </div>
            ) : (
                <>
                    <div class="stats">
                        <Stat label="Post views" value={total.views} />
                        <Stat label="Readers" value={total.readers} hint="people, per post, summed" />
                        <Stat label="Read through" value={total.views ? `${Math.round((total.reads / total.views) * 100)}%` : '–'} hint="scrolled past 60%" />
                        <Stat label="Clicks into the product" value={total.cta} />
                        <Stat label="Subscribes" value={total.subs} />
                        <Stat label="Signups after reading" value={allSignups} />
                    </div>
                    <Daily daily={stats.daily} />
                    <div class="table-wrap">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>Post</th>
                                    <th class="num">Views</th>
                                    <th class="num">Readers</th>
                                    <th class="num">Read through</th>
                                    <th class="num">Product clicks</th>
                                    <th class="num">Subscribes</th>
                                    <th class="num">Signups</th>
                                </tr>
                            </thead>
                            <tbody>
                                {stats.posts.map(p => {
                                    const post = titles.get(p.slug);
                                    return (
                                        <tr key={p.slug}>
                                            <td>{post ? <a class="title-cell" href={`#/edit/${post.id}`}>{post.title}</a> : <span class="muted">{p.slug}</span>}</td>
                                            <td class="num">{fmtNum(p.views)}</td>
                                            <td class="num">{fmtNum(p.readers)}</td>
                                            <td class="num">{p.views ? `${Math.round((p.reads / p.views) * 100)}%` : '–'}</td>
                                            <td class="num">{fmtNum(p.ctaClicks)}</td>
                                            <td class="num">{fmtNum(p.subscribes)}</td>
                                            <td class="num">{fmtNum(signups.get(p.slug) ?? 0)}</td>
                                        </tr>
                                    );
                                })}
                                {stats.posts.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} class="muted">
                                            No post views in this period yet.
                                        </td>
                                    </tr>
                                ) : null}
                            </tbody>
                        </table>
                    </div>
                    {stats.sources.length ? (
                        <section class="panel" style={{ marginTop: '16px' }}>
                            <h2>Where readers come from</h2>
                            <ul class="bars">
                                {stats.sources.map(s => (
                                    <li key={s.source}>
                                        <span class="bar-label">{s.source === '$direct' ? 'Direct or email' : s.source}</span>
                                        <span class="bar" style={{ width: `${Math.max(2, (s.views / stats.sources[0].views) * 100)}%` }} />
                                        <span class="bar-value">{fmtNum(s.views)}</span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ) : null}
                    <p class="muted small">From PostHog, production pages only, updated {new Date(stats.updatedAt).toLocaleTimeString()} (refreshes every 10 minutes).</p>
                </>
            )}
        </div>
    );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
    return (
        <div class="stat" title={hint}>
            <span class="stat-label">{label}</span>
            <span class="stat-value">{typeof value === 'number' ? fmtNum(value) : value}</span>
        </div>
    );
}

/** Post views per day: one bar per day, the value on hover. */
function Daily({ daily }: { daily: SiteStats['daily'] }) {
    if (!daily.length) return null;
    const max = Math.max(...daily.map(d => d.views), 1);
    return (
        <div class="daily" role="img" aria-label={`Post views per day, up to ${max}`}>
            {daily.map(d => (
                <span key={d.day} class="daily-bar" style={{ height: `${Math.max(2, (d.views / max) * 100)}%` }} title={`${d.day}: ${fmtNum(d.views)} views, ${fmtNum(d.readers)} readers`} />
            ))}
        </div>
    );
}
