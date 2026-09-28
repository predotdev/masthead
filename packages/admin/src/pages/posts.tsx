import { useEffect, useState } from 'preact/hooks';
import { api, fmtDate, fmtNum, type Post, type Staff } from '../api';
import { Icon } from '../icons';
import { Avatar, Button, Empty, ErrorNote, PageHead, Pill, Segmented, TableSkeleton, errorToast, useLoad } from '../ui';
import { REVIEW_LABEL, REVIEW_TONE } from './review-status';

const STATUS_TONE = { draft: 'neutral', scheduled: 'amber', published: 'green' } as const;
const FILTERS = [
    ['', 'All'],
    ['draft', 'Drafts'],
    ['in_review', 'In review'],
    ['scheduled', 'Scheduled'],
    ['published', 'Published']
] as const;

/** "drafts", "scheduled pages", "posts": what a filter shows, for empty states. */
const phrase = (status: string, noun: string) => (status === 'draft' ? 'drafts' : status === 'in_review' ? `${noun}s in review` : status ? `${status} ${noun}s` : `${noun}s`);
/** The filter as a query: "In review" is a review status, the rest are post statuses. */
const filterQuery = (status: string) => (status === 'in_review' ? '&review=in_review' : status ? `&status=${status}` : '');

/** Creates an empty post or page and opens it in the editor. */
export async function createPost(type: 'post' | 'page') {
    try {
        const post = await api<Post>('/posts', { body: { type, title: '' } });
        location.hash = `#/edit/${post.id}`;
    } catch (err) {
        errorToast(err);
    }
}

/**
 * Posts and pages on one screen. Most blogs have a page or two (an About),
 * too few for their own place in the menu; #/pages opens this with Pages picked.
 */
export function Posts({ type }: { type: 'post' | 'page' }) {
    const [status, setStatus] = useState('');
    const [search, setSearch] = useState('');
    const [q, setQ] = useState('');
    const [creating, setCreating] = useState(false);
    // Search as you type, without a request per keystroke.
    useEffect(() => {
        const t = setTimeout(() => setQ(search.trim()), 200);
        return () => clearTimeout(t);
    }, [search]);

    const { data, error, loading } = useLoad(
        () => api<{ items: Post[]; total: number }>(`/posts?type=${type}&limit=200${filterQuery(status)}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
        [type, status, q]
    );
    const people = useLoad(() => api<Staff[]>('/staff'), []);
    // Views come from PostHog when it is connected; the list never waits for them.
    const stats = useLoad(
        () => (type === 'post' ? api<{ status: string; data?: { posts: { slug: string | null; views: number }[] } }>('/analytics/web?range=30').catch(() => null) : Promise.resolve(null)),
        [type]
    );
    const counts = useLoad(() => Promise.all((['post', 'page'] as const).map(t => api<{ total: number }>(`/posts?type=${t}&limit=1`).then(r => r.total))), []);

    const staff = new Map((people.data ?? []).map(s => [s.id, s]));
    const views = stats.data?.status === 'ok' && stats.data.data ? new Map(stats.data.data.posts.map(p => [p.slug ?? '', p.views])) : null;
    const noun = type === 'post' ? 'post' : 'page';
    const filtered = !!(q || status);

    const create = async () => {
        setCreating(true);
        await createPost(type);
        setCreating(false);
    };
    const newButton = (
        <Button tone="primary" icon="plus" onClick={create} busy={creating}>
            New {noun}
        </Button>
    );

    return (
        <div class="posts">
            <PageHead title="Posts" description="Write, schedule and publish. Standalone pages, like About, are under Pages.">
                {newButton}
            </PageHead>
            <div class="toolbar">
                <div class="toolbar-group">
                    <Segmented
                        label="Show"
                        value={type}
                        options={[
                            { value: 'post', label: 'Posts', count: counts.data?.[0] },
                            { value: 'page', label: 'Pages', count: counts.data?.[1] }
                        ]}
                        onChange={v => (location.hash = v === 'page' ? '#/pages' : '#/posts')}
                    />
                    <div class="tabs" role="tablist" aria-label="Status">
                        {FILTERS.map(([v, label]) => (
                            <button key={v} role="tab" aria-selected={status === v} class={`tab ${status === v ? 'on' : ''}`} onClick={() => setStatus(v)}>
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
                <input class="search" type="search" placeholder="Search titles" aria-label="Search titles" value={search} onInput={e => setSearch(e.currentTarget.value)} />
            </div>
            {error ? <ErrorNote text={error} /> : null}
            {!data && !error ? (
                <TableSkeleton rows={8} columns={type === 'post' ? 5 : 4} />
            ) : data && data.items.length === 0 ? (
                filtered ? (
                    <Empty icon="search" title="Nothing matches" action={<Button onClick={() => (setSearch(''), setQ(''), setStatus(''))}>Clear filters</Button>}>
                        {q ? `No ${phrase(status, noun)} match "${q}".` : `No ${phrase(status, noun)}.`}
                    </Empty>
                ) : (
                    <Empty icon="posts" title={`No ${noun}s yet`} action={newButton}>
                        {type === 'post' ? 'Write the first one. Drafts save as you type.' : 'Pages hold writing that stands on its own, like About or Contact.'}
                    </Empty>
                )
            ) : data ? (
                <>
                    <div class={`table-wrap${loading ? ' is-loading' : ''}`}>
                        <table class="table posts-table">
                            <thead>
                                <tr>
                                    <th class="col-title">Title</th>
                                    <th class="col-status">Status</th>
                                    <th class="col-author">Author</th>
                                    <th class="col-date">Date</th>
                                    {views ? <th class="num">Views, 30 days</th> : null}
                                    {type === 'post' ? <th class="num">Emailed to</th> : null}
                                    {type === 'post' ? (
                                        <th class="col-stats">
                                            <span class="an-sr">Analytics</span>
                                        </th>
                                    ) : null}
                                </tr>
                            </thead>
                            <tbody>
                                {data.items.map(p => {
                                    const authors = p.authors.map(a => staff.get(a)).filter((s): s is Staff => !!s);
                                    const when = p.publishedAt ?? p.updatedAt;
                                    return (
                                        <tr key={p.id} class="row-link" onClick={() => (location.hash = `#/edit/${p.id}`)}>
                                            <td class="col-title">
                                                <span class="post-title">
                                                    <a href={`#/edit/${p.id}`} class={`title-cell${p.title ? '' : ' untitled'}`} onClick={e => e.stopPropagation()}>
                                                        {p.title || 'Untitled'}
                                                    </a>
                                                    {p.featured ? (
                                                        <span class="featured" title="Featured">
                                                            <Icon name="star" size={12} />
                                                        </span>
                                                    ) : null}
                                                </span>
                                            </td>
                                            <td class="col-status">
                                                <span class="status-pills">
                                                    <Pill tone={STATUS_TONE[p.status]} dot>
                                                        {p.status}
                                                    </Pill>
                                                    {p.review && p.status !== 'published' ? (
                                                        <span class={`pill ${REVIEW_TONE[p.review.status]} review-pill`} title={p.review.status === 'in_review' ? `${p.review.approved} of ${p.review.reviewers} approved` : undefined}>
                                                            {REVIEW_LABEL[p.review.status]}
                                                        </span>
                                                    ) : null}
                                                </span>
                                            </td>
                                            <td class="col-author">
                                                {authors.length ? (
                                                    <span class="author">
                                                        <Avatar name={authors[0].name} src={authors[0].profileImage} size={20} />
                                                        <span class="author-name">
                                                            {authors[0].name}
                                                            {authors.length > 1 ? <span class="muted"> +{authors.length - 1}</span> : null}
                                                        </span>
                                                    </span>
                                                ) : (
                                                    <span class="faint">None</span>
                                                )}
                                            </td>
                                            <td class="col-date nowrap muted" title={`${p.status === 'published' ? 'Published' : p.status === 'scheduled' ? 'Scheduled for' : p.publishedAt ? 'Publish date' : 'Updated'} ${new Date(when).toLocaleString()}`}>
                                                {fmtDate(when)}
                                            </td>
                                            {views ? <td class="num">{p.status === 'published' ? fmtNum(views.get(p.slug) ?? 0) : <span class="faint">–</span>}</td> : null}
                                            {type === 'post' ? <td class="num muted">{p.newsletter ? fmtNum(p.newsletter.recipients) : <span class="faint">–</span>}</td> : null}
                                            {type === 'post' ? (
                                                <td class="col-stats">
                                                    {p.status === 'published' ? (
                                                        <a class="an-stats-link" href={`#/analytics/post/${p.id}`} title="Analytics" aria-label={`Analytics for ${p.title || 'Untitled'}`} onClick={e => e.stopPropagation()}>
                                                            <Icon name="analytics" size={16} />
                                                        </a>
                                                    ) : null}
                                                </td>
                                            ) : null}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <p class="table-foot">
                        {data.total > data.items.length ? `Showing ${fmtNum(data.items.length)} of ${fmtNum(data.total)} ${noun}s` : `${fmtNum(data.total)} ${noun}${data.total === 1 ? '' : 's'}`}
                    </p>
                </>
            ) : null}
        </div>
    );
}
