/**
 * The content calendar: scheduled and published posts on the day they go out, drafts on the day
 * they are planned for. Days belong to the person looking (their time zone), so the admin sends
 * both kinds of bounds: instants for publish times, calendar days for target dates.
 */
import type { Post } from '@masthead/core';
import { createThread } from './comments';
import { savePost } from './content';
import type { Ctx, Principal } from './env';
import type { ReviewStatus } from './review';
import { HttpError, now } from './util';

export interface CalendarItem {
    id: string;
    type: 'post' | 'page';
    title: string;
    status: Post['status'];
    publishedAt: string | null;
    targetDate: string | null;
    featureImage: string | null;
    authors: { id: string; name: string; profileImage: string | null }[];
    review: ReviewStatus | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(v: unknown): v is string {
    return typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

export async function calendarItems(db: D1Database, range: { from: string; to: string; start: string; end: string }, authorId?: string): Promise<CalendarItem[]> {
    const from = Date.parse(range.from);
    const to = Date.parse(range.to);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from || !isDay(range.start) || !isDay(range.end)) throw new HttpError(400, 'Pass from and to (times) and start and end (days).');
    if (to - from > 100 * 86400_000) throw new HttpError(400, 'Ask for at most 100 days at a time.');
    const mine = authorId ? ' AND p.id IN (SELECT post_id FROM post_authors WHERE staff_id = ?)' : '';
    const { results } = await db
        .prepare(
            `SELECT p.id, p.type, p.title, p.status, p.published_at, p.target_date, p.feature_image, v.status AS review
             FROM posts p LEFT JOIN post_reviews v ON v.post_id = p.id
             WHERE ((p.status IN ('published','scheduled') AND p.published_at >= ? AND p.published_at < ?) OR (p.status = 'draft' AND p.target_date >= ? AND p.target_date <= ?))${mine}
             ORDER BY COALESCE(p.published_at, p.target_date) LIMIT 1000`
        )
        .bind(new Date(from).toISOString(), new Date(to).toISOString(), range.start, range.end, ...(authorId ? [authorId] : []))
        .all<any>();
    const authors = new Map<string, CalendarItem['authors']>();
    for (let i = 0; i < results.length; i += 90) {
        const ids = results.slice(i, i + 90).map(r => r.id);
        const { results: rows } = await db
            .prepare(`SELECT pa.post_id, s.id, s.name, s.profile_image FROM post_authors pa JOIN staff s ON s.id = pa.staff_id WHERE pa.post_id IN (${ids.map(() => '?').join(',')}) ORDER BY pa.sort`)
            .bind(...ids)
            .all<{ post_id: string; id: string; name: string; profile_image: string | null }>();
        for (const r of rows) authors.set(r.post_id, [...(authors.get(r.post_id) ?? []), { id: r.id, name: r.name, profileImage: r.profile_image }]);
    }
    return results.map(r => ({
        id: r.id,
        type: r.type,
        title: r.title,
        status: r.status,
        publishedAt: r.published_at,
        targetDate: r.target_date,
        featureImage: r.feature_image,
        authors: authors.get(r.id) ?? [],
        // Once out, a post's review is history; the calendar shows where it stands until then.
        review: r.status === 'published' ? null : (r.review ?? null)
    }));
}

/** Moves a draft to another planned day, or off the calendar (null). Scheduled posts move by their publish time instead. */
export async function setTargetDate(db: D1Database, post: Post, day: unknown): Promise<void> {
    if (post.status !== 'draft') throw new HttpError(400, 'Scheduled and published posts move by their publish time.');
    if (day !== null && !isDay(day)) throw new HttpError(400, 'A target date is a day, like 2026-10-06.');
    await db.prepare('UPDATE posts SET target_date = ? WHERE id = ?').bind(day, post.id).run();
}

/**
 * Turns an idea into a draft planned for a day. The idea's angle and sources ride along as a
 * comment on the draft, where the writer sees them and readers never can.
 */
export async function planIdea(ctx: Ctx, ideaId: string, day: unknown, by: Principal): Promise<Post> {
    if (!isDay(day)) throw new HttpError(400, 'Pick a day, like 2026-10-06.');
    const idea = await ctx.db.prepare('SELECT * FROM ideas WHERE id = ?').bind(ideaId).first<any>();
    if (!idea) throw new HttpError(404, 'Idea not found.');
    if (idea.post_id && (await ctx.db.prepare('SELECT id FROM posts WHERE id = ?').bind(idea.post_id).first())) throw new HttpError(409, 'This idea already has a draft.');
    const post = await savePost(ctx.db, { title: idea.title, markdown: '', bodyFormat: 'markdown', status: 'draft', type: 'post', targetDate: day }, { defaultAuthorId: by.staffId.includes(':') ? undefined : by.staffId });
    await ctx.db.prepare("UPDATE ideas SET status = 'drafted', post_id = ?, updated_at = ? WHERE id = ?").bind(post.id, now(), ideaId).run();
    const brief = ideaBrief(idea);
    if (brief) await createThread(ctx, post, by, { body: brief }, true);
    return post;
}

function ideaBrief(idea: { angle?: string | null; series?: string | null; sources?: string | null }): string {
    let sources: { title?: string; url?: string; summary?: string }[] = [];
    try {
        sources = JSON.parse(idea.sources || '[]');
    } catch {
        // An idea with unreadable sources still makes a draft.
    }
    const lines = [
        idea.angle?.trim() ? `Angle: ${idea.angle.trim()}` : '',
        idea.series?.trim() ? `Series: ${idea.series.trim()}` : '',
        sources.length
            ? `Sources:\n${sources
                  .slice(0, 12)
                  .map(s => `- ${[s.title?.trim(), s.url?.trim()].filter(Boolean).join(': ')}`)
                  .filter(l => l !== '- ')
                  .join('\n')}`
            : ''
    ].filter(Boolean);
    return lines.length ? `From the idea.\n\n${lines.join('\n\n')}` : '';
}
