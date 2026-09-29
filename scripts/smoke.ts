#!/usr/bin/env bun
/**
 * Proves a running Masthead server works end to end, the way people use it:
 * readers, subscribers, writers and the newsletter. Everything it creates is
 * removed again. Real subscribers are never emailed or changed; newsletter
 * checks need the server in email test mode and send to one throwaway member.
 *
 *   MASTHEAD_TOKEN=<bootstrap token> bun scripts/smoke.ts --server https://host/blog/ [--ai]
 *
 * --ai also drafts text and makes an image (spends a few AI credits).
 */

const args = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
};
const server = (flag('server') ?? 'http://localhost:8787/blog/').replace(/\/?$/, '/');
const token = process.env.MASTHEAD_TOKEN ?? '';
const withAI = flag('ai') === 'true';
if (token.length < 32) throw new Error('Set MASTHEAD_TOKEN to the server BOOTSTRAP_TOKEN.');

const origin = new URL(server).origin;
const base = new URL(server).pathname;
const stamp = Date.now().toString(36);
const results: { name: string; ok: boolean; ms: number; detail: string }[] = [];
const cleanup: (() => Promise<unknown>)[] = [];
let cookie = '';

async function check(name: string, fn: () => Promise<string | void>) {
    const t0 = performance.now();
    try {
        const detail = (await fn()) ?? '';
        results.push({ name, ok: true, ms: performance.now() - t0, detail });
        console.log(`  ok    ${name}${detail ? `  (${detail})` : ''}`);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        results.push({ name, ok: false, ms: performance.now() - t0, detail });
        console.log(`  FAIL  ${name}: ${detail}`);
    }
}

function assert(cond: unknown, message: string): asserts cond {
    if (!cond) throw new Error(message);
}

async function get(path: string, init: RequestInit = {}) {
    return fetch(path.startsWith('http') ? path : `${origin}${path}`, { redirect: 'manual', ...init });
}

/** Admin API as the signed-in owner (session cookie, like the admin app). */
async function admin<T = any>(method: string, path: string, body?: unknown, expect = 200): Promise<T> {
    const res = await fetch(`${server}admin/api${path}`, {
        method,
        headers: { cookie, 'x-masthead': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    assert(res.status === expect, `${method} ${path} returned ${res.status}, expected ${expect}: ${text.slice(0, 200)}`);
    return (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : (text as T);
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 60_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise(r => setTimeout(r, 1000));
    }
}

console.log(`Masthead smoke test against ${server}\n`);

// ------------------------------------------------------------------ readers
console.log('Readers');
let firstPost = '';
await check('front page renders', async () => {
    const res = await get(base);
    assert(res.status === 200, `status ${res.status}`);
    const html = await res.text();
    const m = html.match(/<link rel="canonical" href="([^"]+)"/);
    assert(m, 'no canonical link');
    const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*post-link|<h2[^>]*>\s*<a href="([^"]+)"/g)].map(x => x[1] ?? x[2]);
    firstPost = links.find(Boolean) ?? '';
    return `canonical ${m[1]}, x-robots-tag ${res.headers.get('x-robots-tag') ?? 'none'}`;
});
await check('a post page renders with structured data', async () => {
    if (!firstPost) {
        const sitemap = await (await get(`${base}sitemap-posts.xml`)).text();
        firstPost = sitemap.match(/<loc>([^<]+)<\/loc>/)?.[1] ?? '';
    }
    assert(firstPost, 'could not find a post link');
    const path = new URL(firstPost, `${origin}${base}`).pathname;
    const res = await get(path);
    assert(res.status === 200, `status ${res.status} for ${path}`);
    const html = await res.text();
    assert(html.includes('"@type":"BlogPosting"') || html.includes('"@type": "BlogPosting"'), 'no BlogPosting JSON-LD');
    assert(html.includes('og:title'), 'no og:title');
    firstPost = path;
    return path;
});
await check('markdown copy of the post', async () => {
    const res = await get(`${firstPost.replace(/\/$/, '')}.md`);
    assert(res.status === 200, `status ${res.status}`);
    assert((res.headers.get('content-type') ?? '').includes('markdown'), `content-type ${res.headers.get('content-type')}`);
    return `${(await res.text()).length} chars`;
});
for (const [name, path, type] of [
    ['RSS feed', 'rss/', 'xml'],
    ['sitemap index', 'sitemap.xml', 'xml'],
    ['llms.txt', 'llms.txt', 'text/plain']
] as const) {
    await check(name, async () => {
        const res = await get(`${base}${path}`);
        assert(res.status === 200, `status ${res.status}`);
        assert((res.headers.get('content-type') ?? '').includes(type), `content-type ${res.headers.get('content-type')}`);
        const text = await res.text();
        if (path === 'rss/') return `${(text.match(/<item>/g) ?? []).length} items`;
        return `${text.length} bytes`;
    });
}
await check('repeat visits get 304 Not Modified', async () => {
    const page = await get(base);
    const lastModified = page.headers.get('last-modified');
    assert(lastModified, 'no last-modified on HTML');
    const byDate = await get(base, { headers: { 'if-modified-since': lastModified } });
    assert(byDate.status === 304, `HTML revalidation returned ${byDate.status}`);
    const feed = await get(`${base}rss/`);
    const etag = feed.headers.get('etag');
    assert(etag, 'no etag on the feed');
    const byTag = await get(`${base}rss/`, { headers: { 'if-none-match': etag } });
    assert(byTag.status === 304, `feed revalidation returned ${byTag.status}`);
    return 'HTML by date, feeds by ETag';
});
await check('unknown pages are 404', async () => {
    const res = await get(`${base}no-such-post-${stamp}/`);
    assert(res.status === 404, `status ${res.status}`);
});
await check('old Ghost paths answer sensibly', async () => {
    const r = await get(`${base}r/abc123`);
    assert(r.status === 302, `/r/ link status ${r.status}`);
    const bad = await get(`${base}unsubscribe/?uuid=00000000-0000-4000-8000-000000000000`);
    assert(bad.status === 404, `unknown uuid status ${bad.status}`);
});

// ------------------------------------------------------------------ media
console.log('\nMedia');
let mediaPath = '';
await check('imported images are served from storage', async () => {
    const html = await (await get(firstPost)).text();
    mediaPath = html.match(new RegExp(`(?:src|href)="(${base.replace(/\//g, '\\/')}content\\/images\\/[^"?]+)"`))?.[1] ?? '';
    assert(mediaPath, 'post has no image under content/images');
    const res = await get(mediaPath);
    assert(res.status === 200, `status ${res.status}`);
    assert((res.headers.get('content-type') ?? '').startsWith('image/'), `content-type ${res.headers.get('content-type')}`);
    assert((res.headers.get('cache-control') ?? '').includes('immutable'), 'not cached as immutable');
    return `${mediaPath.split('/').pop()}, ${res.headers.get('content-length')} bytes`;
});
await check('range requests (video seeking)', async () => {
    const res = await get(mediaPath, { headers: { range: 'bytes=0-99' } });
    assert(res.status === 206, `status ${res.status}`);
    assert((await res.arrayBuffer()).byteLength === 100, 'wrong length');
});

// ------------------------------------------------------------------ admin
console.log('\nAdmin');
await check('admin app loads', async () => {
    const res = await get(`${base}admin/`);
    assert(res.status === 200, `status ${res.status}`);
    const html = await res.text();
    const script = html.match(/src="(app-[^"]+\.js)"/)?.[1];
    assert(script, 'no app script');
    const js = await get(`${base}admin/${script}`);
    assert(js.status === 200, `script status ${js.status}`);
    assert((js.headers.get('cache-control') ?? '').includes('immutable'), 'script not immutable');
    assert(res.headers.get('x-robots-tag')?.includes('noindex'), 'admin is indexable');
    return `${script}, ${(await js.arrayBuffer()).byteLength} bytes`;
});
await check('wrong bootstrap token is refused', async () => {
    const res = await fetch(`${server}admin/api/auth/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-masthead': '1' }, body: JSON.stringify({ token: 'x'.repeat(64) }) });
    assert(res.status === 401, `status ${res.status}`);
});
await check('owner signs in', async () => {
    const res = await fetch(`${server}admin/api/auth/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-masthead': '1' }, body: JSON.stringify({ token }) });
    assert(res.status === 200, `status ${res.status}`);
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    assert(cookie.startsWith('mh_session='), 'no session cookie');
    const me = await admin('GET', '/me');
    assert(me.user.role === 'owner', `role ${me.user.role}`);
    return `${me.user.role}, test mode ${me.testMode}`;
});
await check('cross-site writes are blocked', async () => {
    const res = await fetch(`${server}admin/api/posts`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert(res.status === 403, `status ${res.status}`);
});
await check('signed-out requests are refused', async () => {
    const res = await fetch(`${server}admin/api/members`);
    assert(res.status === 401, `status ${res.status}`);
});
await check('import is complete', async () => {
    const s = await admin('GET', '/stats');
    assert(s.posts > 0 && s.staff > 0 && s.members.total > 0, JSON.stringify(s));
    return `${s.posts} posts (${s.drafts} drafts), ${s.pages} pages, ${s.tags} tags, ${s.staff} staff, ${s.media} media, ${s.members.total} members (${s.members.sendable} sendable), ${s.member_events} history`;
});
await check('staff and roles', async () => {
    const staff: any[] = await admin('GET', '/staff');
    const roles = staff.reduce<Record<string, number>>((a, s) => ((a[s.role] = (a[s.role] ?? 0) + 1), a), {});
    assert(roles.owner === 1, 'expected exactly one owner');
    return Object.entries(roles).map(([r, n]) => `${n} ${r}`).join(', ');
});

// ------------------------------------------------------------------ writing
console.log('\nWriting');
const slug = `smoke-test-${stamp}`;
let postId = '';
await check('create a draft', async () => {
    const post = await admin('POST', '/posts', { title: `Smoke test ${stamp}`, slug, markdown: `Hello from the **smoke test**.\n\n## A heading\n\n- one\n- two\n\n[A link](https://example.com/page)` }, 201);
    postId = post.id;
    cleanup.push(() => admin('DELETE', `/posts/${postId}`).catch(() => {}));
    assert(post.status === 'draft', `status ${post.status}`);
    const res = await get(`${base}${slug}/`);
    assert(res.status === 404, `draft is public (${res.status})`);
});
await check('preview renders the draft privately', async () => {
    const html = await admin<string>('GET', `/posts/${postId}/preview`);
    assert(html.includes('<strong>smoke test</strong>'), 'markdown not rendered');
    assert(html.includes('noindex'), 'preview is indexable');
});
await check('publish makes it public, tagged links included', async () => {
    const r = await admin('POST', `/posts/${postId}/publish`, {});
    assert(r.post.status === 'published', `status ${r.post.status}`);
    const res = await get(`${base}${slug}/`);
    assert(res.status === 200, `status ${res.status}`);
    const html = await res.text();
    assert(html.includes('<h2'), 'heading missing');
    assert(/https:\/\/example\.com\/page\?ref=/.test(html), 'outbound link not tagged');
    return `site rebuilt: ${r.publish.written} of ${r.publish.total} files in ${r.publish.ms} ms`;
});
await check('the post is in the feed and sitemap', async () => {
    const rss = await (await get(`${base}rss/`)).text();
    assert(rss.includes(slug), 'not in RSS');
    const sm = await (await get(`${base}sitemap-posts.xml`)).text();
    assert(sm.includes(slug), 'not in sitemap');
});
await check('edits go live', async () => {
    await admin('PUT', `/posts/${postId}`, { markdown: `Edited ${stamp}.` });
    await waitFor(async () => (await (await get(`${base}${slug}/`)).text()).includes(`Edited ${stamp}.`), 'the edit to publish', 20_000);
});
await check('scheduling holds a post back', async () => {
    const r = await admin('POST', `/posts/${postId}/publish`, { publishedAt: new Date(Date.now() + 86400_000).toISOString() });
    assert(r.post.status === 'scheduled', `status ${r.post.status}`);
});
await check('unpublish removes it', async () => {
    await admin('POST', `/posts/${postId}/unpublish`);
    const res = await get(`${base}${slug}/`);
    assert(res.status === 404, `status ${res.status}`);
});
await check('redirects: exact, pattern, never over a real page', async () => {
    const from = `smoke-old-${stamp}`;
    const made = await admin('POST', '/redirects', { from: `/${from}/`, to: `/${slug}/` }, 201);
    cleanup.push(() => admin('DELETE', `/redirects/${made.id}`));
    const pattern = await admin('POST', '/redirects', { from: `^/smoke-topic-${stamp}/(.*)$`, to: '/tag/$1/', status: 302 }, 201);
    cleanup.push(() => admin('DELETE', `/redirects/${pattern.id}`));
    const hit = await get(`${base}${from}/?x=1`);
    assert(hit.status === 301 && (hit.headers.get('location') ?? '').endsWith(`${base}${slug}/?x=1`), `exact: ${hit.status} ${hit.headers.get('location')}`);
    const tagged = await get(`${base}smoke-topic-${stamp}/news/`);
    assert(tagged.status === 302 && (tagged.headers.get('location') ?? '').endsWith(`${base}tag/news/`), `pattern: ${tagged.status} ${tagged.headers.get('location')}`);
    await admin('POST', '/redirects', { from: `/${slug}-x/`, to: `/${slug}-x/` }, 400);
    await admin('POST', '/redirects', { from: '/', to: '/x/' }, 400);
});
await check('image upload', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const form = new FormData();
    form.append('file', new File([png], 'dot.png', { type: 'image/png' }));
    const res = await fetch(`${server}admin/api/media`, { method: 'POST', headers: { cookie, 'x-masthead': '1' }, body: form });
    assert(res.status === 201, `status ${res.status}`);
    const { url } = await res.json();
    const img = await get(url);
    assert(img.status === 200 && img.headers.get('content-type') === 'image/png', `served ${img.status} ${img.headers.get('content-type')}`);
    return url;
});

// ------------------------------------------------------------------ subscribers
console.log('\nSubscribers');
// Resend's test inbox: real delivery, nothing bounces, nobody receives it.
const email = `delivered+smoke-${stamp}@resend.dev`;
let memberId = '';
let confirmUrl = '';
await check('bots filling the hidden field are ignored', async () => {
    const res = await fetch(`${server}api/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `delivered+bot-${stamp}@resend.dev`, company: 'x' }) });
    assert(res.status === 200, `status ${res.status}`);
    const list = await admin('GET', `/members?q=bot-${stamp}`);
    assert(list.total === 0, 'bot was added');
});
await check('sign-up needs confirming (double opt-in)', async () => {
    const anonymous = await fetch(`${server}api/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    const first = await anonymous.json();
    assert(anonymous.status === 200 && first.status === 'pending', `status ${anonymous.status} ${JSON.stringify(first)}`);
    assert(!first.confirmUrl, 'the confirm link was handed to an anonymous caller');
    // Signed in as the owner, the test-mode response carries the link so this check needs no inbox.
    const res = await fetch(`${server}api/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ email }) });
    const data = await res.json();
    confirmUrl = data.confirmUrl;
    assert(confirmUrl, 'no confirm link (is the server in email test mode?)');
    const list = await admin('GET', `/members?q=${encodeURIComponent(email)}`);
    memberId = list.items[0]?.id;
    cleanup.push(() => admin('DELETE', `/members/${memberId}`).catch(() => {}));
    assert(list.items[0]?.status === 'pending', `status ${list.items[0]?.status}`);
});
await check('confirm link subscribes', async () => {
    const res = await get(confirmUrl.replace(/^https?:\/\/[^/]+/, ''));
    assert(res.status === 200, `status ${res.status}`);
    const { member } = await admin('GET', `/members/${memberId}`);
    assert(member.status === 'subscribed', `status ${member.status}`);
});
await check('a tampered confirm link is rejected', async () => {
    const res = await get(confirmUrl.replace(/^https?:\/\/[^/]+/, '').replace(/t=[^&]+/, 't=bad'));
    assert(res.status === 400, `status ${res.status}`);
});

// ------------------------------------------------------------------ newsletter
console.log('\nNewsletter');
let newsletterPost = '';
await check('email preview renders', async () => {
    const posts = await admin('GET', '/posts?status=published&limit=1');
    newsletterPost = posts.items[0]?.id;
    assert(newsletterPost, 'no published post');
    const html = await admin<string>('GET', `/sends/preview?postId=${newsletterPost}`);
    assert(html.includes('<html') && html.length > 2000, 'preview looks empty');
    return `${(html.length / 1024).toFixed(0)} KB`;
});
await check('segment counts', async () => {
    const all = await admin('GET', '/sends/segment?segment=all');
    const engaged = await admin('GET', '/sends/segment?segment=engaged');
    return `all ${all.count}, engaged ${engaged.count}`;
});
await check('send to a one-person segment in test mode', async () => {
    const me = await admin('GET', '/me');
    assert(me.testMode, 'server is not in email test mode: refusing to send');
    await admin('PUT', `/members/${memberId}`, { labels: [`smoke-${stamp}`] });
    const seg = await admin('GET', `/sends/segment?segment=label:smoke-${stamp}`);
    assert(seg.count === 1, `segment has ${seg.count} members`);
    const send = await admin('POST', '/sends', { postId: newsletterPost, segment: `label:smoke-${stamp}`, confirm: 'send' }, 201);
    const done = await waitFor(
        async () => {
            await admin('POST', '/sends/process').catch(() => {});
            const s = await admin('GET', `/sends/${send.id}`);
            return ['sent', 'failed'].includes(s.status) ? s : null;
        },
        'the send to finish',
        90_000
    );
    const s = done;
    assert(s.status === 'sent', `send ${s.status}: ${JSON.stringify(s).slice(0, 300)}`);
    assert(s.total === 1 && s.sent === 1, `sent ${s.sent} of ${s.total}`);
    return `status ${s.status}, ${s.total} recipient, delivered to the provider's test inbox`;
});
await check('one-click unsubscribe (RFC 8058)', async () => {
    const detail = await admin('GET', `/members/${memberId}`);
    assert(detail.member.status === 'subscribed', 'not subscribed');
    // The member's List-Unsubscribe URL, called the way a mail client calls it.
    const { url: link } = await admin('GET', `/members/${memberId}/unsubscribe-link`);
    const get1 = await get(link.replace(/^https?:\/\/[^/]+/, ''));
    assert(get1.status === 200, `GET status ${get1.status}`);
    const still = await admin('GET', `/members/${memberId}`);
    assert(still.member.status === 'subscribed', 'a GET unsubscribed them: link scanners would unsubscribe people');
    const post = await fetch(link.replace(/^https?:\/\/[^/]+/, origin), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert(post.status === 200, `POST status ${post.status}`);
    const after = await admin('GET', `/members/${memberId}`);
    assert(after.member.status === 'unsubscribed', `status ${after.member.status}`);
});
await check('adding an unsubscribed person again keeps them unsubscribed', async () => {
    const res = await admin('POST', '/members', { email, labels: ['product-signup'] });
    assert(res.created === false, 'created a duplicate');
    const after = await admin('GET', `/members/${memberId}`);
    assert(after.member.status === 'unsubscribed', `re-subscribed them: ${after.member.status}`);
});
await check('re-subscribing an opt-out needs explicit confirmation', async () => {
    const res = await fetch(`${server}admin/api/members/${memberId}`, { method: 'PUT', headers: { cookie, 'x-masthead': '1', 'content-type': 'application/json' }, body: JSON.stringify({ status: 'subscribed' }) });
    assert(res.status === 400, `status ${res.status}`);
});

// ------------------------------------------------------------------ AI
if (withAI) {
    console.log('\nAI studio');
    await check('model catalog', async () => {
        const text: any[] = await admin('GET', '/ai/models?kind=text');
        const image: any[] = await admin('GET', '/ai/models?kind=image');
        assert(text.length > 0 && image.length > 0, 'empty catalog');
        return `${text.length} text models, ${image.length} image models`;
    });
    await check('draft from a prompt', async () => {
        const r = await admin('POST', '/ai/draft', { prompt: 'Write two sentences announcing a faster blog. No title.', maxTokens: 200 });
        assert((r.markdown ?? r.text ?? '').length > 20, JSON.stringify(r).slice(0, 200));
        return `${r.model ?? ''} ${r.usage?.charged ?? ''} credits`.trim();
    });
    await check('cover image', async () => {
        const r = await admin('POST', '/ai/image', { prompt: 'A minimal black and white illustration of a printing press, flat, no text', aspectRatio: '16:9' });
        const img = await get(r.url);
        assert(img.status === 200 && (img.headers.get('content-type') ?? '').startsWith('image/'), `served ${img.status}`);
        return `${r.model ?? ''}, ${(Number(img.headers.get('content-length') ?? 0) / 1024).toFixed(0)} KB`;
    });
}

// ------------------------------------------------------------------ cleanup
for (const fn of cleanup.reverse()) await fn();
await check('cleanup leaves no trace', async () => {
    const res = await get(`${base}${slug}/`);
    assert(res.status === 404, 'post still public');
    const list = await admin('GET', `/members?q=${encodeURIComponent(email)}`);
    assert(list.total === 0, 'member still present');
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map(f => f.name).join(', ')}` : ''}`);
if (flag('json')) await Bun.write(flag('json')!, JSON.stringify({ server, at: new Date().toISOString(), results }, null, 2));
process.exit(failed.length ? 1 : 0);

export {};
