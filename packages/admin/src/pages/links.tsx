import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, fmtDate } from '../api';
import { checkedEditor } from '../editor/style-check';
import { Icon } from '../icons';
import { Button, ErrorNote, Skeleton, toast } from '../ui';

/** POST /ai/links: published posts nearest in meaning to the text (knowledge.ts, suggestLinks). */
interface Suggestion {
    id: string;
    title: string;
    url: string;
    excerpt: string | null;
    publishedAt: string | null;
    passage: string;
    score: number;
}

interface Answer {
    /** False until the blog has been read for suggestions. */
    ready: boolean;
    posts: Suggestion[];
}

// Answers for this visit, by the text asked about: coming back to a paragraph asks nothing.
const answers = new Map<string, Answer>();

interface Focus {
    /** Which block the cursor is in. */
    block: number;
    text: string;
}

/** The writing at the cursor: its block, read with a neighbor when it is short (a heading reads with what follows it). */
function focusOf(ed: Editor): Focus | null {
    const { $from } = ed.state.selection;
    const doc = ed.state.doc;
    if ($from.depth === 0 || !doc.childCount) return null;
    const index = $from.index(0);
    const read = (i: number) => (i >= 0 && i < doc.childCount ? doc.child(i).textBetween(0, doc.child(i).content.size, '\n', ' ').trim() : '');
    const block = doc.child(index);
    let text = read(index);
    if (text.length < 140) {
        const heading = block.type.name === 'heading';
        const neighbor = heading ? read(index + 1) : read(index - 1) || read(index + 1);
        if (neighbor) text = heading ? `${text}\n\n${neighbor}` : `${neighbor}\n\n${text}`;
    }
    return text.split(/\s+/).length >= 6 ? { block: index, text: text.slice(0, 1500) } : null;
}

/** Pages already linked from the post, by path, so a suggestion can say so. */
function linkedPaths(ed: Editor): Set<string> {
    const out = new Set<string>();
    ed.state.doc.descendants(node => {
        for (const m of node.marks) {
            if (m.type.name !== 'link') continue;
            try {
                out.add(new URL(String(m.attrs.href), location.origin).pathname);
            } catch {
                // Not a link to a page.
            }
        }
    });
    return out;
}

const pathOf = (url: string) => {
    try {
        return new URL(url).pathname;
    } catch {
        return url;
    }
};

/**
 * A link to another post opens in the same tab and counts for search: none of the
 * editor's defaults for outside links (a new tab, rel="nofollow").
 */
const SAME_SITE = { target: null, rel: null };

/** The start of the passage that matched, cut at a word. */
const snippet = (text: string, max = 170) => (text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')}…`);

/**
 * Posts to link from the paragraph at the cursor, found by meaning in the blog's own
 * posts. It follows the cursor, asking again when you move to another paragraph or
 * this one grows; nothing is asked while the panel is closed.
 */
export function LinksPanel({ postId }: { postId: string }) {
    const ed = checkedEditor.value;
    const [focus, setFocus] = useState<Focus | null>(null);
    const [selected, setSelected] = useState('');
    const [linked, setLinked] = useState<Set<string>>(new Set());
    const [answer, setAnswer] = useState<Answer | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const asked = useRef<Focus | null>(null);
    const latest = useRef(0);

    useEffect(() => {
        if (!ed) return;
        const read = () => {
            const f = focusOf(ed);
            setFocus(prev => (prev && f && prev.block === f.block && prev.text === f.text ? prev : f));
            const { from, to, empty } = ed.state.selection;
            setSelected(empty ? '' : ed.state.doc.textBetween(from, to, ' '));
            setLinked(linkedPaths(ed));
        };
        read();
        ed.on('selectionUpdate', read);
        ed.on('update', read);
        return () => {
            ed.off('selectionUpdate', read);
            ed.off('update', read);
        };
    }, [ed]);

    useEffect(() => {
        if (!focus) return;
        const last = asked.current;
        // The same paragraph a few words on: the posts that fit have not changed.
        if (last && last.block === focus.block && Math.abs(last.text.length - focus.text.length) < 80) return;
        const known = answers.get(focus.text);
        if (known) {
            asked.current = focus;
            setAnswer(known);
            setError(null);
            return;
        }
        const t = setTimeout(async () => {
            const n = ++latest.current;
            asked.current = focus;
            setBusy(true);
            try {
                const res = await api<Answer>('/ai/links', { body: { text: focus.text, postId } });
                answers.set(focus.text, res);
                if (n === latest.current) (setAnswer(res), setError(null));
            } catch (err) {
                if (n === latest.current) setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (n === latest.current) setBusy(false);
            }
        }, 650);
        return () => clearTimeout(t);
    }, [focus]);

    const linkSelection = (s: Suggestion) => {
        if (!ed || ed.state.selection.empty) return;
        ed.chain().focus().extendMarkRange('link').setLink({ href: s.url, ...SAME_SITE }).run();
        toast(`Linked to “${s.title}”`);
    };

    const insertLink = (s: Suggestion) => {
        if (!ed) return;
        const { to } = ed.state.selection;
        const doc = ed.state.doc;
        const before = doc.textBetween(Math.max(0, to - 1), to, '\n', '\n');
        const after = doc.textBetween(to, Math.min(doc.content.size, to + 1), '\n', '\n');
        ed.chain()
            .focus()
            .insertContentAt(to, [
                ...(before && !/\s/.test(before) ? [{ type: 'text', text: ' ' }] : []),
                { type: 'text', text: s.title, marks: [{ type: 'link', attrs: { href: s.url, ...SAME_SITE } }] },
                ...(after && /[\p{L}\p{N}]/u.test(after) ? [{ type: 'text', text: ' ' }] : [])
            ])
            // What you type next is not part of the link.
            .unsetMark('link')
            .run();
        toast(`Inserted a link to “${s.title}”`);
    };

    if (!ed) return <p class="checks-body muted small">Go back to the editor from the HTML source to find posts to link.</p>;
    const posts = answer?.posts ?? [];
    return (
        <div class="checks-body links-body">
            <div class="links-focus">
                <span class="field-label">Posts to link from here</span>
                {focus ? (
                    <p class="links-quote">{snippet(focus.text.replace(/\s+/g, ' '), 150)}</p>
                ) : (
                    <p class="muted small">Put the cursor in a paragraph. Posts on the same subject show up here as you write.</p>
                )}
                <p class={`links-hint${selected ? ' on' : ''}`}>
                    <Icon name="link" size={12} />
                    {selected ? (
                        <span>
                            Pick a post to link <strong>“{snippet(selected, 48)}”</strong>
                        </span>
                    ) : (
                        <span>Select words in the post to link them, or insert a post's title.</span>
                    )}
                </p>
            </div>
            {error ? <ErrorNote text={error} /> : null}
            {focus && busy && !posts.length ? (
                <ul class="link-list" aria-busy="true">
                    {[0, 1, 2].map(i => (
                        <li key={i} class="link-item">
                            <Skeleton width={`${70 - i * 12}%`} height={12} />
                            <Skeleton width="95%" />
                            <Skeleton width="80%" />
                        </li>
                    ))}
                </ul>
            ) : answer && !answer.ready ? (
                <p class="note">The blog is still being read for suggestions. They show up once that is done.</p>
            ) : focus && answer && !posts.length && !busy ? (
                <p class="muted small">No post is close enough to this paragraph.</p>
            ) : posts.length ? (
                <ul class={`link-list${busy ? ' is-stale' : ''}`} aria-busy={busy}>
                    {posts.map(s => {
                        const done = linked.has(pathOf(s.url));
                        return (
                            <li key={s.id} class={`link-item${done ? ' linked' : ''}`}>
                                <div class="link-item-head">
                                    <a class="link-item-title" href={s.url} target="_blank" rel="noreferrer" title="Open the post">
                                        {s.title}
                                    </a>
                                    {done ? (
                                        <span class="link-item-done">
                                            <Icon name="check" size={12} />
                                            Linked
                                        </span>
                                    ) : null}
                                </div>
                                {s.publishedAt ? <span class="link-item-date">{fmtDate(s.publishedAt)}</span> : null}
                                <p class="link-item-passage">{snippet(s.passage.replace(/\s+/g, ' '))}</p>
                                <div class="link-item-actions">
                                    <Button size="sm" tone={selected ? 'primary' : 'ghost'} icon="link" disabled={!selected} title={selected ? 'Link the selected words to this post' : 'Select words in the post first'} onClick={() => linkSelection(s)}>
                                        Link selection
                                    </Button>
                                    <Button size="sm" onClick={() => insertLink(s)} title="Insert the post's title as a link at the cursor">
                                        Insert link
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </div>
    );
}
