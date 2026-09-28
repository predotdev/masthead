/**
 * The admin's notifications: review requests and answers, comments, replies and mentions. Each
 * lands in the person's notifications menu. Review events and mentions also go out by email, to
 * staff addresses only, through the transport and design sign-in links use.
 */
import type { Post } from '@masthead/core';
import { getSetting, listStaff, setSetting, siteSettings } from './content';
import { teamEmail } from './email';
import type { Ctx, Principal } from './env';
import { appUrl, onTeam, testMode, testTeam } from './newsletter';
import { now } from './util';

export type NoticeKind = 'review_requested' | 'review_approved' | 'review_changes' | 'mention' | 'comment' | 'reply';

export interface NoticeInput {
    staffId: string;
    kind: NoticeKind;
    threadId?: string | null;
    /** Their words: a review note or the comment. */
    text?: string | null;
    /** A sentence for the email only, e.g. whether the post is now approved. */
    detail?: string | null;
}

/** One event can reach someone for two reasons; the stronger one is sent (a mention beats a reply). */
const STRENGTH: Record<NoticeKind, number> = { mention: 5, review_requested: 4, review_changes: 3, review_approved: 3, reply: 2, comment: 1 };
/** Comments and replies stay in the admin; these also go out by email. */
const EMAILED = new Set<NoticeKind>(['review_requested', 'review_approved', 'review_changes', 'mention']);
/** Each person keeps this many of their newest notifications. */
const KEEP = 200;

/** Records notifications for staff (never the person who acted) and emails the ones that warrant it. */
export async function notify(ctx: Ctx, post: Pick<Post, 'id' | 'title'>, actor: Principal, inputs: NoticeInput[]): Promise<void> {
    const strongest = new Map<string, NoticeInput>();
    for (const n of inputs) {
        if (!n.staffId || n.staffId === actor.staffId) continue;
        const had = strongest.get(n.staffId);
        if (!had || STRENGTH[n.kind] > STRENGTH[had.kind]) strongest.set(n.staffId, n);
    }
    if (!strongest.size) return;
    const staff = new Map((await listStaff(ctx.db)).map(s => [s.id, s]));
    const list = [...strongest.values()].filter(n => staff.has(n.staffId) && staff.get(n.staffId)!.status !== 'suspended');
    if (!list.length) return;
    const t = now();
    const results = await ctx.db.batch(
        list.map(n =>
            ctx.db
                .prepare('INSERT INTO notifications (staff_id, kind, post_id, thread_id, actor_id, actor_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .bind(n.staffId, n.kind, post.id, n.threadId ?? null, actor.staffId, actor.name, n.text?.trim().slice(0, 1000) || null, t)
        )
    );
    const sent = list.map((n, i) => ({ ...n, id: Number(results[i].meta.last_row_id) }));
    ctx.exec.waitUntil(
        Promise.all([
            emailNotices(ctx, post, actor, sent, staff).catch(err => console.error('notification email failed', err)),
            ctx.db.batch(list.map(n => ctx.db.prepare('DELETE FROM notifications WHERE staff_id = ? AND id NOT IN (SELECT id FROM notifications WHERE staff_id = ? ORDER BY id DESC LIMIT ?)').bind(n.staffId, n.staffId, KEEP)))
        ])
    );
}

type Person = Awaited<ReturnType<typeof listStaff>>[number];

async function emailNotices(ctx: Ctx, post: Pick<Post, 'id' | 'title'>, actor: Principal, list: (NoticeInput & { id: number })[], staff: Map<string, Person>): Promise<void> {
    const transport = ctx.options.email?.(ctx.env);
    const from = ctx.env.EMAIL_FROM;
    const wanted = list.filter(n => EMAILED.has(n.kind));
    if (!transport || !from || !wanted.length) return;
    const [site, prefs] = await Promise.all([siteSettings(ctx.env, ctx.db), emailPrefs(ctx.db, wanted.map(n => n.staffId))]);
    // Staff are always on test mode's team; the check stays so this never becomes the one path around it.
    const team = testMode(ctx.env) ? await testTeam(ctx.env, ctx.db) : null;
    const messages = wanted.flatMap(n => {
        const person = staff.get(n.staffId);
        if (!person?.email || prefs.get(n.staffId) === false || (team && !onTeam(team, person.email))) return [];
        const mail = teamEmail(site, message(n, post, actor.name, `${appUrl(ctx.env)}admin/#/edit/${post.id}`));
        return [{ to: person.email, from, subject: mail.subject, html: mail.html, text: mail.text, idempotencyKey: `notify:${n.id}` }];
    });
    if (messages.length) await transport.send(messages);
}

function message(n: NoticeInput, post: Pick<Post, 'title'>, who: string, link: string) {
    const title = post.title.trim() || 'Untitled';
    const detail = n.detail ? ` ${n.detail}` : '';
    switch (n.kind) {
        case 'review_requested':
            return { subject: `Review requested: ${title}`, heading: `${who} asked you to review a post`, paragraph: `“${title}” is ready for your review.${detail}`, quote: n.text, action: { label: 'Review the post', url: `${link}/review` } };
        case 'review_approved':
            return { subject: `Approved: ${title}`, heading: `${who} approved your post`, paragraph: `“${title}” ${n.detail ?? 'has their approval.'}`, quote: n.text, action: { label: 'Open the post', url: `${link}/review` } };
        case 'review_changes':
            return { subject: `Changes requested: ${title}`, heading: `${who} asked for changes`, paragraph: `Before “${title}” goes out:`, quote: n.text, action: { label: 'See what to change', url: `${link}/review` } };
        default:
            return { subject: `${who} mentioned you on “${title}”`, heading: `${who} mentioned you`, paragraph: `In a comment on “${title}”:`, quote: n.text, action: { label: 'Reply', url: n.threadId ? `${link}/comments/${n.threadId}` : link } };
    }
}

// ------------------------------------------------------------------ reading them

export interface Notice {
    id: number;
    kind: NoticeKind;
    postId: string | null;
    postTitle: string | null;
    threadId: string | null;
    actor: { id: string | null; name: string; image: string | null };
    text: string | null;
    createdAt: string;
    read: boolean;
}

export async function listNotices(db: D1Database, staffId: string, limit = 30): Promise<{ items: Notice[]; unread: number }> {
    const [rows, count] = await db.batch([
        db
            .prepare(
                `SELECT n.id, n.kind, n.post_id, n.thread_id, n.actor_id, n.actor_name, n.text, n.created_at, n.read_at, p.title AS post_title, s.profile_image
                 FROM notifications n LEFT JOIN posts p ON p.id = n.post_id LEFT JOIN staff s ON s.id = n.actor_id
                 WHERE n.staff_id = ? ORDER BY n.id DESC LIMIT ?`
            )
            .bind(staffId, Math.min(Math.max(limit, 1), 100)),
        db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE staff_id = ? AND read_at IS NULL').bind(staffId)
    ]);
    return {
        items: (rows.results as any[]).map(r => ({
            id: r.id,
            kind: r.kind,
            postId: r.post_id,
            postTitle: r.post_title ?? null,
            threadId: r.thread_id,
            actor: { id: r.actor_id, name: r.actor_name ?? 'Someone', image: r.profile_image ?? null },
            text: r.text,
            createdAt: r.created_at,
            read: !!r.read_at
        })),
        unread: Number((count.results[0] as { n: number }).n)
    };
}

export async function markRead(db: D1Database, staffId: string, ids: number[] | 'all'): Promise<void> {
    if (ids === 'all') {
        await db.prepare('UPDATE notifications SET read_at = ? WHERE staff_id = ? AND read_at IS NULL').bind(now(), staffId).run();
        return;
    }
    const list = ids.map(Number).filter(Number.isInteger).slice(0, 100);
    if (!list.length) return;
    await db
        .prepare(`UPDATE notifications SET read_at = ? WHERE staff_id = ? AND read_at IS NULL AND id IN (${list.map(() => '?').join(',')})`)
        .bind(now(), staffId, ...list)
        .run();
}

/** Whether someone gets emails about reviews and mentions. On unless they turned it off. */
export async function emailPref(db: D1Database, staffId: string): Promise<boolean> {
    return (await getSetting<{ email?: boolean }>(db, `notify:${staffId}`, {})).email !== false;
}

export async function setEmailPref(db: D1Database, staffId: string, email: boolean): Promise<void> {
    await setSetting(db, `notify:${staffId}`, { email });
}

async function emailPrefs(db: D1Database, ids: string[]): Promise<Map<string, boolean>> {
    const keys = [...new Set(ids)].map(id => `notify:${id}`);
    const { results } = await db
        .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`)
        .bind(...keys)
        .all<{ key: string; value: string }>();
    const out = new Map<string, boolean>();
    for (const r of results) {
        try {
            out.set(r.key.slice('notify:'.length), (JSON.parse(r.value) as { email?: boolean }).email !== false);
        } catch {
            // A damaged preference counts as the default.
        }
    }
    return out;
}
