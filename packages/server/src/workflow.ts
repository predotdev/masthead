/** Admin API for review before publishing, comments, notifications and the content calendar. */
import type { Post } from '@masthead/core';
import { atLeast } from './auth';
import { calendarItems, planIdea, setTargetDate } from './calendar';
import { addReply, createThread, deleteComment, editComment, getComment, getThread, listThreads, setThreadStatus } from './comments';
import { getPost } from './content';
import type { Ctx, Principal } from './env';
import { emailPref, listNotices, markRead, setEmailPref } from './notify';
import { decide, getReview, needsApproval, postPeople, requestReview, withdrawReview, workflowSettings } from './review';
import type { Router } from './router';
import { HttpError, body, json } from './util';

type A = Ctx & { principal?: Principal };
/** admin.ts's rule for who may change a post (and publish it). */
type CanEdit = (ctx: A, post: Post | null, publishing?: boolean) => Promise<Principal>;

export function workflowRoutes(r: Router<A>, canEdit: CanEdit): void {
    const me = (ctx: A) => atLeast(ctx.principal, 'contributor');
    const postFor = async (ctx: A, id: string) => {
        const post = await getPost(ctx.db, id);
        if (!post) throw new HttpError(404, 'Post not found.');
        return post;
    };
    /** A thread, checked to belong to the post in the address. */
    const threadFor = async (ctx: A, post: Post, id: string) => {
        const thread = await getThread(ctx.db, id);
        if (!thread || thread.post_id !== post.id) throw new HttpError(404, 'That comment thread is gone.');
        return thread;
    };

    r.get('/workflow', async (_req, ctx) => (me(ctx), json(await workflowSettings(ctx.db))));

    // ---------------------------------------------------------- review
    /** The review, who could review, and what the person asking may do about it. */
    r.get('/posts/:id/review', async (_req, ctx, { id }) => {
        const post = await postFor(ctx, id);
        const p = await canEdit(ctx, post);
        const [review, people, settings, blocked] = await Promise.all([getReview(ctx.db, post), postPeople(ctx.db, post), workflowSettings(ctx.db), needsApproval(ctx.db, post, p)]);
        return json({ ...review, requireApproval: settings.requireApproval, people: people.filter(x => x.id !== p.staffId), blocked, me: p.staffId });
    });
    r.post('/posts/:id/review', async (req, ctx, { id }) => {
        const post = await postFor(ctx, id);
        const p = await canEdit(ctx, post);
        await requestReview(ctx, post, p, await body(req));
        return json(await getReview(ctx.db, post));
    });
    r.post('/posts/:id/review/decision', async (req, ctx, { id }) => {
        const post = await postFor(ctx, id);
        const p = await canEdit(ctx, post);
        await decide(ctx, post, p, await body(req));
        return json(await getReview(ctx.db, post));
    });
    r.delete('/posts/:id/review', async (_req, ctx, { id }) => {
        const post = await postFor(ctx, id);
        await canEdit(ctx, post);
        await withdrawReview(ctx.db, post.id);
        return json({ ok: true });
    });

    // ---------------------------------------------------------- comments
    r.get('/posts/:id/comments', async (_req, ctx, { id }) => {
        const post = await postFor(ctx, id);
        await canEdit(ctx, post);
        const [threads, people] = await Promise.all([listThreads(ctx.db, post.id), postPeople(ctx.db, post)]);
        return json({ threads, people });
    });
    r.post('/posts/:id/comments', async (req, ctx, { id }) => {
        const post = await postFor(ctx, id);
        const p = await canEdit(ctx, post);
        return json(await createThread(ctx, post, p, await body(req)), 201);
    });
    r.post('/posts/:id/comments/:tid/replies', async (req, ctx, { id, tid }) => {
        const post = await postFor(ctx, id);
        const p = await canEdit(ctx, post);
        await threadFor(ctx, post, tid);
        return json(await addReply(ctx, post, tid, p, await body(req)), 201);
    });
    r.put('/posts/:id/comments/:tid', async (req, ctx, { id, tid }) => {
        const post = await postFor(ctx, id);
        const p = await canEdit(ctx, post);
        await threadFor(ctx, post, tid);
        await setThreadStatus(ctx.db, tid, p, (await body(req)).status);
        return json((await listThreads(ctx.db, post.id)).find(t => t.id === tid) ?? null);
    });
    r.put('/comments/:cid', async (req, ctx, { cid }) => {
        const comment = await getComment(ctx.db, cid);
        if (!comment) throw new HttpError(404, 'That comment is gone.');
        const post = await postFor(ctx, comment.post_id);
        const p = await canEdit(ctx, post);
        await editComment(ctx, post, comment, p, await body(req));
        return json((await listThreads(ctx.db, post.id)).find(t => t.id === comment.thread_id) ?? null);
    });
    r.delete('/comments/:cid', async (_req, ctx, { cid }) => {
        const comment = await getComment(ctx.db, cid);
        if (!comment) return json({ ok: true, thread: false });
        const post = await postFor(ctx, comment.post_id);
        const p = await canEdit(ctx, post);
        return json({ ok: true, ...(await deleteComment(ctx.db, comment, p)) });
    });

    // ---------------------------------------------------------- notifications
    r.get('/notifications', async (_req, ctx) => {
        const p = me(ctx);
        if (p.staffId.includes(':')) return json({ items: [], unread: 0, email: false });
        const limit = Number(ctx.url.searchParams.get('limit') ?? 30);
        const [list, email] = await Promise.all([listNotices(ctx.db, p.staffId, limit), emailPref(ctx.db, p.staffId)]);
        return json({ ...list, email });
    });
    r.post('/notifications/read', async (req, ctx) => {
        const p = me(ctx);
        const input = await body(req);
        await markRead(ctx.db, p.staffId, input.all === true ? 'all' : Array.isArray(input.ids) ? input.ids : []);
        return json({ ok: true });
    });
    r.put('/notifications/settings', async (req, ctx) => {
        const p = me(ctx);
        if (p.staffId.includes(':')) throw new HttpError(400, 'Integrations have no notifications.');
        const input = await body(req);
        if (typeof input.email !== 'boolean') throw new HttpError(400, 'Pass email: true or false.');
        await setEmailPref(ctx.db, p.staffId, input.email);
        return json({ email: input.email });
    });

    // ---------------------------------------------------------- calendar
    r.get('/calendar', async (_req, ctx) => {
        const p = me(ctx);
        const s = ctx.url.searchParams;
        const own = p.role === 'author' || p.role === 'contributor';
        const items = await calendarItems(ctx.db, { from: s.get('from') ?? '', to: s.get('to') ?? '', start: s.get('start') ?? '', end: s.get('end') ?? '' }, own ? p.staffId : undefined);
        return json({ items });
    });
    r.put('/calendar/posts/:id', async (req, ctx, { id }) => {
        const post = await postFor(ctx, id);
        await canEdit(ctx, post);
        const input = await body(req);
        await setTargetDate(ctx.db, post, input.targetDate ?? null);
        return json({ ok: true, targetDate: input.targetDate ?? null });
    });
    r.post('/calendar/ideas/:id', async (req, ctx, { id }) => {
        const p = me(ctx);
        return json(await planIdea(ctx, id, (await body(req)).targetDate, p), 201);
    });
}
