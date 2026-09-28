/**
 * Review before publishing. A writer asks teammates to review a post; each reviewer approves it or
 * asks for changes. The post's review follows their answers: changes requested when anyone asked for
 * changes, approved once everyone approved, in review until then. With "Require approval before
 * publishing" on (Settings, Review), a draft goes out only once approved, unless the owner publishes it.
 */
import type { Post, StaffRole } from '@masthead/core';
import { getSetting, listStaff, setSetting } from './content';
import type { Ctx, Principal } from './env';
import { notify } from './notify';
import { HttpError, now, sha256 } from './util';

export type ReviewStatus = 'in_review' | 'approved' | 'changes_requested';
export type ReviewerState = 'pending' | 'approved' | 'changes_requested';

export interface WorkflowSettings {
    /** Drafts need a review's approval before anyone but the owner can publish or schedule them. */
    requireApproval: boolean;
}

export async function workflowSettings(db: D1Database): Promise<WorkflowSettings> {
    const stored = await getSetting<Partial<WorkflowSettings>>(db, 'workflow', {});
    return { requireApproval: stored.requireApproval === true };
}

export async function saveWorkflowSettings(db: D1Database, input: Record<string, unknown>): Promise<void> {
    const current = await workflowSettings(db);
    await setSetting(db, 'workflow', { ...current, ...(typeof input.requireApproval === 'boolean' ? { requireApproval: input.requireApproval } : {}) });
}

/** Who can open a post in the editor: editors and up see every post, authors and contributors their own. */
export function canOpen(person: { id: string; role: StaffRole }, post: Pick<Post, 'authors'>): boolean {
    return person.role === 'owner' || person.role === 'admin' || person.role === 'editor' || post.authors.includes(person.id);
}

export interface Person {
    id: string;
    name: string;
    role: StaffRole;
    profileImage: string | null;
}

/** Staff who can open the post: the people who can review it, and be mentioned on it. */
export async function postPeople(db: D1Database, post: Pick<Post, 'authors'>): Promise<Person[]> {
    return (await listStaff(db)).filter(s => s.status !== 'suspended' && canOpen(s, post)).map(s => ({ id: s.id, name: s.name, role: s.role, profileImage: s.profileImage ?? null }));
}

export interface Reviewer extends Person {
    state: ReviewerState;
    note: string | null;
    decidedAt: string | null;
    /** They approved an earlier version of the text. */
    stale: boolean;
}

export interface Review {
    status: ReviewStatus | null;
    requestedBy: { id: string | null; name: string } | null;
    requestedAt: string | null;
    note: string | null;
    reviewers: Reviewer[];
    /** The text changed after someone approved it. */
    editedSinceApproval: boolean;
}

/**
 * What an approval covers: the title, the words and where links and images point. Markup is left
 * out, so the editor tidying the HTML of an older post (say, on saving a new excerpt) is not an edit.
 */
export async function contentHash(post: Pick<Post, 'title' | 'bodyFormat' | 'html' | 'markdown'>): Promise<string> {
    const body =
        post.bodyFormat === 'html'
            ? (post.html ?? '')
                  .replace(/<[^>]*?\s(?:href|src)="([^"]*)"[^>]*>/gi, ' $1 ')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/&nbsp;|&#160;/g, ' ')
            : (post.markdown ?? '');
    return sha256(`${post.title.trim()}\n${body.replace(/\s+/g, ' ').trim()}`);
}

export async function getReview(db: D1Database, post: Post): Promise<Review> {
    const [head, rows] = await db.batch([
        db.prepare('SELECT * FROM post_reviews WHERE post_id = ?').bind(post.id),
        db
            .prepare(
                `SELECT r.staff_id, r.state, r.note, r.decided_at, r.content_hash, s.name, s.role, s.profile_image
                 FROM post_reviewers r LEFT JOIN staff s ON s.id = r.staff_id WHERE r.post_id = ? ORDER BY r.decided_at IS NULL, r.decided_at, s.name`
            )
            .bind(post.id)
    ]);
    const h = head.results[0] as any;
    if (!h) return { status: null, requestedBy: null, requestedAt: null, note: null, reviewers: [], editedSinceApproval: false };
    const list = rows.results as any[];
    const approvedHashes = list.filter(r => r.state === 'approved' && r.content_hash).map(r => r.content_hash as string);
    const current = approvedHashes.length ? await contentHash(post) : null;
    return {
        status: h.status,
        requestedBy: { id: h.requested_by, name: h.requested_by_name ?? 'Someone' },
        requestedAt: h.requested_at,
        note: h.note,
        reviewers: list.map(r => ({
            id: r.staff_id,
            name: r.name ?? 'Former staff member',
            role: r.role ?? 'contributor',
            profileImage: r.profile_image ?? null,
            state: r.state,
            note: r.note,
            decidedAt: r.decided_at,
            stale: r.state === 'approved' && !!r.content_hash && r.content_hash !== current
        })),
        editedSinceApproval: approvedHashes.some(x => x !== current)
    };
}

export interface ReviewSummary {
    status: ReviewStatus;
    approved: number;
    reviewers: number;
}

/** Review status for a page of posts, for lists. */
export async function reviewSummaries(db: D1Database, ids: string[]): Promise<Map<string, ReviewSummary>> {
    const out = new Map<string, ReviewSummary>();
    for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        const { results } = await db
            .prepare(
                `SELECT v.post_id, v.status, (SELECT COUNT(*) FROM post_reviewers r WHERE r.post_id = v.post_id AND r.state = 'approved') AS approved,
                   (SELECT COUNT(*) FROM post_reviewers r WHERE r.post_id = v.post_id) AS reviewers
                 FROM post_reviews v WHERE v.post_id IN (${chunk.map(() => '?').join(',')})`
            )
            .bind(...chunk)
            .all<{ post_id: string; status: ReviewStatus; approved: number; reviewers: number }>();
        for (const r of results) out.set(r.post_id, { status: r.status, approved: Number(r.approved), reviewers: Number(r.reviewers) });
    }
    return out;
}

/** The review's status from its reviewers' answers, saved on the review. */
async function settle(db: D1Database, postId: string): Promise<ReviewStatus> {
    const { results } = await db.prepare('SELECT state FROM post_reviewers WHERE post_id = ?').bind(postId).all<{ state: ReviewerState }>();
    const status: ReviewStatus = results.some(r => r.state === 'changes_requested') ? 'changes_requested' : results.length && results.every(r => r.state === 'approved') ? 'approved' : 'in_review';
    await db.prepare('UPDATE post_reviews SET status = ?, updated_at = ? WHERE post_id = ?').bind(status, now(), postId).run();
    return status;
}

const cleanNote = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : null);

/**
 * Asks people to review the post. While a review is under way, changing who reviews it keeps the
 * answers already given; after changes were requested, or with `restart`, everyone starts over.
 */
export async function requestReview(ctx: Ctx, post: Post, by: Principal, input: { reviewers?: unknown; note?: unknown; restart?: unknown }): Promise<void> {
    const people = await postPeople(ctx.db, post);
    const wanted = [...new Set(Array.isArray(input.reviewers) ? input.reviewers.map(String) : [])].filter(id => id !== by.staffId);
    if (!wanted.length) throw new HttpError(400, 'Pick at least one reviewer.');
    if (wanted.length > 20) throw new HttpError(400, 'Pick up to 20 reviewers.');
    const allowed = new Set(people.map(p => p.id));
    if (wanted.some(id => !allowed.has(id))) throw new HttpError(400, 'Reviewers need to be staff who can open this post.');

    const head = await ctx.db
        .prepare('SELECT status, note, requested_by, requested_by_name, requested_at FROM post_reviews WHERE post_id = ?')
        .bind(post.id)
        .first<{ status: ReviewStatus; note: string | null; requested_by: string | null; requested_by_name: string | null; requested_at: string }>();
    const fresh = !head || input.restart === true || head.status !== 'in_review';
    // A new round is the asker's own; changing who reviews an open one keeps who asked, and when.
    const asker = fresh ? { id: by.staffId, name: by.name, at: now() } : { id: head!.requested_by, name: head!.requested_by_name, at: head!.requested_at };
    const { results: before } = await ctx.db
        .prepare('SELECT staff_id, state, note, decided_at, content_hash FROM post_reviewers WHERE post_id = ?')
        .bind(post.id)
        .all<{ staff_id: string; state: ReviewerState; note: string | null; decided_at: string | null; content_hash: string | null }>();
    const kept = new Map(fresh ? [] : before.map(r => [r.staff_id, r]));
    const note = input.note === undefined && !fresh ? (head?.note ?? null) : cleanNote(input.note);
    const t = now();
    await ctx.db.batch([
        ctx.db
            .prepare(
                `INSERT INTO post_reviews (post_id, status, requested_by, requested_by_name, note, requested_at, updated_at) VALUES (?, 'in_review', ?, ?, ?, ?, ?)
                 ON CONFLICT(post_id) DO UPDATE SET status = 'in_review', requested_by = excluded.requested_by, requested_by_name = excluded.requested_by_name,
                   note = excluded.note, requested_at = excluded.requested_at, updated_at = excluded.updated_at`
            )
            .bind(post.id, asker.id, asker.name, note, asker.at, t),
        ctx.db.prepare('DELETE FROM post_reviewers WHERE post_id = ?').bind(post.id),
        ...wanted.map(id => {
            const k = kept.get(id);
            return ctx.db
                .prepare('INSERT INTO post_reviewers (post_id, staff_id, state, note, decided_at, content_hash) VALUES (?, ?, ?, ?, ?, ?)')
                .bind(post.id, id, k?.state ?? 'pending', k?.note ?? null, k?.decided_at ?? null, k?.content_hash ?? null);
        })
    ]);
    const status = await settle(ctx.db, post.id);
    // Only people newly asked hear about it; a new round asks everyone again.
    const asked = wanted.filter(id => !kept.has(id));
    const detail = status === 'approved' ? null : wanted.length > 1 ? `${wanted.length - 1} other ${wanted.length === 2 ? 'person is' : 'people are'} reviewing it too.` : null;
    await notify(ctx, post, by, asked.map(staffId => ({ staffId, kind: 'review_requested' as const, text: note, detail })));
}

/** A reviewer's answer. Asking for changes needs a note saying what to change. */
export async function decide(ctx: Ctx, post: Post, by: Principal, input: { decision?: unknown; note?: unknown }): Promise<ReviewStatus> {
    const decision = input.decision;
    if (decision !== 'approved' && decision !== 'changes_requested') throw new HttpError(400, 'Answer with approved or changes_requested.');
    const head = await ctx.db.prepare('SELECT requested_by FROM post_reviews WHERE post_id = ?').bind(post.id).first<{ requested_by: string | null }>();
    if (!head) throw new HttpError(404, 'Nobody asked for a review of this post.');
    const mine = await ctx.db.prepare('SELECT state FROM post_reviewers WHERE post_id = ? AND staff_id = ?').bind(post.id, by.staffId).first();
    if (!mine) throw new HttpError(403, 'Only the reviewers asked can answer this review.');
    const note = cleanNote(input.note);
    if (decision === 'changes_requested' && !note) throw new HttpError(400, 'Say what should change.');
    await ctx.db
        .prepare('UPDATE post_reviewers SET state = ?, note = ?, decided_at = ?, content_hash = ? WHERE post_id = ? AND staff_id = ?')
        .bind(decision, note, now(), decision === 'approved' ? await contentHash(post) : null, post.id, by.staffId)
        .run();
    const status = await settle(ctx.db, post.id);
    const detail = decision === 'approved' ? (status === 'approved' ? 'is approved and ready to publish.' : 'still waits on the other reviewers.') : null;
    const kind = decision === 'approved' ? ('review_approved' as const) : ('review_changes' as const);
    const told = new Set([...(head.requested_by ? [head.requested_by] : []), ...post.authors]);
    await notify(ctx, post, by, [...told].map(staffId => ({ staffId, kind, text: note, detail })));
    return status;
}

export async function withdrawReview(db: D1Database, postId: string): Promise<void> {
    await db.batch([db.prepare('DELETE FROM post_reviews WHERE post_id = ?').bind(postId), db.prepare('DELETE FROM post_reviewers WHERE post_id = ?').bind(postId)]);
}

/** Whether approval stands between this person and publishing the post. */
export async function needsApproval(db: D1Database, post: Pick<Post, 'id' | 'status'>, by: Principal): Promise<ReviewStatus | 'none' | null> {
    if (post.status !== 'draft' || by.role === 'owner' || !(await workflowSettings(db)).requireApproval) return null;
    const head = await db.prepare('SELECT status FROM post_reviews WHERE post_id = ?').bind(post.id).first<{ status: ReviewStatus }>();
    return head?.status === 'approved' ? null : (head?.status ?? 'none');
}

/** Stops a draft that needs approval from going out. */
export async function checkApproval(db: D1Database, post: Pick<Post, 'id' | 'status'>, by: Principal): Promise<void> {
    const blocked = await needsApproval(db, post, by);
    if (!blocked) return;
    throw new HttpError(
        403,
        blocked === 'none'
            ? 'This post needs approval before it can be published. Send it for review first.'
            : blocked === 'changes_requested'
              ? 'A reviewer asked for changes. Send it for review again once they are made.'
              : 'This post is waiting for approval. Only the owner can publish it before then.'
    );
}
