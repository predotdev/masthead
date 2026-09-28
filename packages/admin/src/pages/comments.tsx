/**
 * Comments in the editor: threads on a passage or on the whole post, replies, resolve and reopen,
 * and @mentions. The editor marks each thread's passage (editor/comments.ts); this keeps those marks
 * in step with the threads, and sends where they sit with every save.
 */
import type { Editor } from '@tiptap/core';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, fmtAgo, fmtSince, session, type Post } from '../api';
import { anchorFor, commentsKey, findAnchor, markThread, markedRanges, setCommentsView, textIndex, unmarkThread, type Anchor } from '../editor/comments';
import { Icon } from '../icons';
import { Avatar, Button, IconButton, Segmented, errorToast } from '../ui';
import { ROLE_NAME, type Person } from './review-status';

export interface CommentItem {
    id: string;
    authorId: string | null;
    authorName: string;
    authorImage: string | null;
    body: string;
    mentions: string[];
    createdAt: string;
    editedAt: string | null;
}

export interface Thread {
    id: string;
    quote: string | null;
    anchor: { from: number; to: number; prefix: string | null; suffix: string | null } | null;
    status: 'open' | 'resolved';
    resolvedBy: string | null;
    resolvedAt: string | null;
    createdAt: string;
    comments: CommentItem[];
}

export interface CommentsApi {
    threads: Thread[] | null;
    people: Person[];
    openCount: number;
    /** Threads whose passage is no longer in the text. */
    gone: Set<string>;
    active: string | null;
    focus: (id: string | null, scroll?: boolean) => void;
    /** A new thread being written: on a passage, or on the whole post (anchor null). */
    composing: { anchor: Anchor | null } | null;
    startOnSelection: () => void;
    startWhole: () => void;
    cancel: () => void;
    create: (body: string, mentions: string[]) => Promise<void>;
    reply: (thread: string, body: string, mentions: string[]) => Promise<void>;
    setStatus: (thread: string, status: 'open' | 'resolved') => Promise<void>;
    edit: (comment: string, body: string, mentions: string[]) => Promise<void>;
    remove: (comment: CommentItem, thread: Thread) => Promise<void>;
    /** Where the passages sit now, for the save (only what changed since the server last knew). */
    anchors: () => Record<string, Anchor | null> | undefined;
    /** Document order of the passages, for sorting. */
    order: () => Map<string, number>;
}

const anchorKey = (a: { from: number; to: number; prefix?: string | null; suffix?: string | null } | null, quote: string | null) => (a ? `${a.from}:${a.to}:${quote}:${a.prefix ?? ''}:${a.suffix ?? ''}` : 'none');

export function useComments(post: Post, editorRef: { current: Editor | null }, editorKey: string, openPanel: () => void): CommentsApi {
    const [threads, setThreads] = useState<Thread[] | null>(null);
    const [people, setPeople] = useState<Person[]>([]);
    const [active, setActive] = useState<string | null>(null);
    const [composing, setComposing] = useState<{ anchor: Anchor | null } | null>(null);
    const [gone, setGone] = useState<Set<string>>(new Set());
    // Threads marked in the current editor, and what the server last heard about each anchor.
    const marked = useRef<{ editor: Editor | null; ids: Set<string> }>({ editor: null, ids: new Set() });
    const known = useRef(new Map<string, string>());

    const load = async () => {
        try {
            const res = await api<{ threads: Thread[]; people: Person[] }>(`/posts/${post.id}/comments`);
            known.current = new Map(res.threads.map(t => [t.id, anchorKey(t.anchor, t.quote)]));
            setThreads(res.threads);
            setPeople(res.people);
        } catch (err) {
            // A failed check keeps what is shown; only a first load with nothing to show settles on none.
            setThreads(list => list ?? []);
            console.error(err);
        }
    };
    useEffect(() => {
        load();
        // Teammates comment while you write: look again now and then, and when the tab comes back.
        const tick = () => document.visibilityState === 'visible' && load();
        const t = setInterval(tick, 25_000);
        document.addEventListener('visibilitychange', tick);
        return () => (clearInterval(t), document.removeEventListener('visibilitychange', tick));
    }, [post.id]);

    // Mark each thread's passage in the editor, finding it by its words when the text moved.
    useEffect(() => {
        const ed = editorRef.current;
        if (!ed || !threads) return;
        if (marked.current.editor !== ed) marked.current = { editor: ed, ids: new Set() };
        const doc = ed.state.doc;
        const present = markedRanges(doc);
        const ix = textIndex(doc);
        const lost = new Set<string>();
        for (const t of threads) {
            if (!t.quote) continue;
            if (present.has(t.id)) {
                marked.current.ids.add(t.id);
                continue;
            }
            // Marked here before and gone now: its passage was deleted.
            if (marked.current.ids.has(t.id)) {
                lost.add(t.id);
                continue;
            }
            const range = findAnchor(doc, { quote: t.quote, anchor: t.anchor }, ix);
            if (range) {
                markThread(ed, t.id, range.from, range.to);
                marked.current.ids.add(t.id);
            } else lost.add(t.id);
        }
        // Threads deleted elsewhere lose their marks.
        for (const id of present.keys()) if (!threads.some(t => t.id === id)) unmarkThread(ed, id);
        setGone(prev => (prev.size === lost.size && [...lost].every(id => prev.has(id)) ? prev : lost));
    }, [threads, editorKey]);

    // Highlights follow the open threads and the one in focus.
    useEffect(() => {
        const ed = editorRef.current;
        if (ed) setCommentsView(ed, { open: (threads ?? []).filter(t => t.status === 'open').map(t => t.id), active });
    }, [threads, active, editorKey]);
    useEffect(() => {
        const ed = editorRef.current;
        if (ed) setCommentsView(ed, { pending: composing?.anchor ? { from: composing.anchor.from, to: composing.anchor.to } : null });
    }, [composing, editorKey]);

    const scrollToPassage = (id: string) => {
        const ed = editorRef.current;
        const r = ed && markedRanges(ed.state.doc).get(id);
        if (!ed || !r) return;
        const { node } = ed.view.domAtPos(r.from);
        const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    const focus = (id: string | null, scroll = false) => {
        setActive(id);
        if (id && scroll) scrollToPassage(id);
        if (id) requestAnimationFrame(() => document.getElementById(`thread-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    };

    const startOnSelection = () => {
        const ed = editorRef.current;
        if (!ed) return;
        const { from, to, empty } = ed.state.selection;
        const anchor = empty ? null : anchorFor(ed.state.doc, from, to);
        if (!anchor || !anchor.quote.trim()) {
            errorToast('Select some text to comment on.');
            return;
        }
        setComposing({ anchor });
        setActive(null);
        openPanel();
    };
    const startWhole = () => {
        setComposing({ anchor: null });
        setActive(null);
        openPanel();
    };

    // Clicking highlighted text opens its thread; ⌘⌥M comments on the selection.
    const handlers = useRef({ open: (_ids: string[]) => {}, shortcut: () => {} });
    handlers.current = {
        open: ids => {
            openPanel();
            focus(ids[0]);
        },
        shortcut: startOnSelection
    };
    useEffect(() => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.storage.comment.onOpen = ids => handlers.current.open(ids);
        ed.storage.comment.onShortcut = () => handlers.current.shortcut();
    }, [editorKey]);

    // Links from notifications and emails: #/edit/<post>/comments/<thread>, #/edit/<post>/review.
    useEffect(() => {
        const follow = () => {
            const m = /\/comments\/([^/?#]+)/.exec(location.hash);
            if (m || /\/review$/.test(location.hash)) openPanel();
            if (m) setTimeout(() => focus(m[1], true), 150);
        };
        follow();
        window.addEventListener('hashchange', follow);
        return () => window.removeEventListener('hashchange', follow);
    }, []);

    const replaceThread = (next: Thread) => setThreads(list => (list ?? []).map(t => (t.id === next.id ? next : t)));

    return {
        threads,
        people,
        openCount: (threads ?? []).filter(t => t.status === 'open').length,
        gone,
        active,
        focus,
        composing,
        startOnSelection,
        startWhole,
        cancel: () => setComposing(null),
        async create(body, mentions) {
            const ed = editorRef.current;
            const picked = composing?.anchor ?? null;
            // The passage may have moved while the comment was written: the highlight followed it.
            const pending = ed && picked ? commentsKey.getState(ed.state)?.pending : null;
            const anchor = picked && ed && pending ? (anchorFor(ed.state.doc, pending.from, pending.to) ?? picked) : picked;
            const thread = await api<Thread>(`/posts/${post.id}/comments`, { body: { body, mentions, anchor } });
            // Marked only where its words still are (the passage may have been deleted meanwhile).
            const range = anchor && ed ? findAnchor(ed.state.doc, { quote: anchor.quote, anchor }) : null;
            if (range && ed) {
                markThread(ed, thread.id, range.from, range.to);
                marked.current.ids.add(thread.id);
            }
            known.current.set(thread.id, anchorKey(thread.anchor, thread.quote));
            setThreads(list => [...(list ?? []), thread]);
            setComposing(null);
            setActive(thread.id);
        },
        async reply(id, body, mentions) {
            replaceThread(await api<Thread>(`/posts/${post.id}/comments/${id}/replies`, { body: { body, mentions } }));
        },
        async setStatus(id, status) {
            const next = await api<Thread | null>(`/posts/${post.id}/comments/${id}`, { method: 'PUT', body: { status } });
            if (next) replaceThread(next);
            if (status === 'resolved' && active === id) setActive(null);
        },
        async edit(id, body, mentions) {
            const next = await api<Thread | null>(`/comments/${id}`, { method: 'PUT', body: { body, mentions } });
            if (next) replaceThread(next);
        },
        async remove(comment, thread) {
            const res = await api<{ thread: boolean }>(`/comments/${comment.id}`, { method: 'DELETE' });
            if (res.thread) {
                setThreads(list => (list ?? []).filter(t => t.id !== thread.id));
                const ed = editorRef.current;
                if (ed) unmarkThread(ed, thread.id);
                if (active === thread.id) setActive(null);
            } else replaceThread({ ...thread, comments: thread.comments.filter(c => c.id !== comment.id) });
        },
        anchors() {
            const ed = editorRef.current;
            if (!ed || !threads?.length) return undefined;
            const doc = ed.state.doc;
            const ranges = markedRanges(doc);
            const ix = textIndex(doc);
            const out: Record<string, Anchor | null> = {};
            for (const t of threads) {
                if (!t.quote) continue;
                const r = ranges.get(t.id);
                // Only passages this editor holds, or has seen deleted; a passage never found stays as it was.
                if (!r && !marked.current.ids.has(t.id)) continue;
                const a = r ? anchorFor(doc, r.from, r.to, ix) : null;
                const key = anchorKey(a, a?.quote ?? t.quote);
                if (known.current.get(t.id) === key) continue;
                known.current.set(t.id, key);
                out[t.id] = a;
            }
            return Object.keys(out).length ? out : undefined;
        },
        order() {
            const ed = editorRef.current;
            return new Map([...(ed ? markedRanges(ed.state.doc) : new Map<string, { from: number }>())].map(([id, r]) => [id, r.from]));
        }
    };
}

/** The editor bar's way in: the count of open threads. */
export function CommentsToggle({ count, pressed, onClick }: { count: number; pressed: boolean; onClick: () => void }) {
    const label = count ? `Comments, ${count} open` : 'Comments';
    return (
        <button type="button" class={`btn ghost comments-toggle${count ? ' has-count' : ''}`} aria-pressed={pressed} aria-label={label} data-tooltip={label} onClick={onClick}>
            <Icon name="message" size={15} />
            {count ? <span class="comments-count">{count}</span> : null}
        </button>
    );
}

/** The thread list in the review panel. */
export function CommentsSection({ comments }: { comments: CommentsApi }) {
    const [tab, setTab] = useState<'open' | 'resolved'>('open');
    const all = comments.threads;
    const me = session.value?.user.staffId;
    const mentionable = comments.people.filter(p => p.id !== me);
    const order = comments.order();
    const at = (t: Thread) => (t.quote ? (comments.gone.has(t.id) ? Number.MAX_SAFE_INTEGER : (order.get(t.id) ?? Number.MAX_SAFE_INTEGER - 1)) : -1);
    const open = (all ?? []).filter(t => t.status === 'open').sort((a, b) => at(a) - at(b) || a.createdAt.localeCompare(b.createdAt));
    const resolved = (all ?? []).filter(t => t.status === 'resolved').sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
    const shown = tab === 'open' ? open : resolved;
    // A thread picked in the text shows up in the list, even resolved.
    useEffect(() => {
        const t = all?.find(x => x.id === comments.active);
        if (t) setTab(t.status);
    }, [comments.active]);

    return (
        <section class="cm" aria-label="Comments">
            <div class="cm-head">
                <h3>Comments</h3>
                <Button size="sm" icon="messagePlus" onClick={comments.startWhole}>
                    Comment
                </Button>
            </div>
            {resolved.length ? (
                <div class="cm-tabs">
                    <Segmented
                        label="Show"
                        value={tab}
                        options={[
                            { value: 'open', label: 'Open', count: open.length },
                            { value: 'resolved', label: 'Resolved', count: resolved.length }
                        ]}
                        onChange={setTab}
                    />
                </div>
            ) : null}
            {comments.composing ? (
                <div class="cm-thread is-new">
                    {comments.composing.anchor ? <Quote text={comments.composing.anchor.quote} /> : <p class="cm-scope">On the whole post</p>}
                    <Composer people={mentionable} placeholder={comments.composing.anchor ? 'Comment on this passage' : 'Comment on the post'} submit="Comment" autoFocus onSubmit={comments.create} onCancel={comments.cancel} />
                </div>
            ) : null}
            {all === null ? (
                <p class="cm-empty">Loading comments…</p>
            ) : shown.length ? (
                <ol class="cm-list">
                    {shown.map(t => (
                        <ThreadCard key={t.id} thread={t} comments={comments} people={mentionable} />
                    ))}
                </ol>
            ) : comments.composing ? null : (
                <div class="cm-empty">
                    <span class="cm-empty-icon" aria-hidden="true">
                        <Icon name="message" size={18} />
                    </span>
                    <p>{tab === 'open' ? 'No open comments.' : 'Nothing resolved yet.'}</p>
                    {tab === 'open' ? <p class="muted small">Select text and choose Comment, or press {IS_MAC ? '⌘⌥M' : 'Ctrl+Alt+M'}. Comments stay in the admin: readers never see them.</p> : null}
                </div>
            )}
        </section>
    );
}

function Quote({ text, gone, onClick }: { text: string; gone?: boolean; onClick?: () => void }) {
    const inner = <span class="cm-quote-text">{text}</span>;
    return onClick && !gone ? (
        <button type="button" class="cm-quote" onClick={e => (e.stopPropagation(), onClick())} title="Show in the post">
            {inner}
        </button>
    ) : (
        <div class={`cm-quote${gone ? ' is-gone' : ''}`}>{inner}</div>
    );
}

function ThreadCard({ thread, comments, people }: { thread: Thread; comments: CommentsApi; people: Person[] }) {
    const [replying, setReplying] = useState(false);
    const [busy, setBusy] = useState(false);
    const on = comments.active === thread.id;
    const resolved = thread.status === 'resolved';
    const gone = comments.gone.has(thread.id);
    const setStatus = async (status: 'open' | 'resolved') => {
        setBusy(true);
        try {
            await comments.setStatus(thread.id, status);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };
    return (
        <li
            id={`thread-${thread.id}`}
            class={`cm-thread${on ? ' is-active' : ''}${resolved ? ' is-resolved' : ''}`}
            onClick={e => !(e.target as HTMLElement).closest('button, a, textarea, input, .cm-menu') && comments.focus(thread.id, true)}
        >
            <div class="cm-thread-top">
                {thread.quote ? <Quote text={thread.quote} gone={gone} onClick={() => comments.focus(thread.id, true)} /> : <p class="cm-scope">On the whole post</p>}
                {resolved ? (
                    <IconButton icon="rotateCcw" label="Reopen" size={15} class="cm-resolve" disabled={busy} onClick={() => setStatus('open')} />
                ) : (
                    <IconButton icon="check" label="Resolve" size={15} class="cm-resolve" disabled={busy} onClick={() => setStatus('resolved')} />
                )}
            </div>
            {gone ? <p class="cm-gone">The text this was on has changed or was removed.</p> : null}
            <ol class="cm-comments">
                {thread.comments.map(c => (
                    <CommentRow key={c.id} comment={c} thread={thread} comments={comments} people={people} />
                ))}
            </ol>
            {resolved ? (
                <p class="cm-resolved">
                    <Icon name="checkCircle" size={13} /> Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''} {fmtSince(thread.resolvedAt)}
                </p>
            ) : replying ? (
                <Composer people={people} placeholder="Reply" submit="Reply" autoFocus compact onSubmit={async (b, m) => (await comments.reply(thread.id, b, m), setReplying(false))} onCancel={() => setReplying(false)} />
            ) : (
                <button type="button" class="cm-reply" onClick={() => (setReplying(true), comments.focus(thread.id))}>
                    Reply
                </button>
            )}
        </li>
    );
}

function CommentRow({ comment, thread, comments, people }: { comment: CommentItem; thread: Thread; comments: CommentsApi; people: Person[] }) {
    const me = session.value?.user;
    const mine = !!me && comment.authorId === me.staffId;
    const moderate = me?.role === 'owner' || me?.role === 'admin';
    const [editing, setEditing] = useState(false);
    const [menu, setMenu] = useState(false);
    const menuRef = useRef<HTMLSpanElement>(null);
    const first = thread.comments[0]?.id === comment.id;
    // The menu closes on a click elsewhere or Escape.
    useEffect(() => {
        if (!menu) return;
        const close = (e: Event) => (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) && setMenu(false);
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', close);
        return () => (document.removeEventListener('mousedown', close), document.removeEventListener('keydown', close));
    }, [menu]);
    const remove = async () => {
        setMenu(false);
        const many = first && thread.comments.length > 1;
        if (!window.confirm(many ? 'Delete this thread and its replies?' : 'Delete this comment?')) return;
        try {
            await comments.remove(comment, thread);
        } catch (err) {
            errorToast(err);
        }
    };
    return (
        <li class="cm-comment">
            <Avatar name={comment.authorName} src={comment.authorImage} size={24} />
            <div class="cm-main">
                <div class="cm-meta">
                    <span class="cm-author">{comment.authorName}</span>
                    <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>
                        {fmtAgo(comment.createdAt)}
                    </time>
                    {comment.editedAt ? <span class="cm-edited">edited</span> : null}
                    {mine || moderate ? (
                        <span class="cm-menu" ref={menuRef}>
                            <IconButton icon="more" label="More" size={15} tooltip={false} aria-expanded={menu} onClick={() => setMenu(!menu)} />
                            {menu ? (
                                <span class="cm-menu-pop">
                                    {mine ? (
                                        <button type="button" onClick={() => (setMenu(false), setEditing(true))}>
                                            <Icon name="pencil" size={14} /> Edit
                                        </button>
                                    ) : null}
                                    <button type="button" class="danger" onClick={remove}>
                                        <Icon name="trash" size={14} /> Delete
                                    </button>
                                </span>
                            ) : null}
                        </span>
                    ) : null}
                </div>
                {editing ? (
                    <Composer
                        people={people}
                        initial={comment.body}
                        initialMentions={comment.mentions}
                        placeholder="Edit your comment"
                        submit="Save"
                        autoFocus
                        compact
                        onSubmit={async (b, m) => (await comments.edit(comment.id, b, m), setEditing(false))}
                        onCancel={() => setEditing(false)}
                    />
                ) : (
                    <p class="cm-body">{richText(comment.body, comment.mentions, comments.people)}</p>
                )}
            </div>
        </li>
    );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A comment's words, with mentions as names and web addresses as links. */
function richText(text: string, mentions: string[], people: Person[]): ComponentChildren[] {
    const names = mentions
        .map(id => people.find(p => p.id === id)?.name)
        .filter((n): n is string => !!n)
        .sort((a, b) => b.length - a.length);
    const parts = [...names.map(n => `@${escapeRe(n)}`), 'https?://[^\\s<>"]*[^\\s<>".,;:!?)\\]\']'];
    const re = new RegExp(`(${parts.join('|')})`, 'g');
    return text.split(re).map((part, i) => {
        if (i % 2 === 0) return part;
        if (part.startsWith('@'))
            return (
                <span key={i} class="cm-mention">
                    {part}
                </span>
            );
        return (
            <a key={i} href={part} target="_blank" rel="noreferrer">
                {part}
            </a>
        );
    });
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function Composer(props: {
    people: Person[];
    initial?: string;
    initialMentions?: string[];
    placeholder: string;
    submit: string;
    autoFocus?: boolean;
    compact?: boolean;
    onSubmit: (body: string, mentions: string[]) => Promise<void>;
    onCancel?: () => void;
}) {
    const [text, setText] = useState(props.initial ?? '');
    const [mentions, setMentions] = useState<string[]>(props.initialMentions ?? []);
    const [busy, setBusy] = useState(false);
    const box = useRef<HTMLTextAreaElement>(null);
    const send = async () => {
        const body = text.trim();
        if (!body || busy) return;
        // A mention counts while its name is still in the text.
        const kept = mentions.filter(id => {
            const p = props.people.find(x => x.id === id);
            return !!p && body.includes(`@${p.name}`);
        });
        setBusy(true);
        try {
            await props.onSubmit(body, kept);
            setText('');
            setMentions([]);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div class={`cm-composer${props.compact ? ' compact' : ''}`}>
            <MentionBox
                boxRef={box}
                value={text}
                onValue={setText}
                people={props.people}
                onPick={p => setMentions(m => (m.includes(p.id) ? m : [...m, p.id]))}
                placeholder={props.placeholder}
                autoFocus={props.autoFocus}
                onSubmit={send}
                onCancel={props.onCancel}
            />
            <div class="cm-composer-bar">
                <IconButton
                    icon="atSign"
                    label="Mention someone"
                    size={15}
                    onClick={() => {
                        const el = box.current;
                        if (!el) return;
                        const at = el.selectionStart ?? el.value.length;
                        const lead = at > 0 && !/\s/.test(el.value[at - 1]) ? ' @' : '@';
                        el.value = el.value.slice(0, at) + lead + el.value.slice(at);
                        el.setSelectionRange(at + lead.length, at + lead.length);
                        el.focus();
                        // As if typed: the text updates and the suggestions open.
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }}
                />
                <span class="cm-keys">{IS_MAC ? '⌘' : 'Ctrl'}+Enter</span>
                {props.onCancel ? (
                    <Button size="sm" tone="plain" onClick={props.onCancel}>
                        Cancel
                    </Button>
                ) : null}
                <Button size="sm" tone="primary" busy={busy} disabled={!text.trim()} onClick={send}>
                    {props.submit}
                </Button>
            </div>
        </div>
    );
}

/** A text box that suggests teammates after "@". */
function MentionBox(props: {
    boxRef: { current: HTMLTextAreaElement | null };
    value: string;
    onValue: (v: string) => void;
    people: Person[];
    onPick: (p: Person) => void;
    placeholder: string;
    autoFocus?: boolean;
    onSubmit: () => void;
    onCancel?: () => void;
}) {
    const [query, setQuery] = useState<{ text: string; start: number } | null>(null);
    const [index, setIndex] = useState(0);
    const q = query?.text.toLowerCase() ?? '';
    const matches = query ? props.people.filter(p => p.name.toLowerCase().startsWith(q) || p.name.toLowerCase().split(/\s+/).some(w => w.startsWith(q))).slice(0, 6) : [];
    // Focused as it appears, so the first keys typed after clicking Reply land in it.
    useLayoutEffect(() => {
        if (props.autoFocus) props.boxRef.current?.focus();
    }, []);
    // Grows with what is written, up to a point.
    useEffect(() => {
        const el = props.boxRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight + 2, 240)}px`;
    }, [props.value]);
    const detect = (el: HTMLTextAreaElement) => {
        const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
        const m = /(^|\s)@([^\s@]{0,24})$/.exec(upto);
        setQuery(m ? { text: m[2], start: upto.length - m[2].length - 1 } : null);
        setIndex(0);
    };
    const pick = (p: Person) => {
        const el = props.boxRef.current;
        if (!el || !query) return;
        const before = el.value.slice(0, query.start);
        const after = el.value.slice(el.selectionStart ?? el.value.length);
        const insert = `@${p.name} `;
        // The box changes now, caret and all, so keys typed straight after land in order.
        el.value = before + insert + after;
        el.setSelectionRange(before.length + insert.length, before.length + insert.length);
        el.focus();
        props.onValue(el.value);
        props.onPick(p);
        setQuery(null);
    };
    return (
        <div class="mention-box">
            <textarea
                ref={props.boxRef}
                rows={2}
                value={props.value}
                placeholder={props.placeholder}
                aria-label={props.placeholder}
                onInput={e => (props.onValue(e.currentTarget.value), detect(e.currentTarget))}
                onClick={e => detect(e.currentTarget)}
                onBlur={() => setTimeout(() => setQuery(null), 150)}
                onKeyDown={e => {
                    if (query && matches.length) {
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            e.preventDefault();
                            setIndex(i => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                            return;
                        }
                        if (e.key === 'Enter' || e.key === 'Tab') {
                            e.preventDefault();
                            pick(matches[index]);
                            return;
                        }
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            setQuery(null);
                            return;
                        }
                    }
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        props.onSubmit();
                    } else if (e.key === 'Escape' && props.onCancel) {
                        e.stopPropagation();
                        props.onCancel();
                    }
                }}
            />
            {query && matches.length ? (
                <ul class="mention-pop" role="listbox" aria-label="Mention">
                    {matches.map((p, i) => (
                        <li key={p.id} role="option" aria-selected={i === index} class={i === index ? 'on' : ''} onMouseDown={e => (e.preventDefault(), pick(p))} onMouseEnter={() => setIndex(i)}>
                            <Avatar name={p.name} src={p.profileImage} size={20} />
                            <span class="mention-name">{p.name}</span>
                            <span class="mention-role">{ROLE_NAME[p.role]}</span>
                        </li>
                    ))}
                </ul>
            ) : query && !matches.length && props.people.length === 0 ? (
                <p class="mention-none">Nobody else can open this post.</p>
            ) : null}
        </div>
    );
}
