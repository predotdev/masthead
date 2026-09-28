import type { Author, NewsletterSettings, Post, SiteSettings, Snapshot, StaffRecord, StaffRole, Tag } from '@masthead/core';
import { batched } from './db';
import type { Env } from './env';
import { imageSize } from './images';
import { HttpError, newId, now, slugify } from './util';

// ------------------------------------------------------------------ settings

export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
    if (!row) return fallback;
    try {
        return JSON.parse(row.value) as T;
    } catch {
        return fallback;
    }
}

export async function setSetting(db: D1Database, key: string, value: unknown): Promise<void> {
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value)).run();
}

export async function siteSettings(env: Env, db: D1Database): Promise<SiteSettings> {
    const stored = await getSetting<Partial<SiteSettings>>(db, 'site', {});
    const url = env.SITE_URL.endsWith('/') ? env.SITE_URL : `${env.SITE_URL}/`;
    return {
        title: 'Blog',
        description: '',
        locale: 'en',
        ...stored,
        url
    };
}

export interface NewsletterConfig extends NewsletterSettings {
    postalAddress?: string | null;
    footer?: string | null;
    /** Add utm_source=email, utm_medium=newsletter, utm_campaign=<post slug> to links in newsletters. On unless false. */
    utm?: boolean;
    /**
     * Extra headers on every newsletter email, e.g. for an email-events webhook that
     * attributes opens and clicks. Values may use {distinct_id} (the reader's analytics id, else email:<address>),
     * {analytics_id} (empty unless they subscribed on the blog), {member_id}, {post_slug}, {send_id}.
     */
    emailHeaders?: Record<string, string> | null;
}

export async function newsletterSettings(env: Env, db: D1Database): Promise<NewsletterConfig> {
    const stored = await getSetting<NewsletterConfig>(db, 'newsletter', {});
    return { postalAddress: env.POSTAL_ADDRESS ?? null, ...stored };
}

export interface AiSettings {
    textModel?: string | null;
    imageModel?: string | null;
    videoModel?: string | null;
    embeddingModel?: string | null;
    /** Documents the editor's AI reads besides the blog itself: docs, a changelog, an llms.txt. */
    knowledgeSources: string[];
    /** House style for drafts: tone, audience, rules. */
    voice?: string | null;
}

export async function aiSettings(env: Env, db: D1Database): Promise<AiSettings> {
    const stored = await getSetting<Partial<AiSettings>>(db, 'ai', {});
    return {
        textModel: stored.textModel || env.TEXT_MODEL || null,
        imageModel: stored.imageModel || env.IMAGE_MODEL || null,
        videoModel: stored.videoModel || env.VIDEO_MODEL || null,
        embeddingModel: stored.embeddingModel || env.EMBEDDING_MODEL || null,
        knowledgeSources: Array.isArray(stored.knowledgeSources) ? stored.knowledgeSources.filter(u => /^https?:\/\//.test(u)) : [],
        voice: stored.voice ?? null
    };
}

// ------------------------------------------------------------------ posts

interface PostRow {
    id: string;
    type: 'post' | 'page';
    slug: string;
    title: string;
    status: Post['status'];
    body_format: 'markdown' | 'html';
    markdown: string | null;
    html: string | null;
    custom_excerpt: string | null;
    feature_image: string | null;
    feature_image_alt: string | null;
    feature_image_caption: string | null;
    meta_title: string | null;
    meta_description: string | null;
    og_title: string | null;
    og_description: string | null;
    og_image: string | null;
    twitter_title: string | null;
    twitter_description: string | null;
    twitter_image: string | null;
    canonical_url: string | null;
    featured: number;
    newsletter: string | null;
    published_at: string | null;
    created_at: string;
    updated_at: string;
    auto_tags?: string | null;
    target_date?: string | null;
}

function toPost(r: PostRow, tags: string[], authors: string[]): Post {
    return {
        id: r.id,
        type: r.type,
        slug: r.slug,
        title: r.title,
        status: r.status,
        bodyFormat: r.body_format,
        markdown: r.markdown,
        html: r.html,
        customExcerpt: r.custom_excerpt,
        featureImage: r.feature_image,
        featureImageAlt: r.feature_image_alt,
        featureImageCaption: r.feature_image_caption,
        metaTitle: r.meta_title,
        metaDescription: r.meta_description,
        ogTitle: r.og_title,
        ogDescription: r.og_description,
        ogImage: r.og_image,
        twitterTitle: r.twitter_title,
        twitterDescription: r.twitter_description,
        twitterImage: r.twitter_image,
        canonicalUrl: r.canonical_url,
        featured: Boolean(r.featured),
        newsletter: r.newsletter ? JSON.parse(r.newsletter) : null,
        publishedAt: r.published_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        tags,
        authors,
        autoTags: r.auto_tags ? JSON.parse(r.auto_tags) : null,
        targetDate: r.target_date ?? null
    };
}

async function relations(db: D1Database, ids: string[]) {
    const tags = new Map<string, string[]>();
    const authors = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        const marks = chunk.map(() => '?').join(',');
        const [t, a] = await db.batch([
            db.prepare(`SELECT post_id, tag_id FROM post_tags WHERE post_id IN (${marks}) ORDER BY sort`).bind(...chunk),
            db.prepare(`SELECT post_id, staff_id FROM post_authors WHERE post_id IN (${marks}) ORDER BY sort`).bind(...chunk)
        ]);
        for (const r of t.results as { post_id: string; tag_id: string }[]) tags.set(r.post_id, [...(tags.get(r.post_id) ?? []), r.tag_id]);
        for (const r of a.results as { post_id: string; staff_id: string }[]) authors.set(r.post_id, [...(authors.get(r.post_id) ?? []), r.staff_id]);
    }
    return { tags, authors };
}

export interface PostQuery {
    type?: 'post' | 'page';
    status?: string;
    q?: string;
    authorId?: string;
    /** Posts whose review has this status (in_review, approved, changes_requested). */
    review?: string;
    limit?: number;
    offset?: number;
}

export async function listPosts(db: D1Database, q: PostQuery): Promise<{ items: Post[]; total: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.type) (where.push('type = ?'), args.push(q.type));
    if (q.status) (where.push('status = ?'), args.push(q.status));
    if (q.q) (where.push('(title LIKE ? OR slug LIKE ?)'), args.push(`%${q.q}%`, `%${q.q}%`));
    if (q.authorId) (where.push('id IN (SELECT post_id FROM post_authors WHERE staff_id = ?)'), args.push(q.authorId));
    if (q.review) (where.push('id IN (SELECT post_id FROM post_reviews WHERE status = ?)'), args.push(q.review));
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(q.limit ?? 50, 200);
    const [rows, count] = await db.batch([
        db
            .prepare(
                `SELECT id, type, slug, title, status, body_format, NULL AS markdown, NULL AS html, custom_excerpt, feature_image, feature_image_alt, feature_image_caption,
                 meta_title, meta_description, og_title, og_description, og_image, twitter_title, twitter_description, twitter_image, canonical_url,
                 featured, newsletter, published_at, created_at, updated_at, target_date
                 FROM posts ${clause} ORDER BY CASE status WHEN 'draft' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, COALESCE(published_at, updated_at) DESC LIMIT ? OFFSET ?`
            )
            .bind(...args, limit, q.offset ?? 0),
        db.prepare(`SELECT COUNT(*) AS n FROM posts ${clause}`).bind(...args)
    ]);
    const list = rows.results as unknown as PostRow[];
    const rel = await relations(
        db,
        list.map(r => r.id)
    );
    return {
        items: list.map(r => toPost(r, rel.tags.get(r.id) ?? [], rel.authors.get(r.id) ?? [])),
        total: Number((count.results[0] as { n: number }).n)
    };
}

export async function getPost(db: D1Database, id: string): Promise<Post | null> {
    const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<PostRow>();
    if (!row) return null;
    const rel = await relations(db, [id]);
    return toPost(row, rel.tags.get(id) ?? [], rel.authors.get(id) ?? []);
}

export type PostInput = Partial<Omit<Post, 'id' | 'createdAt' | 'updatedAt' | 'newsletter'>> & { id?: string };

const POST_FIELDS: [keyof Post, string][] = [
    ['type', 'type'],
    ['slug', 'slug'],
    ['title', 'title'],
    ['status', 'status'],
    ['bodyFormat', 'body_format'],
    ['markdown', 'markdown'],
    ['html', 'html'],
    ['customExcerpt', 'custom_excerpt'],
    ['featureImage', 'feature_image'],
    ['featureImageAlt', 'feature_image_alt'],
    ['featureImageCaption', 'feature_image_caption'],
    ['metaTitle', 'meta_title'],
    ['metaDescription', 'meta_description'],
    ['ogTitle', 'og_title'],
    ['ogDescription', 'og_description'],
    ['ogImage', 'og_image'],
    ['twitterTitle', 'twitter_title'],
    ['twitterDescription', 'twitter_description'],
    ['twitterImage', 'twitter_image'],
    ['canonicalUrl', 'canonical_url'],
    ['publishedAt', 'published_at'],
    ['targetDate', 'target_date']
];

/** Creates or updates a post. Tags and authors are replaced when given. */
export async function savePost(db: D1Database, input: PostInput, opts: { defaultAuthorId?: string; keepTimestamps?: { createdAt: string; updatedAt: string } } = {}): Promise<Post> {
    const existing = input.id ? await getPost(db, input.id) : null;
    const id = existing?.id ?? input.id ?? newId();
    const title = (input.title ?? existing?.title ?? '').trim();
    const fromTitle = (t: string) => slugify(t) || 'untitled';
    // Until a draft is first published, its slug follows the title unless someone set it by hand.
    const followsTitle =
        !!existing && existing.status === 'draft' && !existing.publishedAt && new RegExp(`^${fromTitle(existing.title).replace(/[-]/g, '\\-')}(-\\d+)?$`).test(existing.slug);
    // Editors send the whole post back; an unchanged slug is not a choice to keep it.
    const chosen = input.slug !== undefined && input.slug !== existing?.slug ? input.slug : undefined;
    const wanted = chosen !== undefined ? slugify(chosen) || fromTitle(title) : !existing || followsTitle ? fromTitle(title) : existing.slug;
    let slug = wanted;
    // Keep slugs unique across posts and pages.
    for (let n = 2; ; n++) {
        const clash = await db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').bind(slug, id).first();
        if (!clash) break;
        slug = `${wanted}-${n}`;
    }
    const merged: Record<string, unknown> = {};
    for (const [key, col] of POST_FIELDS) merged[col] = key in input ? (input as any)[key] : existing ? (existing as any)[key] : null;
    merged.slug = slug;
    merged.title = title;
    merged.type = merged.type ?? 'post';
    merged.status = merged.status ?? 'draft';
    merged.body_format = merged.body_format ?? 'markdown';
    if (merged.target_date === '') merged.target_date = null;
    if (merged.target_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(merged.target_date))) throw new HttpError(400, 'A target date is a day, like 2026-10-06.');
    const featured = input.featured !== undefined ? Number(Boolean(input.featured)) : existing ? Number(existing.featured) : 0;
    const t = now();
    const createdAt = opts.keepTimestamps?.createdAt ?? existing?.createdAt ?? t;
    const updatedAt = opts.keepTimestamps?.updatedAt ?? t;
    const cols = POST_FIELDS.map(([, c]) => c);
    const stmts: D1PreparedStatement[] = [
        db
            .prepare(
                `INSERT INTO posts (id, ${cols.join(', ')}, featured, created_at, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET ${cols.map(c => `${c} = excluded.${c}`).join(', ')}, featured = excluded.featured, updated_at = excluded.updated_at`
            )
            .bind(id, ...cols.map(c => (merged[c] === undefined ? null : merged[c])), featured, createdAt, updatedAt)
    ];
    if (input.tags) {
        stmts.push(db.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(id));
        input.tags.forEach((tagId, i) => stmts.push(db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id, sort) VALUES (?, ?, ?)').bind(id, tagId, i)));
    }
    const authors = input.authors ?? (!existing && opts.defaultAuthorId ? [opts.defaultAuthorId] : undefined);
    if (authors) {
        stmts.push(db.prepare('DELETE FROM post_authors WHERE post_id = ?').bind(id));
        authors.forEach((staffId, i) => stmts.push(db.prepare('INSERT OR IGNORE INTO post_authors (post_id, staff_id, sort) VALUES (?, ?, ?)').bind(id, staffId, i)));
    }
    await db.batch(stmts);
    return (await getPost(db, id))!;
}

export async function setPostNewsletter(db: D1Database, id: string, stats: Post['newsletter']): Promise<void> {
    await db.prepare('UPDATE posts SET newsletter = ? WHERE id = ?').bind(JSON.stringify(stats), id).run();
}

export async function deletePost(db: D1Database, id: string): Promise<void> {
    await db.batch([
        db.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(id),
        db.prepare('DELETE FROM post_authors WHERE post_id = ?').bind(id),
        db.prepare('DELETE FROM posts WHERE id = ?').bind(id)
    ]);
}

// ------------------------------------------------------------------ tags

export async function listTags(db: D1Database): Promise<(Tag & { posts: number })[]> {
    const { results } = await db
        .prepare('SELECT t.*, (SELECT COUNT(*) FROM post_tags pt WHERE pt.tag_id = t.id) AS posts FROM tags t ORDER BY t.name COLLATE NOCASE')
        .all<any>();
    return results.map(r => ({ id: r.id, slug: r.slug, name: r.name, description: r.description, visibility: r.visibility, posts: r.posts }));
}

export async function saveTag(db: D1Database, input: Partial<Tag> & { name?: string }): Promise<Tag> {
    const id = input.id ?? newId();
    const existing = input.id ? await db.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first<any>() : null;
    const name = (input.name ?? existing?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'A tag needs a name.');
    const slug = slugify(input.slug ?? existing?.slug ?? name);
    const t = now();
    await db
        .prepare(
            `INSERT INTO tags (id, slug, name, description, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, description = excluded.description, visibility = excluded.visibility, updated_at = excluded.updated_at`
        )
        .bind(id, slug, name, input.description ?? existing?.description ?? null, input.visibility ?? existing?.visibility ?? (name.startsWith('#') ? 'internal' : 'public'), existing?.created_at ?? t, t)
        .run();
    return { id, slug, name, description: input.description ?? existing?.description ?? null, visibility: input.visibility ?? existing?.visibility ?? 'public' };
}

export async function deleteTag(db: D1Database, id: string): Promise<void> {
    await db.batch([db.prepare('DELETE FROM post_tags WHERE tag_id = ?').bind(id), db.prepare('DELETE FROM tags WHERE id = ?').bind(id)]);
}

// ------------------------------------------------------------------ staff

interface StaffRow {
    id: string;
    email: string;
    name: string;
    slug: string;
    role: StaffRole;
    status: StaffRecord['status'];
    bio: string | null;
    profile_image: string | null;
    website: string | null;
    twitter: string | null;
    linkedin: string | null;
    created_at: string;
    updated_at: string;
    last_seen_at: string | null;
}

function toStaff(r: StaffRow): StaffRecord & { createdAt: string; lastSeenAt: string | null } {
    return {
        id: r.id,
        email: r.email,
        name: r.name,
        slug: r.slug,
        role: r.role,
        status: r.status,
        bio: r.bio,
        profileImage: r.profile_image,
        website: r.website,
        twitter: r.twitter,
        linkedin: r.linkedin,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at
    };
}

export async function listStaff(db: D1Database) {
    const { results } = await db.prepare('SELECT * FROM staff ORDER BY CASE role WHEN \'owner\' THEN 0 WHEN \'admin\' THEN 1 ELSE 2 END, name').all<StaffRow>();
    return results.map(toStaff);
}

export async function getStaff(db: D1Database, id: string) {
    const r = await db.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<StaffRow>();
    return r ? toStaff(r) : null;
}

export async function getStaffByEmail(db: D1Database, email: string) {
    const r = await db.prepare('SELECT * FROM staff WHERE email = ?').bind(email.toLowerCase()).first<StaffRow>();
    return r ? toStaff(r) : null;
}

export async function saveStaff(db: D1Database, input: Partial<StaffRecord> & { email?: string }): Promise<StaffRecord> {
    const existing = input.id ? await getStaff(db, input.id) : input.email ? await getStaffByEmail(db, input.email) : null;
    const id = existing?.id ?? input.id ?? newId();
    const email = (input.email ?? existing?.email ?? '').toLowerCase();
    if (!email) throw new HttpError(400, 'Staff need an email address.');
    const name = (input.name ?? existing?.name ?? email.split('@')[0]).trim();
    let slug = slugify(input.slug ?? existing?.slug ?? name);
    for (let n = 2; ; n++) {
        const clash = await db.prepare('SELECT id FROM staff WHERE slug = ? AND id != ?').bind(slug, id).first();
        if (!clash) break;
        slug = `${slugify(name)}-${n}`;
    }
    const t = now();
    const v = (k: keyof StaffRecord) => (k in input ? (input as any)[k] : existing ? (existing as any)[k] : null) ?? null;
    await db
        .prepare(
            `INSERT INTO staff (id, email, name, slug, role, status, bio, profile_image, website, twitter, linkedin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, slug = excluded.slug, role = excluded.role, status = excluded.status,
               bio = excluded.bio, profile_image = excluded.profile_image, website = excluded.website, twitter = excluded.twitter, linkedin = excluded.linkedin,
               updated_at = excluded.updated_at`
        )
        .bind(id, email, name, slug, v('role') ?? 'author', v('status') ?? 'active', v('bio'), v('profileImage'), v('website'), v('twitter'), v('linkedin'), existing?.createdAt ?? t, t)
        .run();
    return (await getStaff(db, id))!;
}

export async function deleteStaff(db: D1Database, id: string): Promise<void> {
    await db.batch([db.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id), db.prepare('DELETE FROM staff WHERE id = ?').bind(id)]);
}

// ------------------------------------------------------------------ snapshot for publishing

/** Every column but the bodies, for a snapshot that loads bodies on demand. */
const POST_META_COLUMNS =
    'id, type, slug, title, status, body_format, NULL AS markdown, NULL AS html, custom_excerpt, feature_image, feature_image_alt, feature_image_caption, meta_title, meta_description, og_title, og_description, og_image, twitter_title, twitter_description, twitter_image, canonical_url, featured, newsletter, published_at, created_at, updated_at';

/**
 * Everything the site is built from. With `bodies: false` the posts come
 * without their text, which `loadBodies` then fetches a few at a time, so a
 * large site never sits in memory all at once.
 */
export async function loadSnapshot(env: Env, db: D1Database, options: { bodies?: boolean } = {}): Promise<Snapshot> {
    const site = await siteSettings(env, db);
    const [posts, tags, staff] = await db.batch([
        db.prepare(`SELECT ${options.bodies === false ? POST_META_COLUMNS : '*'} FROM posts WHERE status IN ('published','scheduled')`),
        db.prepare('SELECT * FROM tags'),
        db.prepare("SELECT * FROM staff WHERE status != 'suspended'")
    ]);
    const rows = posts.results as unknown as PostRow[];
    const rel = await relations(
        db,
        rows.map(r => r.id)
    );
    const authors: Author[] = (staff.results as unknown as StaffRow[]).map(r => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        bio: r.bio,
        profileImage: r.profile_image,
        website: r.website,
        twitter: r.twitter,
        linkedin: r.linkedin
    }));
    const { results: sized } = await db.prepare('SELECT key, width, height FROM media WHERE width > 0 AND height > 0').all<{ key: string; width: number; height: number }>();
    const base = new URL(env.SITE_URL.endsWith('/') ? env.SITE_URL : `${env.SITE_URL}/`).pathname;
    const imageSizes = Object.fromEntries(sized.map(r => [`${base}${r.key}`, { width: r.width, height: r.height }]));
    if (site.logo) site.logoSize = await logoSize(site.logo, env.SITE_URL, imageSizes);
    return {
        format: 'masthead.snapshot/1',
        exportedAt: now(),
        source: 'masthead',
        imageSizes,
        site,
        posts: rows.map(r => toPost(r, rel.tags.get(r.id) ?? [], rel.authors.get(r.id) ?? [])),
        tags: (tags.results as any[]).map(t => ({ id: t.id, slug: t.slug, name: t.name, description: t.description, visibility: t.visibility })),
        authors
    };
}

/** The bodies of some posts, by id (see loadSnapshot). */
export async function loadBodies(db: D1Database, ids: string[]): Promise<Map<string, Pick<Post, 'html' | 'markdown' | 'bodyFormat'>>> {
    const out = new Map<string, Pick<Post, 'html' | 'markdown' | 'bodyFormat'>>();
    if (!ids.length) return out;
    const { results } = await db
        .prepare(`SELECT id, body_format, markdown, html FROM posts WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(...ids)
        .all<{ id: string; body_format: Post['bodyFormat']; markdown: string | null; html: string | null }>();
    for (const r of results) out.set(r.id, { bodyFormat: r.body_format, markdown: r.markdown, html: r.html });
    return out;
}

export { batched };

const remoteLogoSizes = new Map<string, { width: number; height: number } | null>();

/** A stored logo's recorded size, or a remote one's read from its header (once per isolate). */
async function logoSize(url: string, siteUrl: string, known: Record<string, { width: number; height: number }>): Promise<{ width: number; height: number } | null> {
    const abs = new URL(url, siteUrl);
    const local = known[abs.origin === new URL(siteUrl).origin ? abs.pathname : url];
    if (local) return local;
    if (remoteLogoSizes.has(abs.href)) return remoteLogoSizes.get(abs.href) ?? null;
    try {
        const res = await fetch(abs.href, { signal: AbortSignal.timeout(3000) });
        const size = res.ok ? imageSize(new Uint8Array(await res.arrayBuffer())) : null;
        remoteLogoSizes.set(abs.href, size);
        return size;
    } catch {
        return null;
    }
}
