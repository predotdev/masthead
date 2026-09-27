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
import { processSends } from './newsletter';
import { legacyRoute, publicRoutes, serveMedia, serveSite } from './public';
import { basePath, publishSite, releaseScheduled } from './publish';
import { HttpError, json } from './util';

export type { AppOptions, Env } from './env';
export { publishSite } from './publish';

export function createApp(options: AppOptions) {
    const admin = adminRoutes();
    const pub = publicRoutes();

    async function handle(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
        const url = new URL(req.url);
        const base = basePath(env);
        const ctx: Ctx = { env, db: env.DB, exec, options, url, basePath: base };
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
        const legacy = await legacyRoute(req, ctx);
        if (legacy) return legacy;
        return serveSite(req, ctx);
    }

    return {
        async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
            try {
                return await handle(req, env, exec);
            } catch (err) {
                console.error(err);
                return errorResponse(err);
            }
        },

        /** Every minute: publish scheduled posts, then work through newsletter batches. */
        async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
            await migrate(env.DB);
            if (await releaseScheduled(env.DB)) await publishSite(env, env.DB, options);
            exec.waitUntil(processSends(env, env.DB, options, 50_000));
        }
    };
}

async function serveAdmin(req: Request, env: Env, url: URL, base: string): Promise<Response> {
    if (!env.ASSETS) return new Response('The admin app is not deployed with this Worker.', { status: 404 });
    let rest = url.pathname.slice(`${base}admin`.length) || '/';
    if (rest === '/' || !/\.[a-z0-9]+$/i.test(rest)) rest = '/index.html';
    const res = await env.ASSETS.fetch(new Request(new URL(`/admin${rest}`, url.origin), req));
    const out = new Response(res.body, res);
    out.headers.set('x-robots-tag', 'noindex, nofollow');
    out.headers.set('cache-control', rest === '/index.html' || !res.ok ? 'no-store' : 'public, max-age=31536000, immutable');
    return out;
}

function errorResponse(err: unknown): Response {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Something went wrong on the server.' }, 500);
}
