import { siteSettings } from './content';
import { migrate } from './db';
import { confirmEmail, page } from './email';
import type { Ctx } from './env';
import { checkMemberToken, getMember, getMemberByExternalUuid, memberToken, requestSubscription, setStatus } from './members';
import { appUrl, recordEmailEvents, testAddress, testMode } from './newsletter';
import { SITE_PREFIX, edgeCache, edgeKey } from './publish';
import { Router } from './router';
import { HttpError, body, escapeHtml as esc, html, json, redirect } from './util';

export const MEDIA_PREFIX = 'media/';

const SECURITY_HEADERS = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin'
};

/** Only the canonical host is indexable; previews and workers.dev answer with noindex. */
function robots(ctx: Ctx): Record<string, string> {
    return ctx.url.host === new URL(ctx.env.SITE_URL).host ? {} : { 'x-robots-tag': 'noindex, nofollow' };
}

export async function serveSite(req: Request, ctx: Ctx): Promise<Response> {
    const base = ctx.basePath;
    let path = decodeURIComponent(ctx.url.pathname);
    if (path === base.replace(/\/$/, '')) return redirect(base, 301);
    if (path === `${base}rss`) return redirect(`${base}rss/`, 301);
    if (path === `${base}page/1/`) return redirect(base, 301);

    let key: string;
    if (path === `${base}rss/`) key = `${base}rss/index.xml`;
    else if (path.endsWith('/')) key = `${path}index.html`;
    else if (/\.[a-z0-9]+$/i.test(path)) key = path;
    else {
        // No trailing slash: redirect when the directory version exists, the way Ghost does.
        const dir = await ctx.env.BUCKET.head(`${SITE_PREFIX}${path.slice(1)}/index.html`);
        if (dir) return redirect(`${path}/${ctx.url.search}`, 301);
        key = path;
    }
    key = key.replace(/^\/+/, '');

    // Served from the edge cache when possible: fresh for a minute, then refreshed in the background.
    const canonical = !robots(ctx)['x-robots-tag'];
    const cache = edgeCache();
    if (cache && req.method === 'GET') {
        const hit = await cache.match(edgeKey(key, canonical));
        const age = hit ? Date.now() - Number(hit.headers.get(CACHED_AT) ?? 0) : Infinity;
        if (hit && age < EDGE_MAX_STALE_MS) {
            if (age > EDGE_FRESH_MS) ctx.exec.waitUntil(fromStorage(ctx, key, canonical, null).catch(() => {}));
            return notModified(req, hit.headers) ?? toBrowser(hit);
        }
    }
    return fromStorage(ctx, key, canonical, req);
}

const EDGE_FRESH_MS = 60_000;
const EDGE_MAX_STALE_MS = 3_600_000;
const CACHED_AT = 'x-masthead-cached-at';
const BROWSER_CC = 'x-masthead-cache-control';

/** Reads a site file from storage, answers the reader (when there is one) and refreshes the edge copy. */
async function fromStorage(ctx: Ctx, key: string, canonical: boolean, req: Request | null): Promise<Response> {
    // Revalidation: weak ETags survive Cloudflare's compression, and Last-Modified
    // covers HTML, whose ETag Cloudflare drops when it may rewrite the page.
    const cached = req?.headers.get('if-none-match')?.split(',')[0]?.trim().replace(/^W\//, '').replace(/"/g, '');
    const since = !cached && req?.headers.get('if-modified-since') ? new Date(req.headers.get('if-modified-since')!) : null;
    // HTTP dates have whole seconds; R2 upload times have milliseconds.
    const onlyIf = cached ? { etagDoesNotMatch: cached } : since && !Number.isNaN(since.getTime()) ? { uploadedAfter: new Date(since.getTime() + 999) } : undefined;
    const obj = await ctx.env.BUCKET.get(`${SITE_PREFIX}${key}`, onlyIf ? { onlyIf } : undefined);
    const cache = edgeCache();
    if (obj === null) {
        if (cache) ctx.exec.waitUntil(cache.delete(edgeKey(key, canonical)));
        const missing = await ctx.env.BUCKET.get(`${SITE_PREFIX}${ctx.basePath.slice(1)}404.html`);
        return new Response(missing?.body ?? 'Not found', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...robots(ctx) } });
    }
    const headers = new Headers({ ...SECURITY_HEADERS, ...robots(ctx) });
    obj.writeHttpMetadata(headers);
    headers.set('etag', `W/${obj.httpEtag}`);
    headers.set('last-modified', obj.uploaded.toUTCString());
    const isHtml = (headers.get('content-type') ?? '').startsWith('text/html');
    headers.set('cache-control', isHtml || key.endsWith('.xml') || key.endsWith('.txt') ? 'public, max-age=0, must-revalidate' : 'public, max-age=300');
    if (!('body' in obj)) return new Response(null, { status: 304, headers });

    let body: ReadableStream | null = obj.body;
    if (cache && (!req || req.method === 'GET')) {
        const [forReader, forCache] = req ? obj.body.tee() : [null, obj.body];
        const stored = new Response(forCache, { headers });
        stored.headers.set(BROWSER_CC, headers.get('cache-control')!);
        stored.headers.set('cache-control', 'public, max-age=86400');
        stored.headers.set(CACHED_AT, String(Date.now()));
        const put = cache.put(edgeKey(key, canonical), stored);
        if (!req) {
            await put;
            return new Response(null, { status: 204 });
        }
        ctx.exec.waitUntil(put);
        body = forReader;
    }
    return new Response(req?.method === 'HEAD' ? null : body, { headers });
}

function toBrowser(hit: Response): Response {
    const res = new Response(hit.body, hit);
    res.headers.set('cache-control', hit.headers.get(BROWSER_CC) ?? 'public, max-age=0, must-revalidate');
    res.headers.delete(BROWSER_CC);
    res.headers.delete(CACHED_AT);
    return res;
}

/** A 304 when the reader's copy matches the cached one. */
function notModified(req: Request, cached: Headers): Response | null {
    const inm = req.headers.get('if-none-match');
    const ims = req.headers.get('if-modified-since');
    const etag = (cached.get('etag') ?? '').replace(/^W\//, '');
    const hit = inm ? inm.split(',').some(t => t.trim().replace(/^W\//, '') === etag) : ims ? new Date(ims).getTime() >= new Date(cached.get('last-modified') ?? 0).getTime() - 999 : false;
    if (!hit) return null;
    const headers = new Headers(cached);
    headers.set('cache-control', cached.get(BROWSER_CC) ?? 'public, max-age=0, must-revalidate');
    headers.delete(BROWSER_CC);
    headers.delete(CACHED_AT);
    return new Response(null, { status: 304, headers });
}

export async function serveMedia(req: Request, ctx: Ctx): Promise<Response> {
    let rel: string;
    try {
        rel = decodeURIComponent(ctx.url.pathname).slice(ctx.basePath.length);
    } catch {
        return new Response('Not found', { status: 404 });
    }
    const obj = await ctx.env.BUCKET.get(`${MEDIA_PREFIX}${rel}`, { onlyIf: req.headers, range: req.headers });
    if (obj === null) return new Response('Not found', { status: 404 });
    const headers = new Headers(SECURITY_HEADERS);
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    headers.set('accept-ranges', 'bytes');
    if (!('body' in obj)) return new Response(null, { status: 304, headers });
    if (req.headers.has('range') && obj.range && 'offset' in obj.range) {
        const start = obj.range.offset ?? 0;
        const end = start + (obj.range.length ?? obj.size) - 1;
        headers.set('content-range', `bytes ${start}-${end}/${obj.size}`);
        headers.set('content-length', String(end - start + 1));
        return new Response(obj.body, { status: 206, headers });
    }
    return new Response(req.method === 'HEAD' ? null : obj.body, { headers });
}

function wantsHtml(req: Request): boolean {
    return (req.headers.get('accept') ?? '').includes('text/html') || (req.headers.get('content-type') ?? '').includes('form');
}

async function resultPage(ctx: Ctx, title: string, bodyHtml: string, status = 200): Promise<Response> {
    const site = await siteSettings(ctx.env, ctx.db);
    return html(page(site, `${ctx.basePath}assets/masthead.css`, title, bodyHtml), status, { ...SECURITY_HEADERS, 'x-robots-tag': 'noindex' });
}

export function publicRoutes(): Router<Ctx> {
    const r = new Router<Ctx>();

    r.post('/api/subscribe', async (req, ctx) => {
        const data = await body(req);
        // Bots fill every field, people never see this one.
        if (data.company) return wantsHtml(req) ? resultPage(ctx, 'Check your email', '<p class="dek">We sent you a link to confirm.</p>') : json({ ok: true });
        const { member, needsConfirmation } = await requestSubscription(ctx.db, String(data.email ?? ''), data.name ? String(data.name) : null);
        let confirmUrl: string | undefined;
        if (needsConfirmation) {
            confirmUrl = `${appUrl(ctx.env)}api/confirm?m=${member.id}&t=${await memberToken(ctx.env.SECRET, 'confirm', member.id)}`;
            const transport = ctx.options.email?.(ctx.env);
            if (transport && ctx.env.EMAIL_FROM) {
                const site = await siteSettings(ctx.env, ctx.db);
                const mail = confirmEmail(site, confirmUrl);
                ctx.exec.waitUntil(
                    transport.send([
                        {
                            to: testMode(ctx.env) ? testAddress(ctx.env) : member.email,
                            from: ctx.env.EMAIL_FROM,
                            subject: mail.subject,
                            html: mail.html,
                            text: mail.text,
                            idempotencyKey: `confirm:${member.id}:${Math.floor(Date.now() / 60_000)}`
                        }
                    ])
                );
            }
        }
        if (wantsHtml(req)) {
            return needsConfirmation
                ? resultPage(ctx, 'Check your email', '<p class="dek">We sent you a link to confirm your subscription.</p>')
                : resultPage(ctx, "You're already subscribed", `<p class="dek">You'll keep getting new posts. <a href="${esc(ctx.basePath)}">Back to the blog</a></p>`);
        }
        // In test mode the link is returned so automated checks can confirm without an inbox.
        return json({ ok: true, status: needsConfirmation ? 'pending' : 'subscribed', ...(testMode(ctx.env) && confirmUrl ? { confirmUrl } : {}) });
    });

    r.get('/api/confirm', async (req, ctx) => {
        const m = ctx.url.searchParams.get('m') ?? '';
        const t = ctx.url.searchParams.get('t') ?? '';
        const member = m ? await getMember(ctx.db, m) : null;
        if (!member || !(await checkMemberToken(ctx.env.SECRET, 'confirm', member.id, t))) return resultPage(ctx, 'This link is not valid', '<p class="dek">Try subscribing again.</p>', 400);
        if (member.status !== 'subscribed') await setStatus(ctx.db, member, 'subscribed', 'member');
        return resultPage(ctx, "You're subscribed", `<p class="dek">New posts will arrive by email. <a href="${esc(ctx.basePath)}">Read the latest</a></p>`);
    });

    const unsubscribePage = async (ctx: Ctx, memberId: string, token: string) =>
        resultPage(
            ctx,
            'Unsubscribe',
            `<p class="dek">Stop getting new posts by email?</p>
<form method="post" action="${esc(`${ctx.basePath}api/unsubscribe?m=${memberId}&t=${token}`)}" class="subscribe-form" style="margin-top:20px"><button type="submit">Unsubscribe</button></form>`
        );

    r.get('/api/unsubscribe', async (req, ctx) => {
        const m = ctx.url.searchParams.get('m') ?? '';
        const t = ctx.url.searchParams.get('t') ?? '';
        const member = m ? await getMember(ctx.db, m) : null;
        if (!member || !(await checkMemberToken(ctx.env.SECRET, 'unsubscribe', member.id, t))) return resultPage(ctx, 'This link is not valid', '<p class="dek">It may be incomplete. Try the link in a newer email.</p>', 400);
        if (member.status === 'unsubscribed') return resultPage(ctx, "You're unsubscribed", '<p class="dek">You won\'t get any more emails.</p>');
        return unsubscribePage(ctx, member.id, t);
    });

    // Handles both the confirmation button and one-click unsubscribe from mail clients (RFC 8058).
    r.post('/api/unsubscribe', async (req, ctx) => {
        const m = ctx.url.searchParams.get('m') ?? '';
        const t = ctx.url.searchParams.get('t') ?? '';
        const member = m ? await getMember(ctx.db, m) : null;
        if (!member || !(await checkMemberToken(ctx.env.SECRET, 'unsubscribe', member.id, t))) throw new HttpError(400, 'This unsubscribe link is not valid.');
        await setStatus(ctx.db, member, 'unsubscribed', 'member');
        if (!wantsHtml(req)) return new Response('Unsubscribed', { status: 200 });
        return resultPage(ctx, "You're unsubscribed", '<p class="dek">You won\'t get any more emails.</p>');
    });

    r.post('/api/webhooks/email', async (req, ctx) => {
        const transport = ctx.options.email?.(ctx.env);
        if (!transport?.events) return json({ ok: false, error: 'No email provider is configured.' }, 404);
        if (!ctx.env.RESEND_WEBHOOK_SECRET) return json({ ok: false, error: 'Set RESEND_WEBHOOK_SECRET to accept webhooks.' }, 403);
        try {
            const events = await transport.events(req);
            return json({ ok: true, recorded: await recordEmailEvents(ctx.db, events) });
        } catch (err: any) {
            return json({ ok: false, error: err?.message ?? 'Rejected' }, err?.status ?? 400);
        }
    });

    return r;
}

/** Old Ghost links in past newsletters. */
export async function legacyRoute(req: Request, ctx: Ctx): Promise<Response | null> {
    const base = ctx.basePath;
    const path = ctx.url.pathname;
    if (path === `${base}unsubscribe/` || path === `${base}unsubscribe`) {
        await migrate(ctx.db);
        const uuid = ctx.url.searchParams.get('uuid') ?? '';
        const member = uuid ? await getMemberByExternalUuid(ctx.db, uuid) : null;
        if (!member) return resultPage(ctx, 'This link is not valid', '<p class="dek">It may be from an old email.</p>', 404);
        const token = await memberToken(ctx.env.SECRET, 'unsubscribe', member.id);
        return redirect(`${base}api/unsubscribe?m=${member.id}&t=${token}`, 302);
    }
    if (path.startsWith(`${base}r/`)) return redirect(base, 302);
    if (path.startsWith(`${base}ghost/`) || path.startsWith(`${base}members/`)) return new Response('Gone', { status: 410 });
    return null;
}
