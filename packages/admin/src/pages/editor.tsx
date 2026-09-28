import type { Editor } from '@tiptap/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, base, session, type Post, type Staff, type Tag, upload } from '../api';
import { insertAi } from '../editor/assist';
import { createEditor, slashItems, snapshot, type SelectionState, type SlashState } from '../editor/setup';
import { Caret, Credits, StopButton, Working, splitDraft, useAiRun } from '../streaming';
import { Button, Dialog, ErrorNote, Field, Loading, Pill, errorToast, toast, useLoad } from '../ui';
import { AiPreview, AiPrompt, AssistantPanel, QUICK_EDITS, liveHtml, type AiJob } from './ai';
import { EmbedDialog, HtmlDialog, ImageDialog, VideoDialog } from './media';
import { HistoryPanel, SearchPanel } from './post-tools';
import { AutoTagNote, useServerTags, type TaggedPost } from './post-tags';
import { SendDialog } from './newsletters';

type Draft = Omit<Post, 'id' | 'createdAt' | 'updatedAt' | 'newsletter' | 'type'>;

type Modal =
    | null
    | { kind: 'publish' | 'send' | 'draft' | 'meta' | 'delete' | 'embed' }
    | { kind: 'image'; mode: 'insert' | 'cover' | 'edit'; pos?: number; src?: string }
    | { kind: 'video' }
    | { kind: 'html'; pos: number; html: string };

export function EditorPage({ id }: { id: string }) {
    const { data, error } = useLoad(() => Promise.all([api<Post>(`/posts/${id}`), api<Tag[]>('/tags'), api<Staff[]>('/staff')]), [id]);
    if (error) return <ErrorNote text={error} />;
    // Until the post in the address has loaded, never show (or save over) the previous one.
    if (!data || data[0].id !== id) return <Loading />;
    return <PostEditor key={data[0].id} initial={data[0]} tags={data[1]} staff={data[2]} />;
}

function PostEditor({ initial, tags: allTags, staff }: { initial: Post; tags: Tag[]; staff: Staff[] }) {
    const [post, setPost] = useState<Post>(initial);
    const [draft, setDraft] = useState<Draft>(() => pick(initial));
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [side, setSide] = useState<null | 'settings' | 'assistant'>(null);
    const [modal, setModal] = useState<Modal>(null);
    const [tags, setTags] = useState<Tag[]>(allTags);
    const [slash, setSlash] = useState<SlashState | null>(null);
    const [slashIndex, setSlashIndex] = useState(0);
    const [selection, setSelection] = useState<SelectionState | null>(null);
    const [aiMenu, setAiMenu] = useState(false);
    const [aiJob, setAiJob] = useState<AiJob | null>(null);
    const [prompt, setPrompt] = useState<{ top: number; left: number; hasSelection: boolean } | null>(null);
    const [source, setSource] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const editorRef = useRef<Editor | null>(null);
    const rev = useRef(0);
    const [revision, setRevision] = useState(0);
    const hostRef = useRef<HTMLDivElement>(null);
    const imageInput = useRef<HTMLInputElement>(null);
    const videoInput = useRef<HTMLInputElement>(null);
    const titleRef = useRef<HTMLTextAreaElement>(null);
    const role = session.value?.user.role;
    const live = post.status === 'published';
    const serverTags = useServerTags<Draft>(initial, setDraft, setPost);

    const touch = () => {
        rev.current += 1;
        setRevision(rev.current);
        setDirty(true);
    };
    const update = (patch: Partial<Draft>) => {
        setDraft(d => ({ ...d, ...patch }));
        touch();
    };

    // The title grows with its text, including long imported titles on first render.
    useLayoutEffect(() => {
        const el = titleRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [draft.title, side]);

    // One editor for every post: imported HTML (Ghost cards included) and Markdown alike.
    useEffect(() => {
        if (!hostRef.current || source) return;
        const ed = createEditor(hostRef.current, { html: draft.bodyFormat === 'html' ? draft.html : null, markdown: draft.bodyFormat === 'html' ? null : draft.markdown }, {
            onChange: touch,
            upload,
            unfurl: url => api(`/unfurl?url=${encodeURIComponent(url)}`).catch(() => null),
            onSlash: s =>
                setSlash(prev => {
                    if (!s || !prev || prev.query !== s.query) setSlashIndex(0);
                    return s;
                }),
            onSelection: s => (setSelection(s), s ? null : setAiMenu(false)),
            onAiPrompt: () => openPrompt(),
            editImage: (pos, src) => setModal({ kind: 'image', mode: 'edit', pos, src }),
            editHtml: (pos, html) => setModal({ kind: 'html', pos, html })
        });
        editorRef.current = ed;
        return () => {
            editorRef.current = null;
            ed.destroy();
        };
    }, [source, reloadKey]);

    const body = () => (editorRef.current ? { bodyFormat: 'html' as const, ...snapshot(editorRef.current) } : {});

    const save = async (explicit = false): Promise<Post | null> => {
        setSaving('saving');
        const at = rev.current;
        try {
            const sentSlug = draft.slug;
            const saved = await api<TaggedPost>(`/posts/${post.id}`, { method: 'PUT', body: { ...serverTags.outgoing(draft), ...body() } });
            setPost(saved);
            serverTags.saved(saved);
            // The server may move a draft's slug to follow its title or stay unique.
            if (saved.slug !== sentSlug) setDraft(d => (d.slug === sentSlug ? { ...d, slug: saved.slug } : d));
            // Typing that landed while the save was in flight stays unsaved.
            if (rev.current === at) setDirty(false);
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
        const t = setTimeout(() => save(), 1500);
        return () => clearTimeout(t);
    }, [revision, dirty, live]);

    useEffect(() => {
        const warn = (e: BeforeUnloadEvent) => {
            if (dirty) e.preventDefault();
        };
        const keys = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') (e.preventDefault(), save(true));
        };
        window.addEventListener('beforeunload', warn);
        window.addEventListener('keydown', keys);
        return () => (window.removeEventListener('beforeunload', warn), window.removeEventListener('keydown', keys));
    }, [dirty, draft]);

    const cursorBox = () => {
        const ed = editorRef.current!;
        const box = hostRef.current!.getBoundingClientRect();
        const c = ed.view.coordsAtPos(ed.state.selection.to);
        // AI cards line up with the text column, just under the cursor or selection.
        return { top: c.bottom - box.top + 10, left: 0 };
    };

    const openPrompt = () => {
        const ed = editorRef.current;
        if (!ed) return;
        setSlash(null);
        setPrompt({ ...cursorBox(), hasSelection: !ed.state.selection.empty });
    };

    const runAi = (instruction: string, mode: 'edit' | 'write' | 'continue', label?: string) => {
        const ed = editorRef.current;
        if (!ed) return;
        const { from, to } = ed.state.selection;
        setPrompt(null);
        setAiMenu(false);
        setSelection(null);
        setAiJob({ mode, instruction: instruction || undefined, label, from: mode === 'edit' ? from : to, to, ...cursorBox() });
    };

    const items = useMemo(
        () =>
            slashItems({
                pickImage: () => imageInput.current?.click(),
                pickVideo: () => videoInput.current?.click(),
                aiImage: () => setModal({ kind: 'image', mode: 'insert' }),
                aiVideo: () => setModal({ kind: 'video' }),
                embed: () => setModal({ kind: 'embed' }),
                aiWrite: () => setTimeout(openPrompt, 0),
                aiContinue: () => setTimeout(() => runAi('', 'continue'), 0)
            }),
        []
    );
    const filtered = slash ? items.filter(i => i.label.toLowerCase().includes(slash.query) || i.id.includes(slash.query)) : [];
    const runSlash = (idx: number) => {
        const ed = editorRef.current;
        const item = filtered[idx];
        if (!ed || !slash || !item) return;
        ed.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run();
        setSlash(null);
        item.run(ed);
    };
    useEffect(() => {
        if (!slash) return;
        const onKey = (e: KeyboardEvent) => {
            // Handled here and kept from the editor, so the arrows move the highlight, not the cursor.
            if (e.key === 'ArrowDown') (e.preventDefault(), e.stopPropagation(), setSlashIndex(i => Math.min(i + 1, filtered.length - 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), e.stopPropagation(), setSlashIndex(i => Math.max(i - 1, 0)));
            else if (e.key === 'Enter' && filtered.length) (e.preventDefault(), e.stopPropagation(), runSlash(slashIndex));
            else if (e.key === 'Escape') (e.stopPropagation(), setSlash(null));
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [slash, slashIndex, filtered.length]);

    const setLink = () => {
        const ed = editorRef.current;
        if (!ed) return;
        const url = window.prompt('Link to', ed.getAttributes('link').href ?? 'https://');
        if (url === null) return;
        url ? ed.chain().focus().extendMarkRange('link').setLink({ href: url }).run() : ed.chain().focus().unsetLink().run();
    };

    const insertNode = (node: { type: string; attrs: Record<string, unknown> }, pos?: number) => {
        const ed = editorRef.current;
        if (!ed) return;
        (pos != null ? ed.chain().focus().insertContentAt(pos, node) : ed.chain().focus().insertContent(node)).run();
    };

    const setNodeAttrs = (pos: number, attrs: Record<string, unknown>) => {
        const ed = editorRef.current;
        const node = ed?.state.doc.nodeAt(pos);
        if (!ed || !node) return;
        ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
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

    const upload1 = (accept: 'image' | 'video') => async (e: Event) => {
        const input = e.currentTarget as HTMLInputElement;
        const f = input.files?.[0];
        input.value = '';
        if (!f) return;
        try {
            const src = await upload(f);
            insertNode(accept === 'image' ? { type: 'figure', attrs: { src, alt: f.name.replace(/\.[^.]+$/, '') } } : { type: 'video', attrs: { src } });
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
                <Button onClick={() => setSide(side === 'assistant' ? null : 'assistant')} aria-pressed={side === 'assistant'} class={side === 'assistant' ? 'on' : ''}>
                    ✦ Assistant
                </Button>
                <Button onClick={() => setModal({ kind: 'draft' })}>Draft with AI</Button>
                <Button onClick={async () => ((dirty && (await save())), window.open(`${base}admin/api/posts/${post.id}/preview`, '_blank'))}>Preview</Button>
                <Button onClick={() => setSide(side === 'settings' ? null : 'settings')} aria-pressed={side === 'settings'}>
                    Settings
                </Button>
                {live ? (
                    <>
                        {post.type === 'post' ? (
                            <a class="btn ghost" href={`#/analytics/post/${post.id}`} onClick={e => dirty && !window.confirm('Leave without updating? Your changes are not on the site yet.') && e.preventDefault()}>
                                Analytics
                            </a>
                        ) : null}
                        {post.type === 'post' && role !== 'author' && role !== 'contributor' ? <Button onClick={() => setModal({ kind: 'send' })}>Send as newsletter</Button> : null}
                        <Button tone="primary" busy={saving === 'saving'} disabled={!dirty} onClick={() => save(true)}>
                            Update
                        </Button>
                    </>
                ) : role === 'contributor' ? null : (
                    <Button tone="primary" onClick={async () => ((dirty && (await save())), setModal({ kind: 'publish' }))}>
                        {post.status === 'scheduled' ? 'Reschedule' : 'Publish'}
                    </Button>
                )}
            </div>

            <div class={`editor-layout ${side ? 'with-panel' : ''}`}>
                <div class="writing">
                    <textarea ref={titleRef} class="title-input" rows={1} placeholder="Title" value={draft.title} onInput={e => update({ title: e.currentTarget.value })} />
                    <div class="cover-row">
                        {draft.featureImage ? (
                            <figure class="feature-preview">
                                <img src={draft.featureImage} alt={draft.featureImageAlt ?? ''} />
                                <div class="block-toolbar">
                                    <button onClick={() => setModal({ kind: 'image', mode: 'edit', src: draft.featureImage! })}>✦ Edit with AI</button>
                                    <button onClick={() => setModal({ kind: 'image', mode: 'cover' })}>Regenerate</button>
                                    <button onClick={() => update({ featureImage: null })}>Remove</button>
                                </div>
                            </figure>
                        ) : (
                            <div class="cover-actions">
                                <label class="link-btn">
                                    Add a cover image
                                    <input type="file" accept="image/*" hidden onChange={async e => {
                                        const f = e.currentTarget.files?.[0];
                                        if (f) update({ featureImage: await upload(f).catch(err => (errorToast(err), null)) });
                                    }} />
                                </label>
                                <button class="link-btn" onClick={() => setModal({ kind: 'image', mode: 'cover' })}>
                                    ✦ Generate one
                                </button>
                            </div>
                        )}
                    </div>
                    {source ? (
                        <div class="html-body">
                            <div class="note">
                                Editing the HTML source.{' '}
                                <button class="link-btn" onClick={() => setSource(false)}>
                                    Back to the editor
                                </button>
                            </div>
                            <textarea class="code-input" value={draft.html ?? ''} onInput={e => update({ html: e.currentTarget.value, markdown: null, bodyFormat: 'html' })} spellcheck={false} />
                        </div>
                    ) : (
                        <div class="editor-host" ref={hostRef}>
                            {slash && filtered.length ? (
                                <div class="slash-menu" style={{ top: slash.top, left: slash.left }} role="listbox">
                                    {(['AI', 'Write', 'Media'] as const).map(g =>
                                        filtered.some(i => i.group === g) ? (
                                            <div key={g}>
                                                <p class="slash-group">{g}</p>
                                                {filtered.map((item, i) =>
                                                    item.group === g ? (
                                                        <button key={item.id} role="option" aria-selected={i === slashIndex} class={i === slashIndex ? 'on' : ''} onMouseDown={e => (e.preventDefault(), runSlash(i))}>
                                                            <span>{item.group === 'AI' ? '✦ ' : ''}{item.label}</span>
                                                            <span class="muted small">{item.hint}</span>
                                                        </button>
                                                    ) : null
                                                )}
                                            </div>
                                        ) : null
                                    )}
                                </div>
                            ) : null}
                            {selection && !aiJob ? (
                                <div class="bubble" style={{ top: selection.top, left: selection.left }} onMouseDown={e => e.preventDefault()}>
                                    <button onClick={() => editorRef.current?.chain().focus().toggleBold().run()} title="Bold (⌘B)">
                                        <b>B</b>
                                    </button>
                                    <button onClick={() => editorRef.current?.chain().focus().toggleItalic().run()} title="Italic (⌘I)">
                                        <i>I</i>
                                    </button>
                                    <button onClick={() => editorRef.current?.chain().focus().toggleStrike().run()} title="Strikethrough">
                                        <s>S</s>
                                    </button>
                                    <button onClick={setLink}>Link</button>
                                    <button onClick={() => editorRef.current?.chain().focus().toggleCode().run()}>Code</button>
                                    <button onClick={() => editorRef.current?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
                                    <button onClick={() => editorRef.current?.chain().focus().toggleBlockquote().run()}>Quote</button>
                                    <span class="sep" />
                                    <button class="ai-btn" onClick={() => setAiMenu(!aiMenu)}>
                                        ✦ AI
                                    </button>
                                    {aiMenu ? (
                                        <div class="ai-menu">
                                            {QUICK_EDITS.map(q => (
                                                <button key={q.label} onClick={() => runAi(q.instruction, 'edit', q.label)}>
                                                    {q.label}
                                                </button>
                                            ))}
                                            <button onClick={() => (setAiMenu(false), openPrompt())}>Ask AI… ⌘J</button>
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                            {prompt ? <AiPrompt {...prompt} onRun={runAi} onClose={() => setPrompt(null)} /> : null}
                            {aiJob && editorRef.current ? <AiPreview editor={editorRef.current} job={aiJob} title={draft.title} onClose={() => setAiJob(null)} /> : null}
                        </div>
                    )}
                    <input ref={imageInput} type="file" accept="image/*" hidden onChange={upload1('image')} />
                    <input ref={videoInput} type="file" accept="video/*" hidden onChange={upload1('video')} />
                </div>

                {side === 'settings' ? (
                    <aside class="settings-panel">
                        <SettingsPanel
                            post={post}
                            draft={draft}
                            update={update}
                            tags={tags}
                            setTags={setTags}
                            staff={staff}
                            onMeta={() => setModal({ kind: 'meta' })}
                            onCover={() => setModal({ kind: 'image', mode: 'cover' })}
                            getHtml={() => (editorRef.current ? snapshot(editorRef.current).html : (draft.html ?? ''))}
                            onRestored={v => {
                                // The version becomes the editor's text as unsaved changes.
                                update({ title: v.title, bodyFormat: v.bodyFormat, markdown: v.markdown, html: v.html });
                                setReloadKey(k => k + 1);
                            }}
                        />
                        <div class="panel-actions">
                            <Button
                                onClick={async () => {
                                    if (!source && editorRef.current) update({ ...snapshot(editorRef.current), bodyFormat: 'html' });
                                    setSource(!source);
                                }}
                            >
                                {source ? 'Back to editor' : 'Edit HTML'}
                            </Button>
                            {post.status !== 'draft' && role !== 'contributor' ? <Button onClick={unpublish}>Unpublish</Button> : null}
                            <Button tone="danger" onClick={() => setModal({ kind: 'delete' })}>
                                Delete
                            </Button>
                        </div>
                    </aside>
                ) : side === 'assistant' ? (
                    <AssistantPanel editor={editorRef.current} title={draft.title} />
                ) : null}
            </div>

            {modal?.kind === 'publish' ? <PublishDialog post={post} onClose={() => setModal(null)} onDone={p => (setPost(p), serverTags.saved(p), setModal(null))} /> : null}
            {modal?.kind === 'send' ? <SendDialog post={post} onClose={() => setModal(null)} /> : null}
            {modal?.kind === 'draft' ? (
                <DraftDialog
                    editor={editorRef.current}
                    onClose={() => setModal(null)}
                    onDraft={(title, md) => {
                        setModal(null);
                        if (!draft.title && title) update({ title });
                        const ed = editorRef.current;
                        if (ed) insertAi(ed, md, { from: ed.state.selection.to, to: ed.state.selection.to }, 'at');
                    }}
                    disabled={source}
                />
            ) : null}
            {modal?.kind === 'meta' ? <MetaDialog draft={{ ...draft, ...body() }} onClose={() => setModal(null)} apply={p => (update(p), toast('Applied'))} /> : null}
            {modal?.kind === 'image' ? (
                <ImageDialog
                    mode={modal.mode}
                    src={modal.src}
                    title={draft.title}
                    onClose={() => setModal(null)}
                    onDone={(url, alt) => {
                        if (modal.mode === 'cover' || (modal.mode === 'edit' && modal.pos == null)) update({ featureImage: url, featureImageAlt: draft.featureImageAlt ?? alt });
                        else if (modal.mode === 'edit' && modal.pos != null) setNodeAttrs(modal.pos, { src: url, srcset: null, sizes: null });
                        else insertNode({ type: 'figure', attrs: { src: url, alt } });
                        setModal(null);
                    }}
                />
            ) : null}
            {modal?.kind === 'video' ? <VideoDialog reference={draft.featureImage} onClose={() => setModal(null)} onDone={url => (insertNode({ type: 'video', attrs: { src: url, loop: true } }), setModal(null))} /> : null}
            {modal?.kind === 'embed' ? <EmbedDialog onClose={() => setModal(null)} onDone={node => (insertNode(node), setModal(null))} /> : null}
            {modal?.kind === 'html' ? <HtmlDialog html={modal.html} onClose={() => setModal(null)} onDone={html => (setNodeAttrs(modal.pos, { html }), setModal(null))} /> : null}
            {modal?.kind === 'delete' ? (
                <Dialog title="Delete this post?" onClose={() => setModal(null)}>
                    <p>{post.status === 'published' ? 'It comes off the site right away. ' : ''}This can't be undone.</p>
                    <div class="dialog-actions">
                        <Button onClick={() => setModal(null)}>Cancel</Button>
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
    getHtml: () => string;
    onRestored: (v: Pick<Post, 'title' | 'bodyFormat' | 'markdown' | 'html'>) => void;
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
                <AutoTagNote post={props.post} ids={draft.tags} tags={tags} />
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
            <SearchPanel draft={{ ...draft, tags: draft.tags.filter(id => tags.find(t => t.id === id)?.visibility !== 'internal') }} getHtml={props.getHtml} />
            <HistoryPanel post={props.post} onRestored={props.onRestored} />
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

/** Writes a post from a request, into a preview you watch fill in; it goes into the post when you insert it. */
function DraftDialog({ editor, onClose, onDraft, disabled }: { editor: Editor | null; onClose: () => void; onDraft: (title: string, md: string) => void; disabled: boolean }) {
    const [prompt, setPrompt] = useState('');
    const [notes, setNotes] = useState('');
    const run = useAiRun<{ title: string; markdown: string; finishReason?: string }>();
    const writing = run.state === 'working';
    const shown = splitDraft(run.text);
    const body = useMemo(() => (editor && shown.body ? liveHtml(editor, shown.body, writing && shown.titleDone) : ''), [shown.body, writing, shown.titleDone]);
    const write = () => run.start('/ai/draft', { prompt, notes });
    const use = () => {
        const d = splitDraft(run.all());
        onDraft(run.result?.title ?? d.title, run.result?.markdown ?? d.body);
    };
    const stageText = run.stage === 'reading' || !run.stage ? 'Reading your sources' : run.text ? 'Writing the draft' : 'Thinking';
    return (
        <Dialog title="Draft with AI" onClose={onClose} wide>
            {disabled ? (
                <p>Go back to the editor from the HTML source first.</p>
            ) : run.state === 'idle' ? (
                <div class="stack">
                    <Field label="What should the post say?">
                        <textarea rows={3} value={prompt} onInput={e => setPrompt(e.currentTarget.value)} placeholder="A launch post for the new publish button: what it does, why it matters, how to use it." />
                    </Field>
                    <Field label="Source material" hint="Paste changelog entries, PR descriptions, notes. The draft only states what these support.">
                        <textarea rows={7} value={notes} onInput={e => setNotes(e.currentTarget.value)} />
                    </Field>
                </div>
            ) : (
                <div class="ai-draft" aria-busy={writing}>
                    {writing && !run.text ? <p class="muted small">The draft appears here as it is written.</p> : null}
                    {shown.title || (writing && !shown.titleDone && run.text) ? (
                        <h2 class="ai-draft-title">
                            {shown.title}
                            {writing && !shown.titleDone ? <Caret /> : null}
                        </h2>
                    ) : null}
                    {body ? <div class="prose-preview ai-draft-body" dangerouslySetInnerHTML={{ __html: body }} /> : null}
                    {run.state === 'error' ? <ErrorNote text={run.text ? `${run.error} What it wrote before that is above.` : run.error ?? ''} /> : null}
                    {run.state === 'stopped' ? <p class="ai-note">{run.text ? 'Stopped. You can still insert what it wrote.' : 'Stopped before it wrote anything.'}</p> : null}
                    {run.result?.finishReason === 'length' ? <p class="ai-note">It reached the length limit, so the end may be missing.</p> : null}
                    {run.sources.length ? (
                        <div class="ai-sources">
                            {run.sources.slice(0, 6).map(s => (
                                <a key={s.title} href={s.url ?? '#'} target="_blank" rel="noreferrer" title={s.title}>
                                    {s.title.length > 40 ? `${s.title.slice(0, 38)}…` : s.title}
                                </a>
                            ))}
                        </div>
                    ) : null}
                </div>
            )}
            <div class="dialog-actions">
                {run.state === 'idle' ? (
                    <>
                        <Button onClick={onClose}>Cancel</Button>
                        <Button tone="primary" disabled={disabled || !prompt.trim()} onClick={write}>
                            Write draft
                        </Button>
                    </>
                ) : writing ? (
                    <>
                        <Working label={stageText} since={run.startedAt} />
                        <StopButton onClick={run.stop} />
                    </>
                ) : (
                    <>
                        <Credits usage={run.usage} />
                        <Button tone="plain" onClick={run.reset}>
                            Change the request
                        </Button>
                        <Button onClick={write}>Try again</Button>
                        <Button tone="primary" disabled={!run.all().trim()} onClick={use}>
                            Insert into the post
                        </Button>
                    </>
                )}
            </div>
        </Dialog>
    );
}

type MetaKind = 'title' | 'description' | 'excerpt';

/** The suggestions in text that is still arriving, one per line; the last line may be half written. */
function metaItems(text: string, finished: boolean): { kind: MetaKind; text: string; done: boolean }[] {
    const lines = text.split('\n');
    const out: { kind: MetaKind; text: string; done: boolean }[] = [];
    lines.forEach((line, i) => {
        const done = finished || i < lines.length - 1;
        const m = line.replace(/^[\s>*_\-\d.)]+/, '').match(/^(title|description|excerpt)\**\s*:\s*\**\s*(.*)$/i);
        if (!m) return;
        let value = m[2].replace(/\**$/, '').trim().replace(/^["“]/, '');
        // A closing quote is only known once the line is finished.
        if (done) value = value.replace(/["”]$/, '');
        value = value.trim();
        if (value || !done) out.push({ kind: m[1].toLowerCase() as MetaKind, text: value, done });
    });
    return out;
}

function MetaDialog({ draft, onClose, apply }: { draft: Draft; onClose: () => void; apply: (p: Partial<Draft>) => void }) {
    const run = useAiRun();
    const ask = () => run.start('/ai/meta', { title: draft.title, markdown: draft.markdown ?? draft.html ?? '' });
    useEffect(ask, []);
    const writing = run.state === 'working';
    const items = metaItems(run.text, !writing);
    const actions = (kind: MetaKind, text: string) =>
        kind === 'title' ? (
            <span class="row">
                <Button onClick={() => apply({ title: text })}>Use as title</Button>
                <Button onClick={() => apply({ metaTitle: text })}>Use for search</Button>
            </span>
        ) : kind === 'description' ? (
            <Button onClick={() => apply({ metaDescription: text })}>Use</Button>
        ) : (
            <Button onClick={() => apply({ customExcerpt: text })}>Use as excerpt</Button>
        );
    const groups: [MetaKind, string][] = [
        ['title', 'Titles'],
        ['description', 'Descriptions'],
        ['excerpt', 'Excerpt']
    ];
    return (
        <Dialog title="Suggestions" onClose={onClose} wide>
            <div class="stack" aria-busy={writing}>
                {writing && !items.length ? <p class="muted small">Titles, descriptions and an excerpt appear here as they are written.</p> : null}
                {groups.map(([kind, label]) =>
                    items.some(i => i.kind === kind) ? (
                        <div key={kind}>
                            <p class="field-label">{label}</p>
                            {items
                                .filter(i => i.kind === kind)
                                .map((item, n) => (
                                    <div class="suggestion" key={n}>
                                        <span>
                                            {item.text}
                                            {item.done ? null : <Caret />}
                                        </span>
                                        {item.done ? actions(kind, item.text) : null}
                                    </div>
                                ))}
                        </div>
                    ) : null
                )}
                {run.state === 'error' ? <ErrorNote text={run.error ?? ''} /> : null}
                {run.state === 'stopped' ? <p class="ai-note">Stopped.</p> : null}
                {run.state === 'done' && !items.length ? <ErrorNote text="The model answered in the wrong shape. Try again." /> : null}
            </div>
            <div class="dialog-actions">
                {writing ? (
                    <>
                        <Working label={run.stage === 'reading' || !run.stage ? 'Reading the post' : items.length ? 'Writing' : 'Thinking'} since={run.startedAt} />
                        <StopButton onClick={run.stop} />
                    </>
                ) : (
                    <>
                        <Credits usage={run.usage} />
                        <Button onClick={ask}>Suggest again</Button>
                    </>
                )}
            </div>
        </Dialog>
    );
}
