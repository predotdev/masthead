import type { AspectRatio, ModelKind, Post, StaffRole } from '@masthead/core';
import { renderBody, renderSite, tagLinks } from '@masthead/render';
import { addIdeas, assist, draft, draftIdea, draftIdeaStream, draftStream, edit, editStream, image, imageStream, listIdeas, listModels, meta, metaStream, saveIdeaDraft, startVideo, unfurl, videoStatus } from './ai';
import { autoTag, tagUntagged, wantsAutoTags } from './autotag';
import { atLeast, clearSessionCookie, consumeLoginToken, createApiKey, createLoginToken, createSession, endSession, peekLoginToken, sessionCookie } from './auth';
import { forgetPost, saveAnchors, stripCommentAnchors } from './comments';
import {
    aiSettings,
    deletePost,
    deleteStaff,
    deleteTag,
    getPost,
    getSetting,
    getStaff,
    listPosts,
    listStaff,
    listTags,
    loadBodies,
    loadSnapshot,
    newsletterSettings,
    savePost,
    saveStaff,
    saveTag,
    setSetting,
    siteSettings
} from './content';
import { signInEmail } from './email';
import type { Ctx, Principal } from './env';
import { importAudience, importContent, importMedia, rewriteUrls } from './importer';
import { envDenylist, ideaSettings, ideaStatus, refreshIdeas, saveIdeaSettings } from './ideas';
import { postWebStats, posthogSetup, webStats } from './posthog';
import { markIdeas, postRefs, postSearchStats, searchFailure, searchReady, searchSetup, searchStats } from './search-console';
import { emailReport, firstActivity, makeRange, membersReport, postReport, postsBySlug, rangeKey } from './stats';
import { backfillImages, storeImage } from './images';
import { getRevision, keepRevision, listRevisions } from './revisions';
import { addMemory, deleteMemory, embedPending, knowledgeStats, listMemory, refreshKnowledge, resetKnowledge, suggestLinks } from './knowledge';
import { addMember, deleteMember, getMember, getMemberByEmail, listMembers, memberEvents, memberStats, restoreOptOuts, setStatus, type MemberStatus } from './members';
import { appUrl, buildEmail, cancelSend, countSegment, createSend, getSend, listSends, processSends, sendTest, testMode, unsubscribeUrl, type Segment } from './newsletter';
import { linkTag, publishSite } from './publish';
import { MEDIA_PREFIX } from './public';
import { checkApproval, reviewSummaries, saveWorkflowSettings, workflowSettings } from './review';
import { Router } from './router';
import { share, shareStream } from './share';
import { wantsEvents } from './sse';
import { saveStyleSettings, styleSettings } from './style';
import { HttpError, body, csvEscape, html, json, newId, now, parseCsv, redirect, safeEqual, sleep } from './util';
import { workflowRoutes } from './workflow';

type A = Ctx & { principal?: Principal };
const me = (ctx: A) => atLeast(ctx.principal, 'contributor');

/** Authors and contributors may only touch their own posts; contributors may not publish. */
async function canEdit(ctx: A, post: Post | null, publishing = false) {
    const p = me(ctx);
    if (publishing && p.role === 'contributor') throw new HttpError(403, 'Contributors can save drafts but not publish.');
    if (!post || p.role === 'owner' || p.role === 'admin' || p.role === 'editor') return p;
    if (!post.authors.includes(p.staffId)) throw new HttpError(403, 'You can only edit your own posts.');
    return p;
}

/**
 * Saves AI settings. Memory has its own routes, so a form opened before a new memory
 * never erases it. A new knowledge model or source list re-reads the sources.
 */
async function saveAiSettings(ctx: A, input: Record<string, unknown>) {
    const { memory: _memory, ...ai } = input;
    const before = await aiSettings(ctx.env, ctx.db);
    await setSetting(ctx.db, 'ai', { ...(await getSetting(ctx.db, 'ai', {})), ...ai });
    const after = await aiSettings(ctx.env, ctx.db);
    // Vectors from another model don't compare: re-read everything, and answer without passages until done.
    if (after.embeddingModel !== before.embeddingModel) await resetKnowledge(ctx.db);
    if (after.knowledgeSources.join('\n') !== before.knowledgeSources.join('\n') || after.embeddingModel !== before.embeddingModel) {
        const provider = ctx.options.ai?.(ctx.env) ?? null;
        ctx.exec.waitUntil(refreshKnowledge(ctx).then(() => embedPending(ctx.env, ctx.db, provider)).catch(err => console.error('knowledge refresh', err)));
    }
    return after;
}

/** Rebuilds the site after the response; `after` (e.g. tagging) lands first so the rebuild includes it. */
function republish(ctx: A, after?: Promise<unknown>) {
    const ready = after ? after.catch(() => null) : Promise.resolve();
    ctx.exec.waitUntil(ready.then(() => publishSite(ctx.env, ctx.db, ctx.options)).catch(err => console.error('publish failed', err)));
}

export function adminRoutes(): Router<A> {
    const r = new Router<A>();

    // ---------------------------------------------------------- auth
    r.post('/auth/login', async (req, ctx) => {
        const { email } = await body(req);
        const login = email ? await createLoginToken(ctx.db, String(email)) : null;
        const transport = ctx.options.email?.(ctx.env);
        if (login && transport && ctx.env.EMAIL_FROM) {
            const site = await siteSettings(ctx.env, ctx.db);
            const mail = signInEmail(site, `${appUrl(ctx.env)}admin/#/verify/${login.token}`, false);
            ctx.exec.waitUntil(transport.send([{ to: login.staff.email, from: ctx.env.EMAIL_FROM, subject: mail.subject, html: mail.html, text: mail.text, idempotencyKey: `login:${login.token.slice(0, 16)}` }]));
        }
        // Same answer whether or not the address belongs to staff.
        return json({ ok: true });
    });

    // Sign-in links open the admin at #/verify/<token>: the token never reaches a server log, and
    // only a person's click uses it up, never a mail scanner fetching the link. Older links land here.
    r.get('/auth/verify', async (_req, ctx) => redirect(`${ctx.basePath}admin/#/verify/${encodeURIComponent(ctx.url.searchParams.get('token') ?? '')}`, 302));

    r.get('/auth/link', async (_req, ctx) => json(await peekLoginToken(ctx.db, ctx.url.searchParams.get('token') ?? '')));

    r.post('/auth/verify', async (req, ctx) => {
        const { token } = await body(req);
        const staffId = await consumeLoginToken(ctx.db, String(token ?? ''));
        if (!staffId) throw new HttpError(400, 'This sign-in link was already used or has expired.');
        const session = await createSession(ctx.db, staffId);
        return json({ ok: true }, 200, { 'set-cookie': sessionCookie(session) });
    });

    /** The login screen's branding. Public: the same title and logo the site shows everyone. */
    r.get('/auth/brand', async (_req, ctx) => {
        const site = await siteSettings(ctx.env, ctx.db);
        return json({ title: site.title, logo: site.logo ?? null, invertLogoInLight: Boolean(site.appearance?.invertLogoInLight) });
    });

    r.post('/auth/bootstrap', async (req, ctx) => {
        const { token, email, name } = await body(req);
        if (!ctx.env.BOOTSTRAP_TOKEN || ctx.env.BOOTSTRAP_TOKEN.length < 32 || !safeEqual(String(token ?? ''), ctx.env.BOOTSTRAP_TOKEN)) throw new HttpError(401, 'That token is not valid.');
        let owner = (await listStaff(ctx.db)).find(s => s.role === 'owner');
        if (!owner) {
            if (!email) throw new HttpError(400, 'No owner exists yet. Send email and name to create one.');
            owner = { ...(await saveStaff(ctx.db, { email: String(email), name: String(name ?? email), role: 'owner', status: 'active' })), createdAt: now(), lastSeenAt: null };
        }
        const session = await createSession(ctx.db, owner.id);
        return json({ ok: true }, 200, { 'set-cookie': sessionCookie(session) });
    });

    r.post('/auth/logout', async (req, ctx) => {
        await endSession(req, ctx.db);
        return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
    });

    r.get('/me', async (_req, ctx) => {
        const p = me(ctx);
        const site = await siteSettings(ctx.env, ctx.db);
        return json({ user: p, site: { title: site.title, url: site.url, icon: site.icon ?? null }, appUrl: appUrl(ctx.env), testMode: testMode(ctx.env) });
    });

    // ---------------------------------------------------------- posts
    r.get('/posts', async (_req, ctx) => {
        const p = me(ctx);
        const s = ctx.url.searchParams;
        const own = p.role === 'author' || p.role === 'contributor';
        const page = await listPosts(ctx.db, {
            type: (s.get('type') as 'post' | 'page') || undefined,
            status: s.get('status') || undefined,
            q: s.get('q') || undefined,
            authorId: own ? p.staffId : undefined,
            review: s.get('review') || undefined,
            limit: Number(s.get('limit') ?? 50),
            offset: Number(s.get('offset') ?? 0)
        });
        const reviews = await reviewSummaries(ctx.db, page.items.map(x => x.id));
        return json({ ...page, items: page.items.map(x => ({ ...x, review: reviews.get(x.id) ?? null })) });
    });

    r.get('/posts/:id', async (_req, ctx, { id }) => {
        const post = await getPost(ctx.db, id);
        if (!post) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, post);
        return json(post);
    });

    r.post('/posts', async (req, ctx) => {
        const p = me(ctx);
        const input = await body(req);
        const post = await savePost(ctx.db, { ...input, id: undefined, status: 'draft', bodyFormat: input.bodyFormat ?? 'markdown' }, { defaultAuthorId: p.staffId.includes(':') ? undefined : p.staffId });
        return json(post, 201);
    });

    r.put('/posts/:id', async (req, ctx, { id }) => {
        const existing = await getPost(ctx.db, id);
        if (!existing) throw new HttpError(404, 'Post not found.');
        const p = await canEdit(ctx, existing);
        const input = await body(req);
        delete input.status;
        if ((p.role === 'author' || p.role === 'contributor') && input.authors) delete input.authors;
        // Comment anchors come with the text they sit on and are kept with the comments, never in the post.
        const anchors = input.commentAnchors;
        delete input.commentAnchors;
        if (typeof input.html === 'string') input.html = await stripCommentAnchors(input.html);
        await keepRevision(ctx.db, existing, input, p.name, 'edited');
        const post = await savePost(ctx.db, { ...input, id });
        await saveAnchors(ctx.db, id, anchors);
        // A post without a topic gets tags picked after the response (autotag.ts); the editor fetches them.
        const tagging = await wantsAutoTags(ctx, post);
        if (post.status === 'published') republish(ctx, tagging ? autoTag(ctx, id) : undefined);
        else if (tagging) ctx.exec.waitUntil(autoTag(ctx, id).catch(err => console.error('auto-tagging failed', err)));
        return json(tagging ? { ...post, autoTagging: true } : post);
    });

    // ---------------------------------------------------------- history
    r.get('/posts/:id/revisions', async (_req, ctx, { id }) => {
        const existing = await getPost(ctx.db, id);
        if (!existing) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, existing);
        return json(await listRevisions(ctx.db, id));
    });
    r.get('/posts/:id/revisions/:rid', async (_req, ctx, { id, rid }) => {
        const existing = await getPost(ctx.db, id);
        if (!existing) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, existing);
        const rev = await getRevision(ctx.db, id, Number(rid));
        if (!rev) throw new HttpError(404, 'That version is gone.');
        return json({ ...rev, rendered: tagLinks(renderBody({ ...existing, ...rev } as Post), '', undefined) });
    });
    /**
     * Hands a version back to the editor, which loads it as unsaved changes (a
     * live post changes only when you click Update). The current text is kept
     * as a version first, so a restore can itself be undone.
     */
    r.post('/posts/:id/revisions/:rid/restore', async (_req, ctx, { id, rid }) => {
        const existing = await getPost(ctx.db, id);
        if (!existing) throw new HttpError(404, 'Post not found.');
        const p = await canEdit(ctx, existing);
        const rev = await getRevision(ctx.db, id, Number(rid));
        if (!rev) throw new HttpError(404, 'That version is gone.');
        await keepRevision(ctx.db, existing, {}, p.name, 'restored');
        return json(rev);
    });

    r.post('/posts/:id/publish', async (req, ctx, { id }) => {
        const existing = await getPost(ctx.db, id);
        if (!existing) throw new HttpError(404, 'Post not found.');
        await checkApproval(ctx.db, existing, await canEdit(ctx, existing, true));
        if (!existing.title.trim()) throw new HttpError(400, 'Add a title before publishing.');
        const { publishedAt } = await body(req);
        const when = publishedAt ? new Date(publishedAt) : existing.publishedAt && existing.status === 'published' ? new Date(existing.publishedAt) : new Date();
        if (Number.isNaN(when.getTime())) throw new HttpError(400, 'publishedAt is not a valid date.');
        const status = when.getTime() > Date.now() + 60_000 ? 'scheduled' : 'published';
        await keepRevision(ctx.db, existing, {}, (await canEdit(ctx, existing, true)).name, 'published');
        const post = await savePost(ctx.db, { id, status, publishedAt: when.toISOString() });
        // A post going out without a topic gets its tags first, so the rebuild includes them. A slow model
        // finishes after the response and the site is rebuilt again; a scheduled post is tagged meanwhile.
        const tagging = (await wantsAutoTags(ctx, post, true)) ? autoTag(ctx, id, true).catch(() => null) : null;
        const tagged = tagging && status === 'published' ? await Promise.race([tagging, sleep(8000).then(() => undefined)]) : undefined;
        const result = status === 'published' ? await publishSite(ctx.env, ctx.db, ctx.options) : null;
        const pending = !!tagging && tagged === undefined;
        if (pending) ctx.exec.waitUntil(tagging!.then(ids => (ids?.length && status === 'published' ? publishSite(ctx.env, ctx.db, ctx.options) : null)).catch(err => console.error('publish failed', err)));
        // The writing assistant learns the new post.
        if (status === 'published') ctx.exec.waitUntil(refreshKnowledge(ctx, { postsOnly: true }).then(() => embedPending(ctx.env, ctx.db, ctx.options.ai?.(ctx.env) ?? null, 20_000)).catch(() => {}));
        const out = tagging ? ((await getPost(ctx.db, id)) ?? post) : post;
        return json({ post: pending ? { ...out, autoTagging: true } : out, publish: result });
    });

    /** Topics for published posts that have none, e.g. from before tags were picked automatically. */
    r.post('/posts/auto-tag', async (_req, ctx) => (atLeast(ctx.principal, 'editor'), json(await tagUntagged(ctx))));

    r.post('/posts/:id/unpublish', async (_req, ctx, { id }) => {
        const existing = await getPost(ctx.db, id);
        if (!existing) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, existing, true);
        const post = await savePost(ctx.db, { id, status: 'draft' });
        return json({ post, publish: await publishSite(ctx.env, ctx.db, ctx.options) });
    });

    r.post('/posts/:id/convert', async (_req, ctx, { id }) => {
        const existing = await getPost(ctx.db, id);
        if (!existing) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, existing);
        return json(await savePost(ctx.db, { id, bodyFormat: 'markdown', markdown: existing.markdown ?? '' }));
    });

    r.delete('/posts/:id', async (_req, ctx, { id }) => {
        const existing = await getPost(ctx.db, id);
        if (!existing) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, existing, existing.status !== 'draft');
        await deletePost(ctx.db, id);
        await forgetPost(ctx.db, id);
        if (existing.status !== 'draft') republish(ctx);
        return json({ ok: true });
    });

    /** The post as readers would see it, rendered from the current saved state. */
    r.get('/posts/:id/preview', async (_req, ctx, { id }) => {
        const post = await getPost(ctx.db, id);
        if (!post) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, post);
        const snap = await loadSnapshot(ctx.env, ctx.db, { bodies: false });
        const previewPost: Post = { ...post, status: 'published', publishedAt: post.publishedAt ?? now() };
        snap.posts = [...snap.posts.filter(p => p.id !== id), previewPost];
        // Stream the site and stop at this post's page; its unsaved-to-site body comes from the draft itself.
        const want = `${ctx.basePath.slice(1)}${post.slug}/index.html`;
        const bodies = {
            load: async (ids: string[]) => {
                const found = await loadBodies(ctx.db, ids.filter(x => x !== id));
                if (ids.includes(id)) found.set(id, { html: post.html, markdown: post.markdown, bodyFormat: post.bodyFormat });
                return found;
            }
        };
        for await (const file of renderSite(snap, { theme: ctx.options.theme, render: { linkTag: linkTag(ctx.env) }, features: { subscribeUrl: `${ctx.basePath}api/subscribe` } }, bodies)) {
            // Previews never load analytics (the features above leave it out).
            if (file.path === want) return html(String(file.contents).replace('<head>', '<head><meta name="robots" content="noindex">'));
        }
        throw new HttpError(500, 'Preview failed to render.');
    });

    // ---------------------------------------------------------- tags
    r.get('/tags', async (_req, ctx) => (me(ctx), json(await listTags(ctx.db))));
    r.post('/tags', async (req, ctx) => (atLeast(ctx.principal, 'editor'), json(await saveTag(ctx.db, { ...(await body(req)), id: undefined }), 201)));
    r.put('/tags/:id', async (req, ctx, { id }) => {
        atLeast(ctx.principal, 'editor');
        const tag = await saveTag(ctx.db, { ...(await body(req)), id });
        republish(ctx);
        return json(tag);
    });
    r.delete('/tags/:id', async (_req, ctx, { id }) => {
        atLeast(ctx.principal, 'editor');
        await deleteTag(ctx.db, id);
        republish(ctx);
        return json({ ok: true });
    });

    // ---------------------------------------------------------- staff
    r.get('/staff', async (_req, ctx) => (me(ctx), json(await listStaff(ctx.db))));

    r.post('/staff', async (req, ctx) => {
        atLeast(ctx.principal, 'admin');
        const { email, name, role } = await body(req);
        if (role === 'owner') throw new HttpError(400, 'There is one owner.');
        const staff = await saveStaff(ctx.db, { email: String(email ?? ''), name: name ? String(name) : undefined, role: (role as StaffRole) || 'author', status: 'invited' });
        const login = await createLoginToken(ctx.db, staff.email);
        const transport = ctx.options.email?.(ctx.env);
        let invited = false;
        if (login && transport && ctx.env.EMAIL_FROM) {
            const site = await siteSettings(ctx.env, ctx.db);
            const mail = signInEmail(site, `${appUrl(ctx.env)}admin/#/verify/${login.token}`, true);
            const [res] = await transport.send([{ to: staff.email, from: ctx.env.EMAIL_FROM, subject: mail.subject, html: mail.html, text: mail.text, idempotencyKey: `invite:${staff.id}:${Date.now()}` }]);
            invited = Boolean(res?.ok);
        }
        return json({ staff, invited }, 201);
    });

    r.put('/staff/:id', async (req, ctx, { id }) => {
        const p = me(ctx);
        const input = await body(req);
        const target = await getStaff(ctx.db, id);
        if (!target) throw new HttpError(404, 'Staff member not found.');
        const self = p.staffId === id;
        if (!self) atLeast(p, 'admin');
        if ((input.role && input.role !== target.role) || (input.status && input.status !== target.status)) {
            atLeast(p, 'admin');
            if (target.role === 'owner' || input.role === 'owner') throw new HttpError(400, 'The owner role cannot be changed here.');
        }
        return json(await saveStaff(ctx.db, { ...input, id }));
    });

    r.delete('/staff/:id', async (_req, ctx, { id }) => {
        atLeast(ctx.principal, 'admin');
        const target = await getStaff(ctx.db, id);
        if (!target) throw new HttpError(404, 'Staff member not found.');
        if (target.role === 'owner') throw new HttpError(400, 'The owner cannot be removed.');
        await deleteStaff(ctx.db, id);
        return json({ ok: true });
    });

    // ---------------------------------------------------------- members
    r.get('/members', async (_req, ctx) => {
        atLeast(ctx.principal, 'admin');
        const s = ctx.url.searchParams;
        const [page, stats] = await Promise.all([
            listMembers(ctx.db, {
                q: s.get('q') || undefined,
                status: s.get('status') || undefined,
                suppressed: s.has('suppressed') ? s.get('suppressed') === 'true' : undefined,
                flag: s.get('flag') || undefined,
                label: s.get('label') || undefined,
                limit: Number(s.get('limit') ?? 50),
                offset: Number(s.get('offset') ?? 0)
            }),
            memberStats(ctx.db)
        ]);
        return json({ ...page, stats });
    });

    r.get('/members/export.csv', async (_req, ctx) => {
        atLeast(ctx.principal, 'admin');
        const { results } = await ctx.db.prepare('SELECT email, name, status, suppressed, labels, source, created_at, email_count, opened_count FROM members ORDER BY created_at').all<any>();
        const lines = ['email,name,status,suppressed,labels,source,created_at,email_count,opened_count'];
        for (const m of results) lines.push([m.email, m.name, m.status, m.suppressed, JSON.parse(m.labels).join(';'), m.source, m.created_at, m.email_count, m.opened_count].map(csvEscape).join(','));
        return new Response(lines.join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="members.csv"', 'cache-control': 'no-store' } });
    });

    r.post('/members/import.csv', async (req, ctx) => {
        atLeast(ctx.principal, 'admin');
        const rows = parseCsv(await req.text());
        const header = rows.shift()?.map(h => h.trim().toLowerCase()) ?? [];
        const ei = header.indexOf('email');
        if (ei < 0) throw new HttpError(400, 'The CSV needs an email column.');
        const ni = header.indexOf('name');
        const li = header.indexOf('labels');
        let created = 0;
        let existing = 0;
        let invalid = 0;
        for (const row of rows.slice(0, 20000)) {
            try {
                const res = await addMember(ctx.db, { email: row[ei], name: ni >= 0 ? row[ni] || null : null, labels: li >= 0 && row[li] ? row[li].split(/[;|]/).map(s => s.trim()).filter(Boolean) : [] }, 'admin');
                res.created ? created++ : existing++;
            } catch {
                invalid++;
            }
        }
        return json({ created, existing, invalid });
    });

    /** For product integrations: adds people, never changes an existing member's subscription. */
    r.post('/members', async (req, ctx) => {
        const p = atLeast(ctx.principal, 'admin');
        const input = await body(req);
        const res = await addMember(ctx.db, { email: String(input.email ?? ''), name: input.name ?? null, labels: Array.isArray(input.labels) ? input.labels.map(String) : [], note: input.note ?? null }, p.via === 'api-key' ? 'api' : 'admin');
        return json(res, res.created ? 201 : 200);
    });

    /** Removes someone by address, e.g. when your product deletes their account. */
    r.delete('/members', async (_req, ctx) => {
        atLeast(ctx.principal, 'admin');
        const email = (ctx.url.searchParams.get('email') ?? '').trim().toLowerCase();
        if (!email) throw new HttpError(400, 'Pass the address as ?email=.');
        const member = await getMemberByEmail(ctx.db, email);
        if (!member) return json({ ok: true, deleted: false });
        await deleteMember(ctx.db, member.id);
        return json({ ok: true, deleted: true });
    });

    r.post('/members/restore-opt-outs', async (_req, ctx) => {
        atLeast(ctx.principal, 'admin');
        return json({ restored: await restoreOptOuts(ctx.db) });
    });

    r.get('/members/:id', async (_req, ctx, { id }) => {
        atLeast(ctx.principal, 'admin');
        const member = await getMember(ctx.db, id);
        if (!member) throw new HttpError(404, 'Member not found.');
        return json({ member, events: await memberEvents(ctx.db, id) });
    });

    /** The member's own unsubscribe link, e.g. for someone who asks support how to stop emails. */
    r.get('/members/:id/unsubscribe-link', async (_req, ctx, { id }) => {
        atLeast(ctx.principal, 'admin');
        if (!(await getMember(ctx.db, id))) throw new HttpError(404, 'Member not found.');
        return json({ url: await unsubscribeUrl(ctx.env, id) });
    });

    r.put('/members/:id', async (req, ctx, { id }) => {
        atLeast(ctx.principal, 'admin');
        const member = await getMember(ctx.db, id);
        if (!member) throw new HttpError(404, 'Member not found.');
        const input = await body(req);
        if (input.name !== undefined || input.labels !== undefined || input.note !== undefined) {
            await ctx.db
                .prepare('UPDATE members SET name = ?, labels = ?, note = ?, updated_at = ? WHERE id = ?')
                .bind(input.name ?? member.name, JSON.stringify(Array.isArray(input.labels) ? input.labels : member.labels), input.note ?? member.note, now(), id)
                .run();
        }
        if (input.status && input.status !== member.status) {
            if (input.status === 'subscribed' && member.status === 'unsubscribed' && input.confirm !== true)
                throw new HttpError(400, 'This person unsubscribed. Pass confirm: true only if they asked to be subscribed again.');
            await setStatus(ctx.db, member, input.status as MemberStatus, 'admin');
        }
        return json({ member: await getMember(ctx.db, id) });
    });

    r.delete('/members/:id', async (_req, ctx, { id }) => {
        atLeast(ctx.principal, 'admin');
        await deleteMember(ctx.db, id);
        return json({ ok: true });
    });

    // ---------------------------------------------------------- newsletter
    r.get('/sends', async (_req, ctx) => (atLeast(ctx.principal, 'editor'), json(await listSends(ctx.db))));
    r.get('/sends/segment', async (_req, ctx) => {
        atLeast(ctx.principal, 'editor');
        return json({ count: await countSegment(ctx.db, (ctx.url.searchParams.get('segment') as Segment) || 'all', ctx.env), testMode: testMode(ctx.env) });
    });
    r.get('/sends/preview', async (_req, ctx) => {
        atLeast(ctx.principal, 'editor');
        const post = await getPost(ctx.db, ctx.url.searchParams.get('postId') ?? '');
        if (!post) throw new HttpError(404, 'Post not found.');
        const email = await buildEmail(ctx.env, ctx.db, post);
        return html(email.html.replaceAll('%%MASTHEAD_UNSUBSCRIBE%%', '#'));
    });
    r.get('/sends/:id', async (_req, ctx, { id }) => (atLeast(ctx.principal, 'editor'), json(await getSend(ctx.db, id))));
    r.post('/sends/test', async (req, ctx) => {
        atLeast(ctx.principal, 'editor');
        const input = await body(req);
        return json(await sendTest(ctx.env, ctx.db, ctx.options, { postId: String(input.postId ?? ''), emails: Array.isArray(input.emails) ? input.emails : [] }));
    });
    r.post('/sends', async (req, ctx) => {
        const p = atLeast(ctx.principal, 'editor');
        const input = await body(req);
        if (input.confirm !== 'send') throw new HttpError(400, 'Pass confirm: "send" to start sending.');
        const send = await createSend(ctx.env, ctx.db, p, { postId: String(input.postId ?? ''), segment: input.segment, subject: input.subject, force: input.force === true });
        ctx.exec.waitUntil(processSends(ctx.env, ctx.db, ctx.options, 25_000).catch(err => console.error('send failed', err)));
        return json(send, 201);
    });
    r.post('/sends/:id/cancel', async (_req, ctx, { id }) => (atLeast(ctx.principal, 'editor'), json(await cancelSend(ctx.db, id))));
    r.post('/sends/process', async (_req, ctx) => (atLeast(ctx.principal, 'admin'), json(await processSends(ctx.env, ctx.db, ctx.options, 20_000))));

    // ---------------------------------------------------------- media
    r.post('/media', async (req, ctx) => {
        me(ctx);
        const form = await req.formData();
        const file = form.get('file');
        if (!file || typeof file === 'string') throw new HttpError(400, 'Attach a file.');
        const f = file as unknown as File;
        if (f.size > 50 * 1024 * 1024) throw new HttpError(413, 'Files can be up to 50 MB.');
        const ext = (f.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
        const kind = f.type.startsWith('image/') ? 'images' : f.type.startsWith('video/') ? 'media' : 'files';
        const d = new Date();
        const rel = `content/${kind}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${newId()}.${ext}`;
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (kind === 'images') {
            const size = await storeImage(ctx.env, ctx.db, rel, bytes, f.type, 'upload');
            return json({ url: `${ctx.basePath}${rel}`, width: size?.width ?? null, height: size?.height ?? null }, 201);
        }
        await ctx.env.BUCKET.put(`${MEDIA_PREFIX}${rel}`, bytes, { httpMetadata: { contentType: f.type || 'application/octet-stream' } });
        await ctx.db.prepare('INSERT INTO media (key, content_type, size, source_url, created_at) VALUES (?, ?, ?, ?, ?)').bind(rel, f.type, f.size, 'upload', now()).run();
        return json({ url: `${ctx.basePath}${rel}` }, 201);
    });

    /** Records sizes (and makes missing resized copies) for images stored before sizes were kept. */
    r.post('/media/backfill', async (_req, ctx) => {
        atLeast(ctx.principal, 'admin');
        return json(await backfillImages(ctx.env, ctx.db));
    });

    // ---------------------------------------------------------- settings
    r.get('/settings', async (_req, ctx) => {
        atLeast(ctx.principal, 'admin');
        const [site, newsletter, ai, memory, knowledge, ideas, style, workflow] = await Promise.all([
            siteSettings(ctx.env, ctx.db),
            newsletterSettings(ctx.env, ctx.db),
            aiSettings(ctx.env, ctx.db),
            listMemory(ctx.db),
            knowledgeStats(ctx.db),
            ideaSettings(ctx.db),
            styleSettings(ctx.db),
            workflowSettings(ctx.db)
        ]);
        const { results: keys } = await ctx.db.prepare('SELECT id, name, prefix, role, created_at, last_used_at FROM api_keys ORDER BY created_at DESC').all();
        return json({
            site,
            newsletter,
            ai: { ...ai, memory },
            knowledge,
            // The DENYLIST variable's terms stay out of the response; only how many there are.
            ideas: { ...ideas, envDenylist: envDenylist(ctx.env).length },
            style,
            workflow,
            keys,
            environment: {
                siteUrl: ctx.env.SITE_URL,
                appUrl: appUrl(ctx.env),
                testMode: testMode(ctx.env),
                emailFrom: ctx.env.EMAIL_FROM ?? null,
                email: Boolean(ctx.options.email?.(ctx.env)),
                ai: Boolean(ctx.options.ai?.(ctx.env)),
                webhooks: Boolean(ctx.env.RESEND_WEBHOOK_SECRET),
                linkTag: ctx.env.LINK_TAG ?? null
            }
        });
    });

    r.put('/settings', async (req, ctx) => {
        atLeast(ctx.principal, 'admin');
        const input = await body(req);
        if (input.site) {
            const { url: _ignored, ...site } = input.site;
            await setSetting(ctx.db, 'site', { ...(await getSetting(ctx.db, 'site', {})), ...site });
            republish(ctx);
        }
        if (input.newsletter) await setSetting(ctx.db, 'newsletter', { ...(await getSetting(ctx.db, 'newsletter', {})), ...input.newsletter });
        if (input.ideas) await saveIdeaSettings(ctx.db, input.ideas);
        if (input.style) await saveStyleSettings(ctx.db, input.style);
        if (input.workflow) await saveWorkflowSettings(ctx.db, input.workflow);
        if (input.ai) await saveAiSettings(ctx, input.ai);
        return json({ ok: true });
    });

    r.post('/keys', async (req, ctx) => {
        const p = atLeast(ctx.principal, 'admin');
        const { name, role } = await body(req);
        const allowed: StaffRole[] = ['admin', 'editor', 'author'];
        return json(await createApiKey(ctx.db, String(name || 'Integration'), allowed.includes(role) ? role : 'admin', p.staffId), 201);
    });
    r.delete('/keys/:id', async (_req, ctx, { id }) => {
        atLeast(ctx.principal, 'admin');
        await ctx.db.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
        return json({ ok: true });
    });

    r.post('/publish', async (_req, ctx) => (atLeast(ctx.principal, 'editor'), json(await publishSite(ctx.env, ctx.db, ctx.options))));

    // ---------------------------------------------------------- analytics
    // Reader traffic comes from PostHog when it is connected; newsletters and growth come from here.
    // A PostHog failure is an answer (status "error"), so the rest of the page still shows.
    const rangeOf = async (ctx: A, first?: string | null) => {
        const key = rangeKey(ctx.url.searchParams.get('range'));
        return makeRange(key, key === 'all' ? (first ?? (await firstActivity(ctx.db))) : null);
    };
    const refresh = (ctx: A) => ctx.url.searchParams.get('refresh') === '1';

    r.get('/analytics/web', async (_req, ctx) => {
        me(ctx);
        const range = await rangeOf(ctx);
        const setup = posthogSetup(ctx.env);
        if (!setup.key || !setup.project) return json({ status: 'off', setup, range });
        try {
            const res = await webStats(ctx, range, refresh(ctx));
            const base = ctx.basePath;
            const fromPath = (path: string) => (path.startsWith(base) && /^[^/]+\/?$/.test(path.slice(base.length)) ? path.slice(base.length).replace(/\/$/, '') : null);
            const slugs = [...res.data.posts.map(p => p.slug), ...res.data.pages.map(p => fromPath(p.path)), ...res.data.signups.map(p => p.slug)].filter((x): x is string => Boolean(x));
            return json({ ...res, setup, range, titles: Object.fromEntries(await postsBySlug(ctx.db, [...new Set(slugs)])) });
        } catch (err: any) {
            return json({ status: 'error', setup, range, error: err?.message ?? 'PostHog did not answer.' });
        }
    });

    r.get('/analytics/email', async (_req, ctx) => {
        atLeast(ctx.principal, 'editor');
        return json(await emailReport(ctx.env, ctx.db, await rangeOf(ctx)));
    });

    r.get('/analytics/members', async (_req, ctx) => {
        atLeast(ctx.principal, 'editor');
        return json(await membersReport(ctx.env, ctx.db, await rangeOf(ctx)));
    });

    /** One post: its newsletter and the members it brought in. "All time" starts when it was published. */
    r.get('/analytics/posts/:id', async (_req, ctx, { id }) => {
        const post = await getPost(ctx.db, id);
        if (!post) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, post).catch(err => {
            throw err instanceof HttpError && err.status === 403 ? new HttpError(403, 'Newsletter and signup numbers are shown for your own posts.') : err;
        });
        return json(await postReport(ctx.env, ctx.db, post, await rangeOf(ctx, post.publishedAt ?? post.createdAt)));
    });

    r.get('/analytics/posts/:id/web', async (_req, ctx, { id }) => {
        me(ctx);
        const post = await getPost(ctx.db, id);
        if (!post) throw new HttpError(404, 'Post not found.');
        const range = await rangeOf(ctx, post.publishedAt ?? post.createdAt);
        const setup = posthogSetup(ctx.env);
        if (!setup.key || !setup.project) return json({ status: 'off', setup, range });
        try {
            return json({ ...(await postWebStats(ctx, post.slug, range, refresh(ctx))), setup, range });
        } catch (err: any) {
            return json({ status: 'error', setup, range, error: err?.message ?? 'PostHog did not answer.' });
        }
    });

    // Google Search Console: off (not set up), blocked (Google refuses, with the reason), error (try again later) or ok.
    // Titles and search snippets are read fresh, so a rewrite shows at once; the numbers come from the cache.
    r.get('/analytics/search', async (_req, ctx) => {
        me(ctx);
        const setup = searchSetup(ctx.env);
        if (!searchReady(setup)) return json({ status: 'off', setup });
        try {
            const res = await searchStats(ctx, rangeKey(ctx.url.searchParams.get('range')), refresh(ctx));
            const slugs = [...res.data.pages.map(p => p.slug), ...res.data.opportunities.map(o => o.slug ?? o.best?.slug)].filter((x): x is string => Boolean(x));
            return json({ ...res, data: { ...res.data, opportunities: await markIdeas(ctx.db, res.data.opportunities) }, setup, posts: await postRefs(ctx.db, slugs) });
        } catch (err) {
            return json(searchFailure(err, setup));
        }
    });

    r.get('/analytics/posts/:id/search', async (_req, ctx, { id }) => {
        me(ctx);
        const post = await getPost(ctx.db, id);
        if (!post) throw new HttpError(404, 'Post not found.');
        const setup = searchSetup(ctx.env);
        if (!searchReady(setup)) return json({ status: 'off', setup });
        try {
            const res = await postSearchStats(ctx, post, rangeKey(ctx.url.searchParams.get('range')), refresh(ctx));
            const siteUrl = ctx.env.SITE_URL.endsWith('/') ? ctx.env.SITE_URL : `${ctx.env.SITE_URL}/`;
            return json({ ...res, setup, post: { ...(await postRefs(ctx.db, [post.slug]))[post.slug], url: `${siteUrl}${post.slug}/` } });
        } catch (err) {
            return json(searchFailure(err, setup));
        }
    });

    // ---------------------------------------------------------- AI studio
    r.get('/ai/models', async (_req, ctx) => (me(ctx), json(await listModels(ctx, (ctx.url.searchParams.get('kind') as ModelKind) || undefined))));
    /** What the editor's AI panel shows everyone: the default models, the house style and the knowledge sources. */
    r.get('/ai/settings', async (_req, ctx) => {
        me(ctx);
        const [ai, knowledge] = await Promise.all([aiSettings(ctx.env, ctx.db), knowledgeStats(ctx.db)]);
        return json({ ...ai, knowledge });
    });
    /** Changes them from the editor. The knowledge model stays in Settings: changing it re-reads everything. */
    r.put('/ai/settings', async (req, ctx) => {
        atLeast(ctx.principal, 'admin');
        const input = await body(req);
        const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        const patch: Record<string, unknown> = {};
        for (const key of ['textModel', 'imageModel', 'videoModel'] as const) if (key in input) patch[key] = text(input[key]);
        if ('voice' in input) patch.voice = typeof input.voice === 'string' && input.voice.trim() ? input.voice : null;
        if (Array.isArray(input.knowledgeSources)) patch.knowledgeSources = [...new Set(input.knowledgeSources.map(String).map((u: string) => u.trim()).filter((u: string) => /^https?:\/\/\S+$/.test(u)))];
        const ai = await saveAiSettings(ctx, patch);
        return json({ ...ai, knowledge: await knowledgeStats(ctx.db) });
    });
    // Each generation answers with one JSON object, or streams server-sent events when asked for text/event-stream.
    r.post('/ai/draft', async (req, ctx) => {
        me(ctx);
        const input = (await body(req)) as any;
        return wantsEvents(req) ? draftStream(ctx, input, req.signal) : json(await draft(ctx, input));
    });
    r.post('/ai/edit', async (req, ctx) => {
        me(ctx);
        const input = (await body(req)) as any;
        return wantsEvents(req) ? editStream(ctx, input, req.signal) : json(await edit(ctx, input));
    });
    r.post('/ai/meta', async (req, ctx) => {
        me(ctx);
        const input = (await body(req)) as any;
        return wantsEvents(req) ? metaStream(ctx, input, req.signal) : json(await meta(ctx, input));
    });
    r.post('/ai/image', async (req, ctx) => {
        me(ctx);
        const input = await body(req);
        const args = {
            prompt: String(input.prompt ?? ''),
            aspectRatio: input.aspectRatio as AspectRatio,
            model: input.model ? String(input.model) : undefined,
            reference: input.reference ? String(input.reference) : undefined
        };
        return wantsEvents(req) ? imageStream(ctx, args, req.signal) : json(await image(ctx, args));
    });
    /** The writing assistant, streamed: chat, rewrite a selection, write at the cursor, or continue. */
    r.post('/ai/assist', async (req, ctx) => (me(ctx), assist(ctx, (await body(req)) as any, req.signal)));
    r.post('/ai/video', async (req, ctx) => {
        const p = me(ctx);
        const input = await body(req);
        return json(
            await startVideo(
                ctx,
                { prompt: String(input.prompt ?? ''), model: input.model ? String(input.model) : undefined, aspectRatio: input.aspectRatio, duration: input.duration ? Number(input.duration) : undefined, reference: input.reference ? String(input.reference) : undefined },
                p
            ),
            201
        );
    });
    r.get('/ai/video/:id', async (_req, ctx, { id }) => (me(ctx), json(await videoStatus(ctx, id))));
    r.get('/ai/memory', async (_req, ctx) => (me(ctx), json(await listMemory(ctx.db))));
    r.post('/ai/memory', async (req, ctx) => {
        const p = me(ctx);
        return json(await addMemory(ctx.db, String((await body(req)).text ?? ''), p.name), 201);
    });
    r.delete('/ai/memory/:id', async (_req, ctx, { id }) => (atLeast(ctx.principal, 'editor'), json(await deleteMemory(ctx.db, id))));
    r.get('/ai/knowledge', async (_req, ctx) => (me(ctx), json(await knowledgeStats(ctx.db))));
    r.post('/ai/knowledge/refresh', async (_req, ctx) => {
        atLeast(ctx.principal, 'editor');
        const result = await refreshKnowledge(ctx);
        ctx.exec.waitUntil(embedPending(ctx.env, ctx.db, ctx.options.ai?.(ctx.env) ?? null, 25_000).catch(err => console.error('embedding failed', err)));
        return json(result);
    });
    r.get('/unfurl', async (_req, ctx) => (me(ctx), json(await unfurl(ctx.url.searchParams.get('url') ?? ''))));
    r.get('/ideas', async (_req, ctx) => (me(ctx), json(await listIdeas(ctx, ctx.url.searchParams.get('status') ?? 'new'))));
    /** When ideas refresh by themselves and what the last refresh did. */
    r.get('/ideas/status', async (_req, ctx) => (me(ctx), json(await ideaStatus(ctx))));
    /** Refreshes ideas now: new material since the last read, or the last two weeks when nothing is new. */
    r.post('/ideas/refresh', async (_req, ctx) => (atLeast(ctx.principal, 'editor'), json(await refreshIdeas(ctx, 'manual'))));
    r.post('/ideas', async (req, ctx) => {
        atLeast(ctx.principal, 'editor');
        const input = await body(req);
        return json(await addIdeas(ctx, Array.isArray(input.ideas) ? input.ideas : [input as any]), 201);
    });
    /** Writes the idea's draft (streamed on request, with an optional text model) and saves it; with markdown in the body, saves that text instead. */
    r.post('/ideas/:id/draft', async (req, ctx, { id }) => {
        const p = me(ctx);
        const input = await body(req);
        if (input.markdown !== undefined) return json(await saveIdeaDraft(ctx, id, p, { title: input.title, markdown: String(input.markdown) }), 201);
        const model = typeof input.model === 'string' ? input.model : undefined;
        return wantsEvents(req) ? draftIdeaStream(ctx, id, p, req.signal, model) : json(await draftIdea(ctx, id, p, model));
    });
    r.put('/ideas/:id', async (req, ctx, { id }) => {
        me(ctx);
        const { status } = await body(req);
        if (!['new', 'drafted', 'dismissed'].includes(status)) throw new HttpError(400, 'Unknown status.');
        await ctx.db.prepare('UPDATE ideas SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), id).run();
        return json({ ok: true });
    });

    // ---------------------------------------------------------- writing tools
    /** The house-style rules the editor checks as people write (Settings, Style checks). */
    r.get('/style', async (_req, ctx) => (me(ctx), json(await styleSettings(ctx.db))));
    /** Published posts to link from the paragraph being written, nearest in meaning first. */
    r.post('/ai/links', async (req, ctx) => {
        me(ctx);
        const input = await body(req);
        const ai = ctx.options.ai?.(ctx.env);
        if (!ai) throw new HttpError(501, 'No AI provider is configured. Set PREDEV_API_KEY.');
        const exclude = [input.postId, ...(Array.isArray(input.exclude) ? input.exclude : [])].filter((x): x is string => typeof x === 'string' && !!x);
        try {
            return json(await suggestLinks(ctx, ai, String(input.text ?? ''), exclude));
        } catch (err: any) {
            throw err instanceof HttpError ? err : new HttpError(502, `The AI provider said: ${err?.message ?? 'request failed'}`);
        }
    });
    /** Posts for X and LinkedIn and newsletter subject lines, to copy (streamed on request). Nothing is posted anywhere. */
    r.post('/posts/:id/share', async (req, ctx, { id }) => {
        const post = await getPost(ctx.db, id);
        if (!post) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, post);
        const input = await body(req);
        const args = { angle: typeof input.angle === 'string' ? input.angle : undefined, model: typeof input.model === 'string' ? input.model : undefined };
        return wantsEvents(req) ? shareStream(ctx, post, args, req.signal) : json(await share(ctx, post, args));
    });

    // ---------------------------------------------------------- import
    r.post('/import/content', async (req, ctx) => (atLeast(ctx.principal, 'owner'), json(await importContent(ctx, (await body(req)) as any))));
    r.post('/import/members', async (req, ctx) => (atLeast(ctx.principal, 'owner'), json(await importAudience(ctx, (await body(req)) as any))));
    r.post('/import/media', async (req, ctx) => (atLeast(ctx.principal, 'owner'), json(await importMedia(ctx, ((await body(req)) as any).items))));
    r.post('/import/rewrite', async (req, ctx) => {
        atLeast(ctx.principal, 'owner');
        const { from, to } = await body(req);
        return json(await rewriteUrls(ctx, String(from ?? ''), String(to ?? '')));
    });

    /** Counts that show an import is complete. */
    r.get('/stats', async (_req, ctx) => {
        me(ctx);
        const row = await ctx.db
            .prepare(
                `SELECT (SELECT COUNT(*) FROM posts WHERE type = 'post') AS posts,
                   (SELECT COUNT(*) FROM posts WHERE type = 'post' AND status = 'published') AS published,
                   (SELECT COUNT(*) FROM posts WHERE type = 'post' AND status = 'draft') AS drafts,
                   (SELECT COUNT(*) FROM posts WHERE type = 'page') AS pages,
                   (SELECT COUNT(*) FROM tags) AS tags, (SELECT COUNT(*) FROM staff) AS staff,
                   (SELECT COUNT(*) FROM media) AS media, (SELECT COUNT(*) FROM member_events) AS member_events,
                   (SELECT COUNT(*) FROM site_files) AS site_files`
            )
            .first();
        return json({ ...row, members: await memberStats(ctx.db) });
    });

    workflowRoutes(r, canEdit);
    return r;
}

export { renderBody, tagLinks };
