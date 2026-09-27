import type { Editor } from '@tiptap/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, base, session, type Post, type Staff, type Tag, upload } from '../api';
import { createEditor, slashItems, type SelectionState, type SlashState } from '../editor';
import { Button, Dialog, ErrorNote, Field, Loading, Pill, errorToast, toast, useLoad } from '../ui';
import { SendDialog } from './newsletters';

type Draft = Omit<Post, 'id' | 'createdAt' | 'updatedAt' | 'newsletter' | 'type'>;

export function EditorPage({ id }: { id: string }) {
    const { data, error } = useLoad(() => Promise.all([api<Post>(`/posts/${id}`), api<Tag[]>('/tags'), api<Staff[]>('/staff')]), [id]);
    if (error) return <ErrorNote text={error} />;
    if (!data) return <Loading />;
    return <PostEditor key={id} initial={data[0]} tags={data[1]} staff={data[2]} />;
}

function PostEditor({ initial, tags: allTags, staff }: { initial: Post; tags: Tag[]; staff: Staff[] }) {
    const [post, setPost] = useState<Post>(initial);
    const [draft, setDraft] = useState<Draft>(() => pick(initial));
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [panel, setPanel] = useState(false);
    const [dialog, setDialog] = useState<null | 'publish' | 'send' | 'draft' | 'meta' | 'cover' | 'delete'>(null);
    const [tags, setTags] = useState<Tag[]>(allTags);
    const editorRef = useRef<Editor | null>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const titleRef = useRef<HTMLTextAreaElement>(null);
    const [slash, setSlash] = useState<SlashState | null>(null);
    const [slashIndex, setSlashIndex] = useState(0);
    const [selection, setSelection] = useState<SelectionState | null>(null);
    const role = session.value?.user.role;
    const live = post.status === 'published';

    const update = (patch: Partial<Draft>) => {
        setDraft(d => ({ ...d, ...patch }));
        setDirty(true);
    };

    // The title grows with its text, including long imported titles on first render.
    useLayoutEffect(() => {
        const el = titleRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [draft.title, panel]);

    // Markdown editor for posts written here; imported posts keep their HTML until converted.
    useEffect(() => {
        if (post.bodyFormat !== 'markdown' || !hostRef.current) return;
        const ed = createEditor(hostRef.current, post.markdown ?? '', {
            onChange: md => update({ markdown: md }),
            upload,
            onSlash: s => (setSlash(s), setSlashIndex(0)),
            onSelection: setSelection
        });
        editorRef.current = ed;
        return () => ed.destroy();
    }, [post.bodyFormat]);

    const save = async (explicit = false): Promise<Post | null> => {
        setSaving('saving');
        try {
            const sentSlug = draft.slug;
            const saved = await api<Post>(`/posts/${post.id}`, { method: 'PUT', body: draft });
            setPost(saved);
            // The server may move a draft's slug to follow its title or stay unique.
            if (saved.slug !== sentSlug) setDraft(d => (d.slug === sentSlug ? { ...d, slug: saved.slug } : d));
            setDirty(false);
            setSaving('saved');
            if (explicit && saved.status === 'published') toast('Updated on the site');
            return saved;
        } catch (err) {
            setSaving('error');
            errorToast(err);
            return null;
        }
    };

    // Drafts save themselves; live posts change only when you click Update.
    useEffect(() => {
        if (!dirty || live) return;
        const t = setTimeout(() => save(), 1200);
        return () => clearTimeout(t);
    }, [draft, dirty, live]);

    useEffect(() => {
        const warn = (e: BeforeUnloadEvent) => {
            if (dirty) e.preventDefault();
        };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [dirty]);

    const items = useMemo(() => slashItems(() => fileRef.current?.click()), []);
    const filtered = slash ? items.filter(i => i.label.toLowerCase().includes(slash.query) || i.id.includes(slash.query)) : [];
    const runSlash = (idx: number) => {
        const ed = editorRef.current;
        const item = filtered[idx];
        if (!ed || !slash || !item) return;
        ed.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run();
        item.run(ed);
        setSlash(null);
    };
    useEffect(() => {
        if (!slash) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSlashIndex(i => Math.min(i + 1, filtered.length - 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSlashIndex(i => Math.max(i - 1, 0)));
            else if (e.key === 'Enter' && filtered.length) (e.preventDefault(), e.stopPropagation(), runSlash(slashIndex));
            else if (e.key === 'Escape') setSlash(null);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [slash, slashIndex, filtered.length]);

    const improve = async (instruction: string) => {
        const ed = editorRef.current;
        if (!ed || !selection) return;
        const { from, to, text } = selection;
        setSelection(null);
        try {
            toast('Rewriting…');
            const res = await api<{ markdown: string }>('/ai/edit', { body: { markdown: text, instruction } });
            ed.chain().focus().insertContentAt({ from, to }, res.markdown, { contentType: 'markdown' }).run();
        } catch (err) {
            errorToast(err);
        }
    };

    const setLink = () => {
        const ed = editorRef.current;
        if (!ed) return;
        const url = window.prompt('Link to', ed.getAttributes('link').href ?? 'https://');
        if (url === null) return;
        url ? ed.chain().focus().extendMarkRange('link').setLink({ href: url }).run() : ed.chain().focus().unsetLink().run();
    };

    const unpublish = async () => {
        try {
            const res = await api<{ post: Post }>(`/posts/${post.id}/unpublish`, { method: 'POST' });
            setPost(res.post);
            toast('Unpublished');
        } catch (err) {
            errorToast(err);
        }
    };

    const convert = async () => {
        if (dirty) await save();
        try {
            const res = await api<Post>(`/posts/${post.id}/convert`, { method: 'POST' });
            setPost(res);
            setDraft(pick(res));
            toast('Now editing as Markdown');
        } catch (err) {
            errorToast(err);
        }
    };

    return (
        <div class="editor-page">
            <div class="editor-bar">
                <a class="back" href={post.type === 'page' ? '#/pages' : '#/posts'}>
                    ← {post.type === 'page' ? 'Pages' : 'Posts'}
                </a>
                <Pill tone={post.status === 'published' ? 'green' : post.status === 'scheduled' ? 'amber' : 'neutral'}>{post.status}</Pill>
                <span class="save-state">{saving === 'saving' ? 'Saving…' : saving === 'error' ? 'Not saved' : dirty ? (live ? 'Unpublished changes' : 'Editing') : saving === 'saved' ? 'Saved' : ''}</span>
                <div class="grow" />
                <Button onClick={() => setDialog('draft')}>Draft with AI</Button>
                <Button onClick={async () => ((dirty && (await save())), window.open(`${base}admin/api/posts/${post.id}/preview`, '_blank'))}>Preview</Button>
                <Button onClick={() => setPanel(!panel)} aria-pressed={panel}>
                    Settings
                </Button>
                {live ? (
                    <>
                        {post.type === 'post' && role !== 'author' && role !== 'contributor' ? <Button onClick={() => setDialog('send')}>Send as newsletter</Button> : null}
                        <Button tone="primary" busy={saving === 'saving'} disabled={!dirty} onClick={() => save(true)}>
                            Update
                        </Button>
                    </>
                ) : role === 'contributor' ? null : (
                    <Button tone="primary" onClick={async () => ((dirty && (await save())), setDialog('publish'))}>
                        {post.status === 'scheduled' ? 'Reschedule' : 'Publish'}
                    </Button>
                )}
            </div>

            <div class={`editor-layout ${panel ? 'with-panel' : ''}`}>
                <div class="writing">
                    <textarea
                        ref={titleRef}
                        class="title-input"
                        rows={1}
                        placeholder="Title"
                        value={draft.title}
                        onInput={e => update({ title: e.currentTarget.value })}
                    />
                    {draft.featureImage ? (
                        <figure class="feature-preview">
                            <img src={draft.featureImage} alt={draft.featureImageAlt ?? ''} />
                        </figure>
                    ) : null}
                    {post.bodyFormat === 'html' ? (
                        <div class="html-body">
                            <div class="note">
                                This post was imported and keeps its original HTML, so it looks exactly as it did.{' '}
                                <button class="link-btn" onClick={convert}>
                                    Switch to the Markdown editor
                                </button>{' '}
                                to edit it like any other post; embeds become links.
                            </div>
                            <textarea class="code-input" value={draft.html ?? ''} onInput={e => update({ html: e.currentTarget.value })} spellcheck={false} />
                        </div>
                    ) : (
                        <div class="editor-host" ref={hostRef}>
                            {slash && filtered.length ? (
                                <div class="slash-menu" style={{ top: slash.top, left: slash.left }} role="listbox">
                                    {filtered.map((item, i) => (
                                        <button key={item.id} role="option" aria-selected={i === slashIndex} class={i === slashIndex ? 'on' : ''} onMouseDown={e => (e.preventDefault(), runSlash(i))}>
                                            <span>{item.label}</span>
                                            <span class="muted small">{item.hint}</span>
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                            {selection ? (
                                <div class="bubble" style={{ top: selection.top, left: selection.left }} onMouseDown={e => e.preventDefault()}>
                                    <button onClick={() => editorRef.current?.chain().focus().toggleBold().run()}>
                                        <b>B</b>
                                    </button>
                                    <button onClick={() => editorRef.current?.chain().focus().toggleItalic().run()}>
                                        <i>I</i>
                                    </button>
                                    <button onClick={setLink}>Link</button>
                                    <button onClick={() => editorRef.current?.chain().focus().toggleCode().run()}>Code</button>
                                    <span class="sep" />
                                    <button onClick={() => improve('Tighten this: shorter, same meaning.')}>Tighten</button>
                                    <button onClick={() => improve('Make this clearer and more concrete.')}>Clarify</button>
                                    <button
                                        onClick={() => {
                                            const i = window.prompt('How should it change?');
                                            if (i) improve(i);
                                        }}
                                    >
                                        Rewrite…
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    )}
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={async e => {
                            const f = e.currentTarget.files?.[0];
                            e.currentTarget.value = '';
                            if (!f) return;
                            try {
                                const src = await upload(f);
                                editorRef.current?.chain().focus().setImage({ src, alt: f.name.replace(/\.[^.]+$/, '') }).run();
                            } catch (err) {
                                errorToast(err);
                            }
                        }}
                    />
                </div>

                {panel ? (
                    <aside class="settings-panel">
                        <SettingsPanel post={post} draft={draft} update={update} tags={tags} setTags={setTags} staff={staff} onMeta={() => setDialog('meta')} onCover={() => setDialog('cover')} />
                        <div class="panel-actions">
                            {post.status !== 'draft' && role !== 'contributor' ? <Button onClick={unpublish}>Unpublish</Button> : null}
                            <Button tone="danger" onClick={() => setDialog('delete')}>
                                Delete
                            </Button>
                        </div>
                    </aside>
                ) : null}
            </div>

            {dialog === 'publish' ? <PublishDialog post={post} onClose={() => setDialog(null)} onDone={p => (setPost(p), setDialog(null))} /> : null}
            {dialog === 'send' ? <SendDialog post={post} onClose={() => setDialog(null)} /> : null}
            {dialog === 'draft' ? (
                <DraftDialog
                    onClose={() => setDialog(null)}
                    onDraft={(title, md) => {
                        setDialog(null);
                        if (!draft.title && title) update({ title });
                        const ed = editorRef.current;
                        if (ed) ed.chain().focus().insertContent(md, { contentType: 'markdown' }).run();
                    }}
                    disabled={post.bodyFormat === 'html'}
                />
            ) : null}
            {dialog === 'meta' ? <MetaDialog draft={draft} onClose={() => setDialog(null)} apply={p => (update(p), toast('Applied'))} /> : null}
            {dialog === 'cover' ? <CoverDialog title={draft.title} onClose={() => setDialog(null)} apply={url => (update({ featureImage: url }), setDialog(null))} /> : null}
            {dialog === 'delete' ? (
                <Dialog title="Delete this post?" onClose={() => setDialog(null)}>
                    <p>{post.status === 'published' ? 'It comes off the site right away. ' : ''}This can't be undone.</p>
                    <div class="dialog-actions">
                        <Button onClick={() => setDialog(null)}>Cancel</Button>
                        <Button
                            tone="danger"
                            onClick={async () => {
                                try {
                                    await api(`/posts/${post.id}`, { method: 'DELETE' });
                                    toast('Deleted');
                                    location.hash = post.type === 'page' ? '#/pages' : '#/posts';
                                } catch (err) {
                                    errorToast(err);
                                }
                            }}
                        >
                            Delete
                        </Button>
                    </div>
                </Dialog>
            ) : null}
        </div>
    );
}

function pick(p: Post): Draft {
    const { id: _i, createdAt: _c, updatedAt: _u, newsletter: _n, type: _t, ...rest } = p;
    return rest;
}

function SettingsPanel(props: {
    post: Post;
    draft: Draft;
    update: (p: Partial<Draft>) => void;
    tags: Tag[];
    setTags: (t: Tag[]) => void;
    staff: Staff[];
    onMeta: () => void;
    onCover: () => void;
}) {
    const { draft, update, tags, staff } = props;
    const [newTag, setNewTag] = useState('');
    const addTag = async () => {
        const name = newTag.trim();
        if (!name) return;
        const existing = tags.find(t => t.name.toLowerCase() === name.toLowerCase());
        const tag = existing ?? (await api<Tag>('/tags', { body: { name } }).catch(err => (errorToast(err), null)));
        if (!tag) return;
        if (!existing) props.setTags([...tags, tag]);
        if (!draft.tags.includes(tag.id)) update({ tags: [...draft.tags, tag.id] });
        setNewTag('');
    };
    return (
        <div class="stack">
            <Field label="URL" hint={`${location.origin}${base}${draft.slug}/`}>
                <input value={draft.slug} onInput={e => update({ slug: e.currentTarget.value })} />
            </Field>
            <Field label="Publish date">
                <input type="datetime-local" value={draft.publishedAt ? toLocal(draft.publishedAt) : ''} onInput={e => update({ publishedAt: e.currentTarget.value ? new Date(e.currentTarget.value).toISOString() : null })} />
            </Field>
            <Field label="Tags">
                <div class="chips">
                    {draft.tags.map(id => {
                        const t = tags.find(x => x.id === id);
                        return (
                            <button key={id} class="chip" onClick={() => update({ tags: draft.tags.filter(x => x !== id) })} title="Remove">
                                {t?.name ?? id} ×
                            </button>
                        );
                    })}
                </div>
                <div class="row">
                    <input list="tag-options" placeholder="Add a tag" value={newTag} onInput={e => setNewTag(e.currentTarget.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTag())} />
                    <Button onClick={addTag}>Add</Button>
                </div>
                <datalist id="tag-options">
                    {tags.map(t => (
                        <option key={t.id} value={t.name} />
                    ))}
                </datalist>
            </Field>
            <Field label="Authors">
                <select
                    multiple
                    size={Math.min(5, staff.length)}
                    onChange={e =>
                        update({
                            authors: Array.from(e.currentTarget.selectedOptions).map(o => o.value)
                        })
                    }
                >
                    {staff.map(s => (
                        <option key={s.id} value={s.id} selected={draft.authors.includes(s.id)}>
                            {s.name}
                        </option>
                    ))}
                </select>
            </Field>
            <Field label="Excerpt" hint="Shown in lists and as the email preview.">
                <textarea rows={3} value={draft.customExcerpt ?? ''} onInput={e => update({ customExcerpt: e.currentTarget.value || null })} />
            </Field>
            <Field label="Feature image">
                <div class="row">
                    <input placeholder="Image URL" value={draft.featureImage ?? ''} onInput={e => update({ featureImage: e.currentTarget.value || null })} />
                </div>
                <div class="row">
                    <label class="btn ghost">
                        Upload
                        <input
                            type="file"
                            accept="image/*"
                            hidden
                            onChange={async e => {
                                const f = e.currentTarget.files?.[0];
                                if (f) update({ featureImage: await upload(f).catch(err => (errorToast(err), draft.featureImage)) });
                            }}
                        />
                    </label>
                    <Button onClick={props.onCover}>Generate</Button>
                </div>
            </Field>
            <Field label="Image description" hint="Alt text for screen readers and search.">
                <input value={draft.featureImageAlt ?? ''} onInput={e => update({ featureImageAlt: e.currentTarget.value || null })} />
            </Field>
            <div class="panel-section">
                <div class="row between">
                    <span class="field-label">Search and sharing</span>
                    <Button onClick={props.onMeta}>Suggest</Button>
                </div>
                <Field label="Search title" hint={`${(draft.metaTitle ?? draft.title).length}/60`}>
                    <input value={draft.metaTitle ?? ''} placeholder={draft.title} onInput={e => update({ metaTitle: e.currentTarget.value || null })} />
                </Field>
                <Field label="Search description" hint={`${(draft.metaDescription ?? '').length}/155`}>
                    <textarea rows={3} value={draft.metaDescription ?? ''} onInput={e => update({ metaDescription: e.currentTarget.value || null })} />
                </Field>
            </div>
            <label class="check">
                <input type="checkbox" checked={draft.featured} onChange={e => update({ featured: e.currentTarget.checked })} /> Featured
            </label>
        </div>
    );
}

function toLocal(iso: string) {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function PublishDialog({ post, onClose, onDone }: { post: Post; onClose: () => void; onDone: (p: Post) => void }) {
    const [when, setWhen] = useState<'now' | 'later'>(post.status === 'scheduled' ? 'later' : 'now');
    const [at, setAt] = useState(post.publishedAt && post.status === 'scheduled' ? toLocal(post.publishedAt) : '');
    const [busy, setBusy] = useState(false);
    const go = async () => {
        setBusy(true);
        try {
            const res = await api<{ post: Post; publish: { written: number; ms: number } | null }>(`/posts/${post.id}/publish`, {
                body: when === 'later' && at ? { publishedAt: new Date(at).toISOString() } : {}
            });
            toast(res.post.status === 'scheduled' ? `Scheduled for ${new Date(res.post.publishedAt!).toLocaleString()}` : `Published (${res.publish?.written ?? 0} files in ${res.publish?.ms ?? 0} ms)`);
            onDone(res.post);
        } catch (err) {
            errorToast(err);
            setBusy(false);
        }
    };
    return (
        <Dialog title={`Publish "${post.title || 'Untitled'}"`} onClose={onClose}>
            <div class="stack">
                <label class="check">
                    <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} /> Now
                </label>
                <label class="check">
                    <input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} /> Later
                </label>
                {when === 'later' ? <input type="datetime-local" value={at} onInput={e => setAt(e.currentTarget.value)} /> : null}
                <p class="muted small">Publishing puts it on the site. Emailing it to subscribers is a separate step.</p>
            </div>
            <div class="dialog-actions">
                <Button onClick={onClose}>Cancel</Button>
                <Button tone="primary" busy={busy} disabled={when === 'later' && !at} onClick={go}>
                    {when === 'later' ? 'Schedule' : 'Publish now'}
                </Button>
            </div>
        </Dialog>
    );
}

function DraftDialog({ onClose, onDraft, disabled }: { onClose: () => void; onDraft: (title: string, md: string) => void; disabled: boolean }) {
    const [prompt, setPrompt] = useState('');
    const [notes, setNotes] = useState('');
    const [busy, setBusy] = useState(false);
    return (
        <Dialog title="Draft with AI" onClose={onClose} wide>
            {disabled ? (
                <p>Switch this imported post to the Markdown editor first.</p>
            ) : (
                <div class="stack">
                    <Field label="What should the post say?">
                        <textarea rows={3} value={prompt} onInput={e => setPrompt(e.currentTarget.value)} placeholder="A launch post for the new publish button: what it does, why it matters, how to use it." />
                    </Field>
                    <Field label="Source material" hint="Paste changelog entries, PR descriptions, notes. The draft only states what these support.">
                        <textarea rows={7} value={notes} onInput={e => setNotes(e.currentTarget.value)} />
                    </Field>
                </div>
            )}
            <div class="dialog-actions">
                <Button onClick={onClose}>Cancel</Button>
                <Button
                    tone="primary"
                    busy={busy}
                    disabled={disabled || !prompt.trim()}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            const res = await api<{ title: string; markdown: string }>('/ai/draft', { body: { prompt, notes } });
                            onDraft(res.title, res.markdown);
                        } catch (err) {
                            errorToast(err);
                            setBusy(false);
                        }
                    }}
                >
                    Write draft
                </Button>
            </div>
        </Dialog>
    );
}

function MetaDialog({ draft, onClose, apply }: { draft: Draft; onClose: () => void; apply: (p: Partial<Draft>) => void }) {
    const { data, error, loading } = useLoad(() => api<{ titles: string[]; descriptions: string[]; excerpt: string }>('/ai/meta', { body: { title: draft.title, markdown: draft.markdown ?? draft.html ?? '' } }), []);
    return (
        <Dialog title="Suggestions" onClose={onClose} wide>
            {loading ? <Loading /> : error ? <ErrorNote text={error} /> : null}
            {data ? (
                <div class="stack">
                    <div>
                        <p class="field-label">Titles</p>
                        {data.titles.map(t => (
                            <div class="suggestion" key={t}>
                                <span>{t}</span>
                                <span class="row">
                                    <Button onClick={() => apply({ title: t })}>Use as title</Button>
                                    <Button onClick={() => apply({ metaTitle: t })}>Use for search</Button>
                                </span>
                            </div>
                        ))}
                    </div>
                    <div>
                        <p class="field-label">Descriptions</p>
                        {data.descriptions.map(d => (
                            <div class="suggestion" key={d}>
                                <span>{d}</span>
                                <Button onClick={() => apply({ metaDescription: d })}>Use</Button>
                            </div>
                        ))}
                    </div>
                    {data.excerpt ? (
                        <div class="suggestion">
                            <span>{data.excerpt}</span>
                            <Button onClick={() => apply({ customExcerpt: data.excerpt })}>Use as excerpt</Button>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </Dialog>
    );
}

function CoverDialog({ title, onClose, apply }: { title: string; onClose: () => void; apply: (url: string) => void }) {
    const [prompt, setPrompt] = useState(`Abstract, minimal cover art for a post titled "${title}". Dark background, one bright subject, lots of empty space, no text.`);
    const [url, setUrl] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    return (
        <Dialog title="Generate a cover" onClose={onClose} wide>
            <div class="stack">
                <Field label="Describe the image">
                    <textarea rows={3} value={prompt} onInput={e => setPrompt(e.currentTarget.value)} />
                </Field>
                {url ? <img class="cover-result" src={url} alt="" /> : null}
            </div>
            <div class="dialog-actions">
                <Button onClick={onClose}>Cancel</Button>
                <Button
                    busy={busy}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            setUrl((await api<{ url: string }>('/ai/image', { body: { prompt, aspectRatio: '16:9' } })).url);
                        } catch (err) {
                            errorToast(err);
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {url ? 'Try again' : 'Generate'}
                </Button>
                {url ? (
                    <Button tone="primary" onClick={() => apply(url)}>
                        Use this image
                    </Button>
                ) : null}
            </div>
        </Dialog>
    );
}
