/**
 * Topics without the chore: a post with no public tags gets one to three of
 * the site's existing public tags, picked by the text model from its title,
 * excerpt and opening. It never makes a tag up, never touches a post that
 * has public tags, and never holds up a save: without AI, or when the model
 * fails, the post stays as it was.
 *
 * A draft is tagged once, when it first has enough text to tell what it is
 * about; publishing or scheduling a post that still has no topic tries again.
 */
import type { Post } from '@masthead/core';
import { plainText, renderBody, wordCount } from '@masthead/render';
import { aiSettings, getPost } from './content';
import type { Ctx } from './env';
import { publishSite } from './publish';

/** A draft needs about this many words before its topic is clear. */
const MIN_WORDS = 150;
const MAX_TAGS = 3;

interface Candidate {
    id: string;
    slug: string;
    name: string;
    description: string | null;
}

async function publicTagsOn(db: D1Database, postId: string): Promise<number> {
    const row = await db
        .prepare("SELECT COUNT(*) AS n FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ? AND t.visibility = 'public'")
        .bind(postId)
        .first<{ n: number }>();
    return Number(row?.n ?? 0);
}

/**
 * Whether saving this post should pick its tags. Cheap: no model call.
 * `force` (publishing) tries again even when an earlier attempt found nothing.
 */
export async function wantsAutoTags(ctx: Ctx, post: Post, force = false): Promise<boolean> {
    if (post.type !== 'post' || (!force && post.autoTags != null) || !ctx.options.ai?.(ctx.env)) return false;
    if (post.status === 'draft' && wordCount(renderBody(post)) < MIN_WORDS) return false;
    if (!(await aiSettings(ctx.env, ctx.db)).textModel || (await publicTagsOn(ctx.db, post.id))) return false;
    return !!(await ctx.db.prepare("SELECT 1 FROM tags WHERE visibility = 'public' LIMIT 1").first());
}

/**
 * Picks and applies tags when the post wants them (see wantsAutoTags).
 * Returns the ids it applied, or null when it did nothing.
 */
export async function autoTag(ctx: Ctx, postId: string, force = false): Promise<string[] | null> {
    const post = await getPost(ctx.db, postId);
    if (!post || !(await wantsAutoTags(ctx, post, force))) return null;
    // One attempt per draft: concurrent saves must not each ask the model.
    if (!force) {
        const claim = await ctx.db.prepare("UPDATE posts SET auto_tags = '[]' WHERE id = ? AND auto_tags IS NULL").bind(postId).run();
        if (!claim.meta.changes) return null;
    }
    const ai = ctx.options.ai!(ctx.env)!;
    const { textModel } = await aiSettings(ctx.env, ctx.db);
    const { results: candidates } = await ctx.db.prepare("SELECT id, slug, name, description FROM tags WHERE visibility = 'public' ORDER BY name COLLATE NOCASE").all<Candidate>();
    const text = plainText(renderBody(post)).slice(0, 2000);
    let picked: string[];
    try {
        const res = await ai.text({
            model: textModel!,
            system: `You file blog posts under topics. Choose 1 to ${MAX_TAGS} topics from the list that clearly fit the post; one good fit beats three loose ones. Reply with one JSON object: {"tags": ["slug"]}, using slugs exactly as listed. Never make up a topic. If none fits, reply {"tags": []}.`,
            messages: [
                {
                    role: 'user',
                    content: [
                        `Topics (slug: name):\n${candidates.map(t => `- ${t.slug}: ${t.name}${t.description ? ` (${t.description.slice(0, 160)})` : ''}`).join('\n')}`,
                        `Post title: ${post.title || 'Untitled'}`,
                        post.customExcerpt ? `Excerpt: ${post.customExcerpt}` : '',
                        text ? `Opening of the post:\n${text}` : ''
                    ]
                        .filter(Boolean)
                        .join('\n\n')
                }
            ],
            json: true,
            maxTokens: 300,
            temperature: 0
        });
        picked = slugsFrom(res.text);
    } catch (err) {
        console.error('auto-tagging failed', err);
        return null;
    }
    const bySlug = new Map(candidates.map(t => [t.slug, t.id]));
    const ids = [...new Set(picked.map(s => bySlug.get(s)).filter((id): id is string => !!id))].slice(0, MAX_TAGS);
    // One transaction: the pick is recorded only while the post has no public tag (a writer's choice, or
    // another attempt, made meanwhile wins), and each insert goes ahead only when it was.
    const token = JSON.stringify(ids);
    const marks = ids.map(() => '?').join(',');
    const results = await ctx.db.batch([
        ctx.db.prepare(`UPDATE posts SET auto_tags = ? WHERE id = ? AND ${publicTagsBesides('')}`).bind(token, postId, postId),
        ...ids.map(id =>
            ctx.db
                .prepare(
                    `INSERT OR IGNORE INTO post_tags (post_id, tag_id, sort)
                     SELECT ?, ?, COALESCE((SELECT MAX(sort) FROM post_tags WHERE post_id = ?), -1) + 1
                     WHERE (SELECT auto_tags FROM posts WHERE id = ?) = ? AND ${publicTagsBesides(marks)}`
                )
                .bind(postId, id, postId, postId, token, postId, ...ids)
        )
    ]);
    if (!ids.length || !results[0].meta.changes) return null;
    // Published while the model was thinking (a draft tagged on save, then published at once): rebuild with the tags.
    if (post.status !== 'published') {
        const current = await ctx.db.prepare('SELECT status FROM posts WHERE id = ?').bind(postId).first<{ status: string }>();
        if (current?.status === 'published') await publishSite(ctx.env, ctx.db, ctx.options);
    }
    return ids;
}

/** SQL: the post (first parameter) has no public tag other than the ids that follow. */
function publicTagsBesides(marks: string): string {
    return `NOT EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ? AND t.visibility = 'public'${marks ? ` AND pt.tag_id NOT IN (${marks})` : ''})`;
}

function slugsFrom(text: string): string[] {
    try {
        const data = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
        const list = Array.isArray(data) ? data : Array.isArray(data?.tags) ? data.tags : [];
        return list.filter((s: unknown): s is string => typeof s === 'string').map((s: string) => s.trim().toLowerCase());
    } catch {
        return [];
    }
}
