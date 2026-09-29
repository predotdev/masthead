import { useState } from 'preact/hooks';
import { api, session, type Tag } from '../api';
import { Button, Dialog, Empty, ErrorNote, Field, PageHead, Pill, TableSkeleton, errorToast, toast, useLoad } from '../ui';
import { SeoFields } from './seo-fields';

/** A tag's address as the server will make it from its name. */
const slugOf = (name: string) =>
    name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

export function Tags() {
    const { data, error, loading, reload } = useLoad(() => api<Tag[]>('/tags'), []);
    const [editing, setEditing] = useState<Partial<Tag> | null>(null);
    const [tagging, setTagging] = useState(false);
    const role = session.value?.user.role;
    return (
        <div>
            <PageHead title="Tags" description="Group posts by topic. Internal tags organize posts without showing readers.">
                {role === 'owner' || role === 'admin' || role === 'editor' ? (
                    <Button
                        busy={tagging}
                        title="Published posts with no public tag get one to three picked from this list."
                        onClick={async () => {
                            setTagging(true);
                            try {
                                const r = await api<{ checked: number; tagged: number }>('/posts/auto-tag', { method: 'POST' });
                                toast(r.checked ? `Picked tags for ${r.tagged} of ${r.checked} posts without a topic` : 'Every published post has a topic');
                                reload();
                            } catch (err) {
                                errorToast(err);
                            } finally {
                                setTagging(false);
                            }
                        }}
                    >
                        Tag untagged posts
                    </Button>
                ) : null}
                <Button tone="primary" icon="plus" onClick={() => setEditing({ name: '', visibility: 'public' })}>
                    New tag
                </Button>
            </PageHead>
            {error ? <ErrorNote text={error} /> : null}
            {loading && !data ? (
                <TableSkeleton rows={8} columns={4} />
            ) : !data?.length ? (
                <Empty
                    icon="tags"
                    title="No tags yet"
                    action={
                        <Button tone="primary" icon="plus" onClick={() => setEditing({ name: '', visibility: 'public' })}>
                            New tag
                        </Button>
                    }
                >
                    Each public tag gets its own page on the site.
                </Empty>
            ) : (
                <div class="table-wrap">
                    <table class="table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Address</th>
                                <th>Visibility</th>
                                <th class="num">Posts</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.map(t => (
                                <tr key={t.id} class="row-link" onClick={() => setEditing(t)}>
                                    <td class="title-cell">{t.name}</td>
                                    <td class="muted">tag/{t.slug}/</td>
                                    <td>{t.visibility === 'internal' ? <Pill>internal</Pill> : <Pill tone="green">public</Pill>}</td>
                                    <td class="num">{t.posts ?? 0}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {editing ? (
                <Dialog title={editing.id ? 'Edit tag' : 'New tag'} onClose={() => setEditing(null)} wide>
                    <form
                        class="stack"
                        onSubmit={async e => {
                            e.preventDefault();
                            try {
                                await api(editing.id ? `/tags/${editing.id}` : '/tags', { method: editing.id ? 'PUT' : 'POST', body: editing });
                                toast('Saved');
                                setEditing(null);
                                reload();
                            } catch (err) {
                                errorToast(err);
                            }
                        }}
                    >
                        <Field label="Name">
                            <input required value={editing.name ?? ''} onInput={e => setEditing({ ...editing, name: e.currentTarget.value })} />
                        </Field>
                        <Field label="Address" hint="Letters, numbers and dashes.">
                            <input value={editing.slug ?? ''} onInput={e => setEditing({ ...editing, slug: e.currentTarget.value })} />
                        </Field>
                        <Field label="Description">
                            <textarea rows={3} value={editing.description ?? ''} onInput={e => setEditing({ ...editing, description: e.currentTarget.value })} />
                        </Field>
                        <label class="check">
                            <input
                                type="checkbox"
                                checked={editing.visibility === 'internal'}
                                onChange={e => setEditing({ ...editing, visibility: e.currentTarget.checked ? 'internal' : 'public' })}
                            />{' '}
                            Internal (organizes posts, never shown to readers)
                        </label>
                        {editing.visibility === 'internal' ? null : (
                            <SeoFields
                                kind="topic"
                                id={editing.id}
                                name={editing.name ?? ''}
                                address={`${session.value?.site.url ?? ''}tag/${editing.slug || slugOf(editing.name ?? '')}/`}
                                description={editing.description}
                                value={editing}
                                onChange={patch => setEditing(cur => ({ ...cur, ...patch }))}
                            />
                        )}
                        <div class="dialog-actions">
                            {editing.id ? (
                                <Button
                                    tone="danger"
                                    onClick={async () => {
                                        if (!window.confirm('Delete this tag? Posts keep their other tags.')) return;
                                        await api(`/tags/${editing.id}`, { method: 'DELETE' }).catch(errorToast);
                                        setEditing(null);
                                        reload();
                                    }}
                                >
                                    Delete
                                </Button>
                            ) : null}
                            <div class="grow" />
                            <Button onClick={() => setEditing(null)}>Cancel</Button>
                            <Button tone="primary" type="submit">
                                Save
                            </Button>
                        </div>
                    </form>
                </Dialog>
            ) : null}
        </div>
    );
}
