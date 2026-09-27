import { useState } from 'preact/hooks';
import { api, fmtDate, type Post } from '../api';
import { Button, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Pill, errorToast, toast, useLoad } from '../ui';

interface Idea {
    id: string;
    title: string;
    angle: string | null;
    series: string | null;
    sources: { title?: string; url?: string; summary?: string }[];
    score: number | null;
    created_at: string;
}

export function Ideas() {
    const { data, error, loading, reload } = useLoad(() => api<Idea[]>('/ideas'), []);
    const [busy, setBusy] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);

    const draft = async (idea: Idea) => {
        setBusy(idea.id);
        try {
            const { post } = await api<{ post: Post }>(`/ideas/${idea.id}/draft`, { method: 'POST' });
            toast('Draft ready');
            location.hash = `#/edit/${post.id}`;
        } catch (err) {
            errorToast(err);
            setBusy(null);
        }
    };

    return (
        <div>
            <PageHead title="Ideas">
                <Button tone="primary" onClick={() => setAdding(true)}>
                    Add idea
                </Button>
            </PageHead>
            <p class="muted lead">
                Story ideas with their sources. The studio CLI fills this from your repositories, RL tasks and projects: <code>masthead studio ideas</code>.
            </p>
            {error ? <ErrorNote text={error} /> : null}
            {loading && !data ? (
                <Loading />
            ) : !data?.length ? (
                <Empty title="No ideas waiting." />
            ) : (
                <div class="cards">
                    {data.map(idea => (
                        <article class="card" key={idea.id}>
                            <div class="row between">
                                {idea.series ? <Pill>{idea.series}</Pill> : <span />}
                                <span class="muted small">{fmtDate(idea.created_at)}</span>
                            </div>
                            <h3>{idea.title}</h3>
                            {idea.angle ? <p class="muted">{idea.angle}</p> : null}
                            {idea.sources.length ? (
                                <ul class="sources">
                                    {idea.sources.slice(0, 6).map((s, i) => (
                                        <li key={i}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a> : s.title}</li>
                                    ))}
                                </ul>
                            ) : null}
                            <div class="row">
                                <Button tone="primary" busy={busy === idea.id} onClick={() => draft(idea)}>
                                    Draft it
                                </Button>
                                <Button
                                    onClick={async () => {
                                        await api(`/ideas/${idea.id}`, { method: 'PUT', body: { status: 'dismissed' } }).catch(errorToast);
                                        reload();
                                    }}
                                >
                                    Dismiss
                                </Button>
                            </div>
                        </article>
                    ))}
                </div>
            )}
            {adding ? <AddIdea onClose={() => (setAdding(false), reload())} /> : null}
        </div>
    );
}

function AddIdea({ onClose }: { onClose: () => void }) {
    const [title, setTitle] = useState('');
    const [angle, setAngle] = useState('');
    const [links, setLinks] = useState('');
    return (
        <Dialog title="Add an idea" onClose={onClose}>
            <form
                class="stack"
                onSubmit={async e => {
                    e.preventDefault();
                    try {
                        await api('/ideas', { body: { ideas: [{ title, angle, sources: links.split(/\s+/).filter(Boolean).map(url => ({ url })) }] } });
                        onClose();
                    } catch (err) {
                        errorToast(err);
                    }
                }}
            >
                <Field label="Working title">
                    <input required value={title} onInput={e => setTitle(e.currentTarget.value)} />
                </Field>
                <Field label="Angle">
                    <textarea rows={3} value={angle} onInput={e => setAngle(e.currentTarget.value)} />
                </Field>
                <Field label="Source links" hint="One per line.">
                    <textarea rows={3} value={links} onInput={e => setLinks(e.currentTarget.value)} />
                </Field>
                <div class="dialog-actions">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button tone="primary" type="submit">
                        Add
                    </Button>
                </div>
            </form>
        </Dialog>
    );
}
