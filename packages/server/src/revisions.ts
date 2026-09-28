/**
 * Post history: earlier versions a writer can look at and bring back. A
 * version is kept before an edit changes the text (at most one per ten
 * minutes of editing, so autosave doesn't flood it), and at every publish.
 * The newest 50 per post are kept.
 */
import type { Post } from '@masthead/core';
import { now } from './util';

const KEEP = 50;
const QUIET_MS = 10 * 60_000;

export interface Revision {
    id: number;
    title: string;
    reason: string;
    savedBy: string | null;
    createdAt: string;
    words: number;
}

/** Keeps `before` as a version when `after` changes its words and no version was kept in the last ten minutes (or always, for a reason like "published"). */
export async function keepRevision(db: D1Database, before: Post, after: Partial<Post>, savedBy: string | null, reason: 'edited' | 'published' | 'restored'): Promise<void> {
    const changed = (after.title !== undefined && after.title !== before.title) || (after.html !== undefined && after.html !== before.html) || (after.markdown !== undefined && after.markdown !== before.markdown);
    if (reason === 'edited' && !changed) return;
    // A restore keeps the current text unless the last version already is that text.
    if (reason === 'restored') {
        const last = await db.prepare('SELECT html, markdown, title FROM post_revisions WHERE post_id = ? ORDER BY id DESC LIMIT 1').bind(before.id).first<{ html: string | null; markdown: string | null; title: string }>();
        if (last && last.html === before.html && last.markdown === before.markdown && last.title === before.title) return;
    }
    if (!before.title && !before.html && !before.markdown) return;
    if (reason === 'edited') {
        const last = await db.prepare('SELECT created_at FROM post_revisions WHERE post_id = ? ORDER BY id DESC LIMIT 1').bind(before.id).first<{ created_at: string }>();
        if (last && Date.now() - Date.parse(last.created_at) < QUIET_MS) return;
    }
    await db.batch([
        db
            .prepare('INSERT INTO post_revisions (post_id, title, body_format, markdown, html, feature_image, saved_by, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(before.id, before.title, before.bodyFormat, before.markdown, before.html, before.featureImage, savedBy, reason, now()),
        db.prepare('DELETE FROM post_revisions WHERE post_id = ? AND id NOT IN (SELECT id FROM post_revisions WHERE post_id = ? ORDER BY id DESC LIMIT ?)').bind(before.id, before.id, KEEP)
    ]);
}

export async function listRevisions(db: D1Database, postId: string): Promise<Revision[]> {
    const { results } = await db
        .prepare('SELECT id, title, reason, saved_by, created_at, length(coalesce(html, markdown, \'\')) AS size FROM post_revisions WHERE post_id = ? ORDER BY id DESC')
        .bind(postId)
        .all<{ id: number; title: string; reason: string; saved_by: string | null; created_at: string; size: number }>();
    // Words, roughly: characters of the stored body over six (markup included).
    return results.map(r => ({ id: r.id, title: r.title, reason: r.reason, savedBy: r.saved_by, createdAt: r.created_at, words: Math.round(Number(r.size) / 6) }));
}

export async function getRevision(db: D1Database, postId: string, id: number): Promise<Pick<Post, 'title' | 'bodyFormat' | 'markdown' | 'html' | 'featureImage'> | null> {
    const r = await db.prepare('SELECT title, body_format, markdown, html, feature_image FROM post_revisions WHERE post_id = ? AND id = ?').bind(postId, id).first<any>();
    return r ? { title: r.title, bodyFormat: r.body_format, markdown: r.markdown, html: r.html, featureImage: r.feature_image } : null;
}
