import { useState } from 'preact/hooks';
import { api, type Tag } from '../api';
import { Button, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Pill, errorToast, toast, useLoad } from '../ui';

export function Tags() {
    const { data, error, loading, reload } = useLoad(() => api<Tag[]>('/tags'), []);
    const [editing, setEditing] = useState<Partial<Tag> | null>(null);
    return (
        <div>
            <PageHead title="Tags">
                <Button tone="primary" onClick={() => setEditing({ name: '', visibility: 'public' })}>
                    New tag
                </Button>
            </PageHead>
            {error ? <ErrorNote text={error} /> : null}
            {loading && !data ? (
                <Loading />
            ) : !data?.length ? (
                <Empty title="No tags yet." />
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
                <Dialog title={editing.id ? 'Edit tag' : 'New tag'} onClose={() => setEditing(null)}>
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
