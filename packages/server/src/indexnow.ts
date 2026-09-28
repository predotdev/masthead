/**
 * IndexNow: after a publish, tells Bing, Yandex, Seznam, Naver and the other
 * participating engines which pages changed, so they recrawl in minutes
 * instead of days. Off until INDEXNOW=true (turn it on once SITE_URL serves
 * this blog). The key file is served at <base><key>.txt.
 */
import { getSetting, setSetting } from './content';
import type { Env } from './env';

export async function indexNowKey(env: Env, db: D1Database): Promise<string> {
    if (env.INDEXNOW_KEY && /^[0-9a-f]{32}$/.test(env.INDEXNOW_KEY)) return env.INDEXNOW_KEY;
    const stored = await getSetting<string | null>(db, 'indexnow_key', null);
    if (stored) return stored;
    const key = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    await setSetting(db, 'indexnow_key', key);
    return key;
}

/** Submits changed pages (site file paths like "blog/my-post/index.html"). Never throws. */
export async function notifyIndexNow(env: Env, db: D1Database, changedPaths: string[]): Promise<number> {
    if (env.INDEXNOW !== 'true') return 0;
    const site = new URL(env.SITE_URL.endsWith('/') ? env.SITE_URL : `${env.SITE_URL}/`);
    const urls = [...new Set(changedPaths.filter(p => p.endsWith('index.html') && !p.includes('/_masthead/')).map(p => new URL(`/${p.slice(0, -'index.html'.length)}`, site.origin).toString()))].slice(0, 10_000);
    if (!urls.length) return 0;
    try {
        const key = await indexNowKey(env, db);
        const res = await fetch('https://api.indexnow.org/indexnow', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ host: site.host, key, keyLocation: new URL(`${site.pathname}${key}.txt`, site.origin).toString(), urlList: urls }),
            signal: AbortSignal.timeout(10_000)
        });
        if (!res.ok && res.status !== 202) console.warn(`IndexNow answered ${res.status}`);
        return urls.length;
    } catch (err: any) {
        console.warn(`IndexNow: ${err?.message ?? err}`);
        return 0;
    }
}
