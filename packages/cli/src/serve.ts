import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Route {
    from: string;
    to: string;
    status: number;
}

/** A local preview server that applies the build's routes.json the way a production host would. */
export async function serve(opts: { dir: string; port: number }) {
    const root = resolve(opts.dir);
    const routes: Route[] = [];
    for (const file of new Bun.Glob('**/_masthead/routes.json').scanSync(root)) {
        routes.push(...(JSON.parse(readFileSync(join(root, file), 'utf8')) as Route[]));
    }
    const notFound = [...new Bun.Glob('**/404.html').scanSync(root)][0];

    const server = Bun.serve({
        port: opts.port,
        fetch(req) {
            const url = new URL(req.url);
            let path = decodeURIComponent(url.pathname);
            const route = routes.find(r => r.from === path);
            if (route && route.status !== 200) return Response.redirect(new URL(route.to, url), route.status);
            if (route) path = route.to;
            if (path.endsWith('/')) path += 'index.html';
            else if (!/\.[a-z0-9]+$/i.test(path) && existsSync(join(root, path, 'index.html'))) return Response.redirect(new URL(`${path}/`, url), 301);
            const file = resolve(root, `.${path}`);
            if (file.startsWith(root) && existsSync(file)) return new Response(Bun.file(file));
            return new Response(notFound ? Bun.file(join(root, notFound)) : 'Not found', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
    });
    console.log(`Serving ${root} at http://localhost:${server.port}`);
}
