/**
 * Staff comments on a post: threads on a passage of text or on the whole post, with replies,
 * resolve and reopen, and @mentions. They live in their own tables, never in the post, so the
 * site, feeds, the search index and newsletters (all built from posts) cannot carry them.
 *
 * A thread on a passage is anchored twice over: by position in the editor's document, and by the
 * passage's text with a little context either side. The editor keeps the anchor on the text while
 * people write (a mark that moves with it) and sends the new positions with each save; when the post
 * changed some other way, the quote finds the passage again.
 */
import type { Post } from '@masthead/core';
import type { Ctx, Principal } from './env';
import { notify, type NoticeInput } from './notify';
import { postPeople } from './review';
import { HttpError, newId, now } from './util';

export interface Anchor {
    from: number;
    to: number;
    quote: string;
    prefix?: string | null;
    suffix?: string | null;
}

export interface CommentView {
    id: string;
    authorId: string | null;
    authorName: string;
    authorImage: string | null;
    body: string;
    mentions: string[];
    createdAt: string;
    editedAt: string | null;
}

export interface ThreadView {
    id: string;
    /** The passage it is on; null for a comment on the whole post. */
    quote: string | null;
    /** Where the passage was when last saved; null when it is not in the text any more. */
    anchor: { from: number; to: number; prefix: string | null; suffix: string | null } | null;
    status: 'open' | 'resolved';
    resolvedBy: string | null;
    resolvedAt: string | null;
    createdAt: string;
    comments: CommentView[];
}

const MAX_BODY = 5000;

export async function listThreads(db: D1Database, postId: string): Promise<ThreadView[]> {
    const [threads, comments] = await db.batch([
        db.prepare('SELECT * FROM comment_threads WHERE post_id = ? ORDER BY created_at').bind(postId),
        db
            .prepare('SELECT c.*, s.profile_image, s.name AS staff_name FROM comments c LEFT JOIN staff s ON s.id = c.author_id WHERE c.post_id = ? ORDER BY c.created_at, c.id')
            .bind(postId)
    ]);
    const byThread = new Map<string, CommentView[]>();
    for (const c of comments.results as any[]) {
        const list = byThread.get(c.thread_id) ?? [];
        list.push({
            id: c.id,
            authorId: c.author_id,
            authorName: c.staff_name ?? c.author_name,
            authorImage: c.profile_image ?? null,
            body: c.body,
            mentions: JSON.parse(c.mentions || '[]'),
            createdAt: c.created_at,
            editedAt: c.edited_at
        });
        byThread.set(c.thread_id, list);
    }
    return (threads.results as any[])
        .map(t => ({
            id: t.id,
            quote: t.quote,
            anchor: t.anchor_from != null && t.anchor_to != null ? { from: t.anchor_from, to: t.anchor_to, prefix: t.anchor_prefix, suffix: t.anchor_suffix } : null,
            status: t.status,
            resolvedBy: t.resolved_by,
            resolvedAt: t.resolved_at,
            createdAt: t.created_at,
            comments: byThread.get(t.id) ?? []
        }))
        .filter(t => t.comments.length);
}

export async function getThread(db: D1Database, id: string): Promise<{ id: string; post_id: string; status: string } | null> {
    return db.prepare('SELECT id, post_id, status FROM comment_threads WHERE id = ?').bind(id).first();
}

function cleanBody(v: unknown): string {
    const text = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '';
    if (!text) throw new HttpError(400, 'Write a comment first.');
    if (text.length > MAX_BODY) throw new HttpError(400, 'Comments can be up to 5,000 characters.');
    return text;
}

/** Mentioned people who can open the post; anyone else is dropped (they could not follow the link). */
async function cleanMentions(db: D1Database, post: Post, v: unknown): Promise<string[]> {
    const ids = [...new Set(Array.isArray(v) ? v.map(String) : [])].slice(0, 30);
    if (!ids.length) return [];
    const allowed = new Set((await postPeople(db, post)).map(p => p.id));
    return ids.filter(id => allowed.has(id));
}

function cleanAnchor(v: unknown): Anchor | null {
    if (!v || typeof v !== 'object') return null;
    const a = v as Record<string, unknown>;
    const from = Number(a.from);
    const to = Number(a.to);
    const quote = typeof a.quote === 'string' ? a.quote.slice(0, 2000) : '';
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || !quote.trim()) return null;
    const context = (x: unknown) => (typeof x === 'string' ? x.slice(-64) : null);
    return { from, to, quote, prefix: context(a.prefix), suffix: typeof a.suffix === 'string' ? a.suffix.slice(0, 64) : null };
}

const author = (by: Principal) => (by.staffId.includes(':') ? null : by.staffId);

/** Starts a thread. `quiet` records it without notifying anyone (a note the system adds for its author). */
export async function createThread(ctx: Ctx, post: Post, by: Principal, input: { body?: unknown; mentions?: unknown; anchor?: unknown }, quiet = false): Promise<ThreadView> {
    const body = cleanBody(input.body);
    const mentions = await cleanMentions(ctx.db, post, input.mentions);
    const anchor = cleanAnchor(input.anchor);
    const id = newId();
    const t = now();
    await ctx.db.batch([
        ctx.db
            .prepare('INSERT INTO comment_threads (id, post_id, quote, anchor_from, anchor_to, anchor_prefix, anchor_suffix, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, post.id, anchor?.quote ?? null, anchor?.from ?? null, anchor?.to ?? null, anchor?.prefix ?? null, anchor?.suffix ?? null, author(by), t, t),
        ctx.db
            .prepare('INSERT INTO comments (id, thread_id, post_id, author_id, author_name, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(newId(), id, post.id, author(by), by.name, body, JSON.stringify(mentions), t)
    ]);
    if (!quiet) await notify(ctx, post, by, [...mentions.map(staffId => ({ staffId, kind: 'mention' as const, threadId: id, text: body })), ...post.authors.map(staffId => ({ staffId, kind: 'comment' as const, threadId: id, text: body }))]);
    return (await listThreads(ctx.db, post.id)).find(x => x.id === id)!;
}

/** A reply. Replying to a resolved thread opens it again. */
export async function addReply(ctx: Ctx, post: Post, threadId: string, by: Principal, input: { body?: unknown; mentions?: unknown }): Promise<ThreadView> {
    const body = cleanBody(input.body);
    const mentions = await cleanMentions(ctx.db, post, input.mentions);
    const t = now();
    await ctx.db.batch([
        ctx.db.prepare('INSERT INTO comments (id, thread_id, post_id, author_id, author_name, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(newId(), threadId, post.id, author(by), by.name, body, JSON.stringify(mentions), t),
        ctx.db.prepare("UPDATE comment_threads SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?").bind(t, threadId)
    ]);
    // Everyone in the thread hears about a reply, and so do the post's authors.
    const { results } = await ctx.db.prepare('SELECT DISTINCT author_id FROM comments WHERE thread_id = ? AND author_id IS NOT NULL').bind(threadId).all<{ author_id: string }>();
    const inThread = new Set([...results.map(r => r.author_id), ...post.authors]);
    const notices: NoticeInput[] = [...mentions.map(staffId => ({ staffId, kind: 'mention' as const, threadId, text: body })), ...[...inThread].map(staffId => ({ staffId, kind: 'reply' as const, threadId, text: body }))];
    await notify(ctx, post, by, notices);
    return (await listThreads(ctx.db, post.id)).find(x => x.id === threadId)!;
}

export async function setThreadStatus(db: D1Database, threadId: string, by: Principal, status: unknown): Promise<void> {
    if (status !== 'open' && status !== 'resolved') throw new HttpError(400, 'A thread is open or resolved.');
    const t = now();
    await db
        .prepare('UPDATE comment_threads SET status = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
        .bind(status, status === 'resolved' ? by.name : null, status === 'resolved' ? t : null, t, threadId)
        .run();
}

interface CommentRow {
    id: string;
    thread_id: string;
    post_id: string;
    author_id: string | null;
    mentions: string;
}

export async function getComment(db: D1Database, id: string): Promise<CommentRow | null> {
    return db.prepare('SELECT id, thread_id, post_id, author_id, mentions FROM comments WHERE id = ?').bind(id).first<CommentRow>();
}

/** Changes your own comment. People newly mentioned in it are told. */
export async function editComment(ctx: Ctx, post: Post, comment: CommentRow, by: Principal, input: { body?: unknown; mentions?: unknown }): Promise<void> {
    if (comment.author_id !== by.staffId) throw new HttpError(403, 'You can only edit your own comments.');
    const body = cleanBody(input.body);
    const mentions = await cleanMentions(ctx.db, post, input.mentions);
    await ctx.db.prepare('UPDATE comments SET body = ?, mentions = ?, edited_at = ? WHERE id = ?').bind(body, JSON.stringify(mentions), now(), comment.id).run();
    const before = new Set(JSON.parse(comment.mentions || '[]') as string[]);
    await notify(
        ctx,
        post,
        by,
        mentions.filter(id => !before.has(id)).map(staffId => ({ staffId, kind: 'mention' as const, threadId: comment.thread_id, text: body }))
    );
}

/** Deletes a comment; deleting the one that starts a thread deletes the thread. Yours, or anyone's for admins. */
export async function deleteComment(db: D1Database, comment: CommentRow, by: Principal): Promise<{ thread: boolean }> {
    if (comment.author_id !== by.staffId && by.role !== 'owner' && by.role !== 'admin') throw new HttpError(403, 'You can only delete your own comments.');
    const first = await db.prepare('SELECT id FROM comments WHERE thread_id = ? ORDER BY created_at, id LIMIT 1').bind(comment.thread_id).first<{ id: string }>();
    if (first?.id === comment.id) {
        await db.batch([
            db.prepare('DELETE FROM comments WHERE thread_id = ?').bind(comment.thread_id),
            db.prepare('DELETE FROM comment_threads WHERE id = ?').bind(comment.thread_id),
            // Its notifications would lead nowhere.
            db.prepare('DELETE FROM notifications WHERE thread_id = ?').bind(comment.thread_id)
        ]);
        return { thread: true };
    }
    await db.prepare('DELETE FROM comments WHERE id = ?').bind(comment.id).run();
    return { thread: false };
}

/**
 * Where each thread sits in the text just saved, from the editor: an anchor, or null when its passage
 * is gone (the quote is kept, so it can be shown and found again). Only this post's threads change.
 */
export async function saveAnchors(db: D1Database, postId: string, anchors: unknown): Promise<void> {
    if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors)) return;
    const stmts: D1PreparedStatement[] = [];
    for (const [id, value] of Object.entries(anchors as Record<string, unknown>).slice(0, 500)) {
        if (value === null) {
            stmts.push(db.prepare('UPDATE comment_threads SET anchor_from = NULL, anchor_to = NULL WHERE id = ? AND post_id = ?').bind(id, postId));
            continue;
        }
        const a = cleanAnchor(value);
        if (a) stmts.push(db.prepare('UPDATE comment_threads SET quote = ?, anchor_from = ?, anchor_to = ?, anchor_prefix = ?, anchor_suffix = ? WHERE id = ? AND post_id = ?').bind(a.quote, a.from, a.to, a.prefix ?? null, a.suffix ?? null, id, postId));
    }
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

/** The editor's comment highlights are its own; if one ever reaches a save, it is taken out of the HTML. */
export async function stripCommentAnchors(html: string): Promise<string> {
    if (!html.includes('data-mh-comment')) return html;
    return new HTMLRewriter()
        .on('span[data-mh-comment]', { element: el => void el.removeAndKeepContent() })
        .transform(new Response(html))
        .text();
}

/** Everything the review and comments kept about a post, when the post is deleted. */
export async function forgetPost(db: D1Database, postId: string): Promise<void> {
    await db.batch([
        db.prepare('DELETE FROM comments WHERE post_id = ?').bind(postId),
        db.prepare('DELETE FROM comment_threads WHERE post_id = ?').bind(postId),
        db.prepare('DELETE FROM post_reviews WHERE post_id = ?').bind(postId),
        db.prepare('DELETE FROM post_reviewers WHERE post_id = ?').bind(postId),
        db.prepare('DELETE FROM notifications WHERE post_id = ?').bind(postId)
    ]);
}
