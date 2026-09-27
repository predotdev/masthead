export type Params = Record<string, string>;
export type Handler<C> = (req: Request, ctx: C, params: Params) => Promise<Response> | Response;

interface Route<C> {
    method: string;
    re: RegExp;
    keys: string[];
    handler: Handler<C>;
}

/** Method + path routing with :params and a trailing * wildcard (captured as params.rest). */
export class Router<C> {
    private routes: Route<C>[] = [];

    on(method: string, pattern: string, handler: Handler<C>): this {
        const keys: string[] = [];
        const source = pattern
            .split('/')
            .map(seg => {
                if (seg === '*') {
                    keys.push('rest');
                    return '(.*)';
                }
                if (seg.startsWith(':')) {
                    keys.push(seg.slice(1));
                    return '([^/]+)';
                }
                return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            })
            .join('/');
        this.routes.push({ method, re: new RegExp(`^${source}$`), keys, handler });
        return this;
    }

    get(p: string, h: Handler<C>) {
        return this.on('GET', p, h);
    }
    post(p: string, h: Handler<C>) {
        return this.on('POST', p, h);
    }
    put(p: string, h: Handler<C>) {
        return this.on('PUT', p, h);
    }
    delete(p: string, h: Handler<C>) {
        return this.on('DELETE', p, h);
    }

    match(method: string, path: string): { handler: Handler<C>; params: Params } | null {
        for (const r of this.routes) {
            if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
            const m = r.re.exec(path);
            if (!m) continue;
            const params: Params = {};
            r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
            return { handler: r.handler, params };
        }
        return null;
    }
}
