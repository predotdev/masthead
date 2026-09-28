/**
 * The Masthead server for Cloudflare Workers.
 *
 * Everything lives under the blog's path (e.g. /blog/), so putting it behind
 * an existing site is one route:
 *   <base>             the published site, from R2
 *   <base>content/*    images and media, from R2
 *   <base>api/*        signup, confirmation, unsubscribe, webhooks
 *   <base>admin/       the admin app
 *   <base>admin/api/*  the admin API (session cookie or bearer token)
 */
import { adminRoutes } from './admin';
import { checkCsrf, principal } from './auth';
import { migrate } from './db';
import type { AppOptions, Ctx, Env } from './env';
import { appUrl, processSends } from './newsletter';
import { legacyRoute, publicRoutes, serveMedia, serveSearch, serveSite } from './public';
import { basePath, publishSite, publishUnfinished, releaseScheduled } from './publish';
import { embedPending, refreshKnowledge, relatedChanged } from './knowledge';
import { IDEAS_MINUTE, scheduledIdeas } from './ideas';
import { HttpError, json, redirect } from './util';

export type { AppOptions, Env } from './env';
export { publishSite } from './publish';

export function createApp(options: AppOptions) {
    const admin = adminRoutes();
    const pub = publicRoutes();

    async function handle(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
        const url = new URL(req.url);
        const base = basePath(env);
        const siteHost = new URL(env.SITE_URL).host;
        const forwarded = (req.headers.get('x-forwarded-host') ?? '').split(',')[0].trim();
        const ctx: Ctx = { env, db: env.DB, exec, options, url, basePath: base, canonical: url.host === siteHost || forwarded === siteHost };
        const path = url.pathname;

        if (base !== '/' && (path === '/' || path === '')) return Response.redirect(new URL(base, url).toString(), 302);
        if (!path.startsWith(base) && `${path}/` !== base) return new Response('Not found', { status: 404 });

        // Readers never touch the database: the site and media come straight from storage.
        if (path.startsWith(`${base}admin/api/`)) {
            await migrate(env.DB);
            try {
                checkCsrf(req);
                const sub = path.slice(`${base}admin/api`.length);
                const found = admin.match(req.method, sub);
                if (!found) return json({ error: 'Not found.' }, 404);
                const withUser = { ...ctx, principal: await principal(req, env, env.DB) };
                return await found.handler(req, withUser, found.params);
            } catch (err) {
                return errorResponse(err);
            }
        }

        if (path === `${base}admin` || path.startsWith(`${base}admin/`)) return serveAdmin(req, env, url, base);

        if (path.startsWith(`${base}api/`)) {
            await migrate(env.DB);
            try {
                const found = pub.match(req.method, path.slice(base.length - 1));
                if (!found) return json({ error: 'Not found.' }, 404);
                return await found.handler(req, ctx, found.params);
            } catch (err) {
                return errorResponse(err);
            }
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
        if (path.startsWith(`${base}content/`)) return serveMedia(req, ctx);
        if (path === `${base}search/` || path === `${base}search`) return serveSearch(req, ctx);
        const legacy = await legacyRoute(req, ctx);
        if (legacy) return legacy;
        return serveSite(req, ctx);
    }

    /**
     * The site at a second address (PREVIEW_PATH, e.g. /blog-new/) while an old blog still has
     * the main one: requests are answered as if made to the main path, links in the answer point
     * back at the preview, canonical URLs keep naming the main address, and it is not indexed.
     */
    async function preview(req: Request, env: Env, exec: ExecutionContext, at: string): Promise<Response> {
        const url = new URL(req.url);
        if (url.pathname === at.slice(0, -1)) return redirect(`${at}${url.search}`, 308);
        // Staff sessions belong to the main address: the admin stays there.
        if (url.pathname.startsWith(`${at}admin`)) return redirect(`${appUrl(env)}admin/`, 302);
        const base = basePath(env);
        const inner = new URL(url);
        inner.pathname = base + url.pathname.slice(at.length);
        const res = await handle(new Request(inner.toString(), req), env, exec);
        // The search index lists page addresses for the search box: those move too.
        if (inner.pathname === `${base}search.json` && res.ok) {
            const origin = new URL(env.SITE_URL).origin;
            const text = (await res.text()).replaceAll(`"${base}`, `"${at}`).replaceAll(`${origin}${base}`, `${origin}${at}`);
            const headers = new Headers(res.headers);
            headers.set('x-robots-tag', 'noindex, nofollow');
            return new Response(text, { status: res.status, headers });
        }
        return toPreview(res, env, base, at);
    }

    return {
        async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
            try {
                const at = previewPath(env);
                if (at && `${new URL(req.url).pathname}/`.startsWith(at)) return await preview(req, env, exec, at);
                return await handle(req, env, exec);
            } catch (err) {
                console.error(err);
                return errorResponse(err);
            }
        },

        /** Every minute: publish scheduled posts, then work through newsletter batches. */
        async scheduled(event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
            await migrate(env.DB);
            // Related posts found after the last publish (a new post's embeddings land a little later) rebuild the site too.
            if ((await releaseScheduled(env.DB)) || (await publishUnfinished(env.DB)) || (await relatedChanged(env.DB))) await publishSite(env, env.DB, options);
            exec.waitUntil(processSends(env, env.DB, options, 50_000));
            // The writing assistant's knowledge: embed what is queued; re-read every source once a day.
            const ai = options.ai?.(env) ?? null;
            const at = new Date(event.scheduledTime);
            if (ai && at.getUTCHours() === 3 && at.getUTCMinutes() === 17) {
                const base = basePath(env);
                const ctx: Ctx = { env, db: env.DB, exec, options, url: new URL(env.SITE_URL), basePath: base };
                exec.waitUntil(refreshKnowledge(ctx).catch(err => console.error('knowledge refresh failed', err)));
            } else if (ai) exec.waitUntil(embedPending(env, env.DB, ai, 25_000).catch(err => console.error('embedding failed', err)));
            // Post ideas: once an hour, check whether the daily refresh (Settings, Ideas) is due.
            if (ai && at.getUTCMinutes() === IDEAS_MINUTE) {
                const ctx: Ctx = { env, db: env.DB, exec, options, url: new URL(env.SITE_URL), basePath: basePath(env) };
                exec.waitUntil(scheduledIdeas(ctx, at).catch(err => console.error('idea refresh failed', err)));
            }
        }
    };
}

async function serveAdmin(req: Request, env: Env, url: URL, base: string): Promise<Response> {
    if (!env.ASSETS) return new Response('The admin app is not deployed with this Worker.', { status: 404 });
    // The app loads its files relative to <base>admin/: without the slash none of them load and the page stays blank.
    if (url.pathname === `${base}admin`) return redirect(`${base}admin/${url.search}`, 308);
    let rest = url.pathname.slice(`${base}admin`.length) || '/';
    if (rest === '/' || !/\.[a-z0-9]+$/i.test(rest)) rest = '/index.html';
    const res = await env.ASSETS.fetch(new Request(new URL(`/admin${rest}`, url.origin), req));
    const out = new Response(res.body, res);
    out.headers.set('x-robots-tag', 'noindex, nofollow');
    out.headers.set('cache-control', rest === '/index.html' || !res.ok ? 'no-store' : 'public, max-age=31536000, immutable');
    return out;
}

function previewPath(env: Env): string | null {
    const p = (env.PREVIEW_PATH ?? '').trim();
    if (!p || p === '/') return null;
    return `/${p.replace(/^\/+|\/+$/g, '')}/`;
}

/** A main-path answer, pointed at the preview address (see preview() in createApp). */
function toPreview(res: Response, env: Env, base: string, at: string): Response {
    const origin = new URL(env.SITE_URL).origin;
    // Pages and assets move to the preview; `assetsOnly` moves just files (images, media), for places
    // that must keep naming the canonical page.
    const move = (v: string, assetsOnly = false): string => {
        const rel = v.startsWith(base) ? v.slice(base.length) : v.startsWith(origin + base) ? v.slice((origin + base).length) : null;
        if (rel === null || (assetsOnly && !rel.startsWith('content/'))) return v;
        return (v.startsWith(base) ? '' : origin) + at + rel;
    };
    const headers = new Headers(res.headers);
    const location = headers.get('location');
    if (location) headers.set('location', move(location));
    headers.set('x-robots-tag', 'noindex, nofollow');
    const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    if (!(headers.get('content-type') ?? '').startsWith('text/html')) return out;
    const attr = (name: string, assetsOnly = false): HTMLRewriterElementContentHandlers => ({
        element(el) {
            const v = el.getAttribute(name);
            if (v) el.setAttribute(name, move(v, assetsOnly));
        }
    });
    const srcset: HTMLRewriterElementContentHandlers = {
        element(el) {
            const v = el.getAttribute('srcset');
            if (v) el.setAttribute('srcset', v.split(',').map(part => part.trim().split(/\s+/).map((w, i) => (i ? w : move(w))).join(' ')).join(', '));
        }
    };
    let ld = '';
    return new HTMLRewriter()
        .on('a[href]', attr('href'))
        .on('link[href]:not([rel="canonical"])', attr('href'))
        .on('script[src]', attr('src'))
        .on('img[src]', attr('src'))
        .on('img[srcset]', srcset)
        .on('source[src]', attr('src'))
        .on('source[srcset]', srcset)
        .on('video[src]', attr('src'))
        .on('video[poster]', attr('poster'))
        .on('audio[src]', attr('src'))
        .on('form[action]', attr('action'))
        .on('meta[property="og:image"]', attr('content', true))
        .on('meta[name="twitter:image"]', attr('content', true))
        .on('html', {
            element(el) {
                for (const name of ['data-base', 'data-search-index']) {
                    const v = el.getAttribute(name);
                    if (v) el.setAttribute(name, move(v));
                }
            }
        })
        // Structured data keeps canonical page URLs; only its image and file URLs move.
        .on('script[type="application/ld+json"]', {
            text(t) {
                ld += t.text;
                if (!t.lastInTextNode) {
                    t.remove();
                    return;
                }
                t.replace(ld.replaceAll(`${origin}${base}content/`, `${origin}${at}content/`), { html: true });
                ld = '';
            }
        })
        .transform(out);
}

function errorResponse(err: unknown): Response {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Something went wrong on the server.' }, 500);
}
