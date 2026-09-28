/** Admin API for the team's notifications. */
import type { Post } from '@masthead/core';
import { atLeast } from './auth';
import type { Ctx, Principal } from './env';
import { emailPref, listNotices, markRead, setEmailPref } from './notify';
import type { Router } from './router';
import { HttpError, body, json } from './util';

type A = Ctx & { principal?: Principal };
/** admin.ts's rule for who may change a post (and publish it). */
type CanEdit = (ctx: A, post: Post | null, publishing?: boolean) => Promise<Principal>;

export function workflowRoutes(r: Router<A>, canEdit: CanEdit): void {
    const me = (ctx: A) => atLeast(ctx.principal, 'contributor');

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
}
