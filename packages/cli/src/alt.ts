/**
 * `masthead alt-text`: writes a description into every published post image
 * that has none (and every cover without one), with a vision model on the
 * server. One post per request, so a long list never times out; `--dry-run`
 * prints what it would write and changes nothing. Each post keeps a version
 * of its text first, so the change can be undone from the post's history.
 */
export interface AltOptions {
    server: string;
    token: string;
    dryRun: boolean;
    /** Only this post (its address, without slashes). */
    slug?: string;
    model?: string;
}

interface Missing {
    postId: string;
    slug: string;
    title: string;
    missing: number;
    cover: boolean;
}

interface Row {
    where: 'cover' | 'body';
    src: string;
    alt: string;
}

export async function altText(o: AltOptions): Promise<void> {
    const server = o.server.endsWith('/') ? o.server : `${o.server}/`;
    const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${server}admin/api${path}`, {
            method,
            headers: { authorization: `Bearer ${o.token}`, 'x-masthead': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
        return res.json() as Promise<any>;
    };
    const posts = ((await call('GET', '/ai/alt/missing')) as Missing[]).filter(p => !o.slug || p.slug === o.slug);
    if (!posts.length) return void console.log('Every image already has alt text.');
    console.log(`${posts.length} posts, ${posts.reduce((n, p) => n + p.missing + (p.cover ? 1 : 0), 0)} images without alt text${o.dryRun ? ' (dry run: nothing is written)' : ''}\n`);
    let written = 0;
    let failed = 0;
    for (const p of posts) {
        try {
            const done = (await call('POST', '/ai/alt/backfill', { postId: p.postId, dryRun: o.dryRun, model: o.model })) as { rows: Row[]; written: boolean };
            console.log(`${p.slug}${done.written ? '  (written)' : ''}`);
            for (const r of done.rows) console.log(`  ${r.where.padEnd(5)} ${r.src.split('/').slice(-1)[0].slice(0, 38).padEnd(38)} ${r.alt}`);
            if (done.written) written++;
        } catch (err) {
            failed++;
            console.log(`${p.slug}  FAILED ${(err as Error).message.slice(0, 200)}`);
        }
    }
    console.log(`\n${o.dryRun ? 'Would update' : 'Updated'} ${o.dryRun ? posts.length - failed : written} posts${failed ? `, ${failed} failed (run again; finished posts are skipped)` : ''}.`);
}
