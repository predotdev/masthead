import { useState } from 'preact/hooks';
import { api, fmtDate, fmtNum, type Post, type Staff } from '../api';
import { Button, Empty, ErrorNote, Loading, PageHead, Pill, errorToast, useLoad } from '../ui';

const STATUS_TONE = { draft: 'neutral', scheduled: 'amber', published: 'green' } as const;

export function Posts({ type }: { type: 'post' | 'page' }) {
    const [status, setStatus] = useState('');
    const [q, setQ] = useState('');
    const [creating, setCreating] = useState(false);
    const { data, error, loading } = useLoad(
        () =>
            Promise.all([
                api<{ items: Post[]; total: number }>(`/posts?type=${type}&limit=200${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
                api<Staff[]>('/staff'),
                type === 'post' ? api<{ configured: boolean; posts: { slug: string; views: number }[] }>('/analytics?days=30').catch(() => null) : Promise.resolve(null)
            ]),
        [type, status, q]
    );
    const staff = new Map((data?.[1] ?? []).map(s => [s.id, s.name]));
    const views = data?.[2]?.configured ? new Map(data[2].posts.map(p => [p.slug, p.views])) : null;

    const create = async () => {
        setCreating(true);
        try {
            const post = await api<Post>('/posts', { body: { type, title: '' } });
            location.hash = `#/edit/${post.id}`;
        } catch (err) {
            errorToast(err);
            setCreating(false);
        }
    };

    return (
        <div>
            <PageHead title={type === 'post' ? 'Posts' : 'Pages'}>
                <Button tone="primary" onClick={create} busy={creating}>
                    New {type}
                </Button>
            </PageHead>
            <div class="toolbar">
                <div class="tabs" role="tablist">
                    {[
                        ['', 'All'],
                        ['draft', 'Drafts'],
                        ['scheduled', 'Scheduled'],
                        ['published', 'Published']
                    ].map(([v, label]) => (
                        <button key={v} role="tab" aria-selected={status === v} class={`tab ${status === v ? 'on' : ''}`} onClick={() => setStatus(v)}>
                            {label}
                        </button>
                    ))}
                </div>
                <input class="search" type="search" placeholder="Search titles" value={q} onInput={e => setQ(e.currentTarget.value)} />
            </div>
            {error ? <ErrorNote text={error} /> : null}
            {loading && !data ? (
                <Loading />
            ) : data && data[0].items.length === 0 ? (
                <Empty title={q || status ? 'Nothing matches.' : `No ${type}s yet.`} />
            ) : (
                <div class="table-wrap">
                    <table class="table">
                        <thead>
                            <tr>
                                <th>Title</th>
                                <th>Status</th>
                                <th>Author</th>
                                <th>Date</th>
                                {views ? <th class="num">Views, 30 days</th> : null}
                                {type === 'post' ? <th class="num">Emailed to</th> : null}
                            </tr>
                        </thead>
                        <tbody>
                            {data?.[0].items.map(p => (
                                <tr key={p.id} class="row-link" onClick={() => (location.hash = `#/edit/${p.id}`)}>
                                    <td>
                                        <a href={`#/edit/${p.id}`} class="title-cell">
                                            {p.title || 'Untitled'}
                                        </a>
                                        {p.bodyFormat === 'html' ? <span class="muted small"> · imported</span> : null}
                                    </td>
                                    <td>
                                        <Pill tone={STATUS_TONE[p.status]}>{p.status}</Pill>
                                    </td>
                                    <td class="muted">{p.authors.map(a => staff.get(a) ?? '').filter(Boolean).join(', ')}</td>
                                    <td class="muted nowrap">{fmtDate(p.publishedAt ?? p.updatedAt)}</td>
                                    {views ? <td class="num">{p.status === 'published' ? fmtNum(views.get(p.slug) ?? 0) : ''}</td> : null}
                                    {type === 'post' ? <td class="num muted">{p.newsletter ? fmtNum(p.newsletter.recipients) : ''}</td> : null}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
