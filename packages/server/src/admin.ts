import type { AspectRatio, ModelKind, Post, StaffRole } from '@masthead/core';
import { buildSite, renderBody, tagLinks } from '@masthead/render';
import { addIdeas, draft, draftIdea, edit, image, listIdeas, listModels, meta } from './ai';
import { atLeast, clearSessionCookie, consumeLoginToken, createApiKey, createLoginToken, createSession, endSession, sessionCookie } from './auth';
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
import { addMember, deleteMember, getMember, listMembers, memberEvents, memberStats, restoreOptOuts, setStatus, type MemberStatus } from './members';
import { appUrl, buildEmail, cancelSend, countSegment, createSend, getSend, listSends, processSends, sendTest, testMode, unsubscribeUrl, type Segment } from './newsletter';
import { linkTag, publishSite } from './publish';
import { MEDIA_PREFIX } from './public';
import { Router } from './router';
import { HttpError, body, csvEscape, html, json, newId, now, parseCsv, redirect, safeEqual } from './util';

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

function republish(ctx: A) {
    ctx.exec.waitUntil(publishSite(ctx.env, ctx.db, ctx.options).catch(err => console.error('publish failed', err)));
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
            const mail = signInEmail(site, `${appUrl(ctx.env)}admin/api/auth/verify?token=${login.token}`, false);
            ctx.exec.waitUntil(transport.send([{ to: login.staff.email, from: ctx.env.EMAIL_FROM, subject: mail.subject, html: mail.html, text: mail.text, idempotencyKey: `login:${login.token.slice(0, 16)}` }]));
        }
        // Same answer whether or not the address belongs to staff.
        return json({ ok: true });
    });

    r.get('/auth/verify', async (req, ctx) => {
        const staffId = await consumeLoginToken(ctx.db, ctx.url.searchParams.get('token') ?? '');
        if (!staffId) return html('<p style="font-family:system-ui;padding:40px">This sign-in link has expired or was already used. <a href="../../">Request a new one</a>.</p>', 400);
        const token = await createSession(ctx.db, staffId);
        return redirect(`${ctx.basePath}admin/`, 302, { 'set-cookie': sessionCookie(token) });
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
        return json(
            await listPosts(ctx.db, {
                type: (s.get('type') as 'post' | 'page') || undefined,
                status: s.get('status') || undefined,
                q: s.get('q') || undefined,
                authorId: own ? p.staffId : undefined,
                limit: Number(s.get('limit') ?? 50),
                offset: Number(s.get('offset') ?? 0)
            })
        );
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
        const post = await savePost(ctx.db, { ...input, id });
        if (post.status === 'published') republish(ctx);
        return json(post);
    });

    r.post('/posts/:id/publish', async (req, ctx, { id }) => {
        const existing = await getPost(ctx.db, id);
        if (!existing) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, existing, true);
        if (!existing.title.trim()) throw new HttpError(400, 'Add a title before publishing.');
        const { publishedAt } = await body(req);
        const when = publishedAt ? new Date(publishedAt) : existing.publishedAt && existing.status === 'published' ? new Date(existing.publishedAt) : new Date();
        if (Number.isNaN(when.getTime())) throw new HttpError(400, 'publishedAt is not a valid date.');
        const status = when.getTime() > Date.now() + 60_000 ? 'scheduled' : 'published';
        const post = await savePost(ctx.db, { id, status, publishedAt: when.toISOString() });
        const result = status === 'published' ? await publishSite(ctx.env, ctx.db, ctx.options) : null;
        return json({ post, publish: result });
    });

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
        if (existing.status !== 'draft') republish(ctx);
        return json({ ok: true });
    });

    /** The post as readers would see it, rendered from the current saved state. */
    r.get('/posts/:id/preview', async (_req, ctx, { id }) => {
        const post = await getPost(ctx.db, id);
        if (!post) throw new HttpError(404, 'Post not found.');
        await canEdit(ctx, post);
        const snap = await loadSnapshot(ctx.env, ctx.db);
        const previewPost: Post = { ...post, status: 'published', publishedAt: post.publishedAt ?? now() };
        snap.posts = [...snap.posts.filter(p => p.id !== id), previewPost];
        const built = await buildSite(snap, { theme: ctx.options.theme, render: { linkTag: linkTag(ctx.env) }, features: { subscribeUrl: `${ctx.basePath}api/subscribe` } });
        const file = built.files.find(f => f.path === `${ctx.basePath.slice(1)}${post.slug}/index.html`);
        if (!file) throw new HttpError(500, 'Preview failed to render.');
        return html(String(file.contents).replace('<head>', '<head><meta name="robots" content="noindex">'));
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
            const mail = signInEmail(site, `${appUrl(ctx.env)}admin/api/auth/verify?token=${login.token}`, true);
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
        return json({ count: await countSegment(ctx.db, (ctx.url.searchParams.get('segment') as Segment) || 'all') });
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
        await ctx.env.BUCKET.put(`${MEDIA_PREFIX}${rel}`, await f.arrayBuffer(), { httpMetadata: { contentType: f.type || 'application/octet-stream' } });
        await ctx.db.prepare('INSERT INTO media (key, content_type, size, source_url, created_at) VALUES (?, ?, ?, ?, ?)').bind(rel, f.type, f.size, 'upload', now()).run();
        return json({ url: `${ctx.basePath}${rel}` }, 201);
    });

    // ---------------------------------------------------------- settings
    r.get('/settings', async (_req, ctx) => {
        atLeast(ctx.principal, 'admin');
        const [site, newsletter, ai] = await Promise.all([siteSettings(ctx.env, ctx.db), newsletterSettings(ctx.env, ctx.db), aiSettings(ctx.env, ctx.db)]);
        const { results: keys } = await ctx.db.prepare('SELECT id, name, prefix, role, created_at, last_used_at FROM api_keys ORDER BY created_at DESC').all();
        return json({
            site,
            newsletter,
            ai,
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
        if (input.ai) await setSetting(ctx.db, 'ai', { ...(await getSetting(ctx.db, 'ai', {})), ...input.ai });
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

    // ---------------------------------------------------------- AI studio
    r.get('/ai/models', async (_req, ctx) => (me(ctx), json(await listModels(ctx, (ctx.url.searchParams.get('kind') as ModelKind) || undefined))));
    r.post('/ai/draft', async (req, ctx) => (me(ctx), json(await draft(ctx, (await body(req)) as any))));
    r.post('/ai/edit', async (req, ctx) => (me(ctx), json(await edit(ctx, (await body(req)) as any))));
    r.post('/ai/meta', async (req, ctx) => (me(ctx), json(await meta(ctx, (await body(req)) as any))));
    r.post('/ai/image', async (req, ctx) => {
        me(ctx);
        const input = await body(req);
        return json(await image(ctx, { prompt: String(input.prompt ?? ''), aspectRatio: input.aspectRatio as AspectRatio }));
    });
    r.get('/ideas', async (_req, ctx) => (me(ctx), json(await listIdeas(ctx, ctx.url.searchParams.get('status') ?? 'new'))));
    r.post('/ideas', async (req, ctx) => {
        atLeast(ctx.principal, 'editor');
        const input = await body(req);
        return json(await addIdeas(ctx, Array.isArray(input.ideas) ? input.ideas : [input as any]), 201);
    });
    r.post('/ideas/:id/draft', async (_req, ctx, { id }) => json(await draftIdea(ctx, id, me(ctx))));
    r.put('/ideas/:id', async (req, ctx, { id }) => {
        me(ctx);
        const { status } = await body(req);
        if (!['new', 'drafted', 'dismissed'].includes(status)) throw new HttpError(400, 'Unknown status.');
        await ctx.db.prepare('UPDATE ideas SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), id).run();
        return json({ ok: true });
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

    return r;
}

export { renderBody, tagLinks };
