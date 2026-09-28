import type { AIProvider, AspectRatio, ModelInfo, ModelKind, TextMessage } from '@masthead/core';
import { aiSettings, savePost, siteSettings } from './content';
import type { Ctx, Principal } from './env';
import { storeImage } from './images';
import { MEDIA_PREFIX } from './public';
import { listMemory, retrieve, type Passage } from './knowledge';
import { HttpError, newId, now } from './util';

/** The configured AI provider; its failures come back as clear 502s instead of server errors. */
function provider(ctx: Ctx): AIProvider {
    const ai = ctx.options.ai?.(ctx.env);
    if (!ai) throw new HttpError(501, 'No AI provider is configured. Set PREDEV_API_KEY.');
    const wrap =
        <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
        async (...a: A): Promise<R> => {
            try {
                return await fn(...a);
            } catch (err: any) {
                if (err instanceof HttpError) throw err;
                throw new HttpError(err?.status === 429 ? 429 : 502, `The AI provider said: ${err?.message ?? 'request failed'}`);
            }
        };
    return { ...ai, listModels: wrap(ai.listModels.bind(ai)), text: wrap(ai.text.bind(ai)), image: wrap(ai.image.bind(ai)) };
}

const modelCache = new Map<string, { at: number; list: ModelInfo[] }>();

export async function listModels(ctx: Ctx, kind?: ModelKind) {
    const key = kind ?? 'all';
    const hit = modelCache.get(key);
    const list = hit && Date.now() - hit.at < 600_000 ? hit.list : await provider(ctx).listModels(kind);
    if (!hit || hit.list !== list) modelCache.set(key, { at: Date.now(), list });
    // Mark the models this site uses by default, so pickers can show what "default" means.
    const s = await aiSettings(ctx.env, ctx.db);
    const defaults = new Set([s.textModel, s.imageModel, s.videoModel, s.embeddingModel].filter(Boolean));
    return list.map(m => (defaults.has(m.id) ? { ...m, isDefault: true } : m));
}

async function textModel(ctx: Ctx): Promise<string> {
    const s = await aiSettings(ctx.env, ctx.db);
    if (!s.textModel) throw new HttpError(400, 'Choose a text model in Settings, AI.');
    return s.textModel;
}

/**
 * Everything the model is told before the task: who it writes for, the house
 * style, the team's memory, and the passages from the blog and its sources
 * that relate to the request (cited by number, with links).
 */
async function system(ctx: Ctx, task: string, grounding?: { query: string; ai: AIProvider }): Promise<{ prompt: string; sources: Passage[] }> {
    const [site, s, memory] = await Promise.all([siteSettings(ctx.env, ctx.db), aiSettings(ctx.env, ctx.db), listMemory(ctx.db)]);
    const sources = grounding ? await retrieve(ctx, grounding.ai, grounding.query).catch(() => []) : [];
    const prompt = [
        `You write for the blog of ${site.title}${site.description ? ` (${site.description})` : ''}. You know ${site.title} well: its product, docs, changelog and every post on this blog are available to you as reference.`,
        s.voice ? `House style:\n${s.voice}` : 'Write plainly and specifically: concrete details, short paragraphs, active voice, no filler.',
        memory.length ? `Things the team wants you to remember:\n${memory.map(m => `- ${m.text}`).join('\n')}` : '',
        sources.length
            ? `Reference passages (use only what is relevant; when you state a product fact or a number, it must come from here). To cite one, link a few descriptive words to its URL, e.g. [METR's time-horizon study](https://example.com/post/). Never write reference numbers like [1] or (4).\n\n${sources.map((p, i) => `Passage ${i + 1}: ${p.title}${p.url ? `\nURL: ${p.url}` : ''}\n${p.text}`).join('\n\n')}`
            : '',
        'Never invent facts, numbers, customers, quotes or links. When something needed is missing, write [TODO: what is missing] in its place.',
        task
    ]
        .filter(Boolean)
        .join('\n\n');
    return { prompt, sources };
}

export async function draft(ctx: Ctx, input: { prompt: string; notes?: string }) {
    if (!input.prompt?.trim()) throw new HttpError(400, 'Describe the post you want.');
    const ai = provider(ctx);
    const { prompt } = await system(ctx, 'Write a complete blog post in Markdown. Start with the title as "# Title" on the first line, then the body using ## section headings. Return only the Markdown.', {
        query: `${input.prompt}\n${input.notes ?? ''}`,
        ai
    });
    const res = await ai.text({
        model: await textModel(ctx),
        system: prompt,
        messages: [{ role: 'user', content: `${input.prompt.trim()}${input.notes ? `\n\nSource material:\n${input.notes}` : ''}` }],
        maxTokens: 6000
    });
    const text = res.text.trim().replace(/^```(?:markdown)?\n?|```$/g, '');
    const m = text.match(/^#\s+(.+)\n+/);
    return { title: m ? m[1].trim() : '', markdown: m ? text.slice(m[0].length).trim() : text, model: res.model, usage: res.usage };
}

export async function edit(ctx: Ctx, input: { markdown: string; instruction: string }) {
    if (!input.markdown?.trim()) throw new HttpError(400, 'Select some text first.');
    const res = await provider(ctx).text({
        model: await textModel(ctx),
        system: (await system(ctx, 'Rewrite the Markdown you are given according to the instruction. Keep facts, links and formatting unless told otherwise. Return only the rewritten Markdown.')).prompt,
        messages: [{ role: 'user', content: `Instruction: ${input.instruction || 'Tighten it.'}\n\nMarkdown:\n${input.markdown}` }],
        maxTokens: 3000
    });
    return { markdown: res.text.trim().replace(/^```(?:markdown)?\n?|```$/g, ''), model: res.model, usage: res.usage };
}

export async function meta(ctx: Ctx, input: { title?: string; markdown: string }) {
    const res = await provider(ctx).text({
        model: await textModel(ctx),
        system: (
            await system(
                ctx,
                'Suggest search and share metadata for the post. Reply with one JSON object: {"titles": [3 titles, at most 60 characters], "descriptions": [3 descriptions, at most 155 characters], "excerpt": "one or two sentences for the post listing"}.'
            )
        ).prompt,
        messages: [{ role: 'user', content: `Current title: ${input.title ?? ''}\n\n${(input.markdown ?? '').slice(0, 12000)}` }],
        json: true,
        maxTokens: 800
    });
    try {
        const data = JSON.parse(res.text.replace(/^```(?:json)?\n?|```$/g, ''));
        return { titles: data.titles ?? [], descriptions: data.descriptions ?? [], excerpt: data.excerpt ?? '', model: res.model, usage: res.usage };
    } catch {
        throw new HttpError(502, 'The model did not return valid JSON. Try again.');
    }
}

export async function image(ctx: Ctx, input: { prompt: string; aspectRatio?: AspectRatio; model?: string; reference?: string }) {
    if (!input.prompt?.trim()) throw new HttpError(400, 'Describe the image.');
    const s = await aiSettings(ctx.env, ctx.db);
    const model = input.model || s.imageModel;
    if (!model) throw new HttpError(400, 'Choose an image model in Settings, AI.');
    const references = input.reference ? [await asDataUrl(ctx, input.reference)] : undefined;
    const res = await provider(ctx).image({ model, prompt: input.prompt, aspectRatio: input.aspectRatio ?? '16:9', references });
    const ext = res.mimeType === 'image/png' ? 'png' : res.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const d = new Date();
    const rel = `content/images/ai/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${newId()}.${ext}`;
    await storeImage(ctx.env, ctx.db, rel, res.bytes, res.mimeType, `ai:${res.model}`);
    return { url: `${ctx.basePath}${rel}`, model: res.model, usage: res.usage };
}

/** An image the blog stores (or any public URL) as a data: URL, so the model provider needs no access to it. */
async function asDataUrl(ctx: Ctx, src: string): Promise<string> {
    const path = src.startsWith(ctx.basePath) ? src : (() => {
        try {
            const u = new URL(src);
            return u.pathname.startsWith(`${ctx.basePath}content/`) ? u.pathname : null;
        } catch {
            return null;
        }
    })();
    let bytes: Uint8Array;
    let type: string;
    if (path) {
        const obj = await ctx.env.BUCKET.get(`${MEDIA_PREFIX}${decodeURIComponent(path).slice(ctx.basePath.length)}`);
        if (!obj) throw new HttpError(404, 'That image is not in the media library.');
        bytes = new Uint8Array(await obj.arrayBuffer());
        type = obj.httpMetadata?.contentType ?? 'image/png';
    } else {
        const res = await fetch(src, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new HttpError(400, `Could not read the image (${res.status}).`);
        bytes = new Uint8Array(await res.arrayBuffer());
        type = res.headers.get('content-type') ?? 'image/png';
    }
    if (bytes.length > 12 * 1024 * 1024) throw new HttpError(413, 'Images to edit can be up to 12 MB.');
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
}

// ------------------------------------------------------------------ the writing assistant

export type AssistMode = 'chat' | 'edit' | 'write' | 'continue';

export interface AssistInput {
    mode: AssistMode;
    instruction?: string;
    /** The selected text (edit), as Markdown. */
    selection?: string;
    /** The post around the cursor. */
    before?: string;
    after?: string;
    title?: string;
    /** The whole post as Markdown (chat). */
    post?: string;
    messages?: TextMessage[];
    model?: string;
}

const TASKS: Record<AssistMode, string> = {
    chat: 'You are the writing partner inside the blog editor. Answer the writer directly and briefly. When you draft text for the post, give it as Markdown the writer can insert as is, without commentary around it.',
    edit: 'Rewrite the selected passage according to the instruction. Keep facts, links and formatting unless told otherwise. Reply with only the rewritten Markdown, nothing else.',
    write: 'Write what the instruction asks for, to insert at the cursor of the post. It must read naturally with the text around it. Reply with only the Markdown to insert.',
    continue: 'Continue the post from the cursor for one to three paragraphs, in the same voice, moving the argument forward. Reply with only the Markdown to insert.'
};

/** Streams the assistant's reply as server-sent events: sources first, then text deltas, then done. */
export async function assist(ctx: Ctx, input: AssistInput): Promise<Response> {
    const ai = provider(ctx);
    if (!ai.stream) throw new HttpError(501, 'The AI provider cannot stream.');
    const mode: AssistMode = TASKS[input.mode] ? input.mode : 'chat';
    const clip = (s: string | undefined, n: number, fromEnd = false) => (!s ? '' : s.length <= n ? s : fromEnd ? s.slice(-n) : s.slice(0, n));
    const lastUser = [...(input.messages ?? [])].reverse().find(m => m.role === 'user')?.content ?? '';
    // What to look up: the request, plus the text just before the cursor so "continue" finds the topic at hand.
    const query = [input.instruction, input.selection, lastUser, input.title, mode === 'continue' || mode === 'write' ? clip(input.before, 1200, true) : ''].filter(Boolean).join('\n').slice(0, 2400);
    const { prompt, sources } = await system(ctx, TASKS[mode], { query: query || clip(input.post, 1500), ai });

    const context = [
        input.title ? `Post title: ${input.title}` : '',
        mode === 'chat' && input.post ? `The post so far (Markdown):\n${clip(input.post, 16000)}` : '',
        mode !== 'chat' && input.before ? `Text before the cursor:\n${clip(input.before, 6000, true)}` : '',
        mode !== 'chat' && input.after ? `Text after the cursor:\n${clip(input.after, 2000)}` : ''
    ]
        .filter(Boolean)
        .join('\n\n');
    const messages: TextMessage[] =
        mode === 'chat'
            ? [...(context ? [{ role: 'user' as const, content: context }, { role: 'assistant' as const, content: 'Got it. What would you like to do with the post?' }] : []), ...(input.messages ?? []).slice(-12)]
            : [
                  {
                      role: 'user',
                      content: [
                          context,
                          mode === 'edit' ? `Selected passage:\n${clip(input.selection, 8000)}` : '',
                          input.instruction ? `Instruction: ${input.instruction}` : mode === 'edit' ? 'Instruction: improve it: clearer, tighter, more specific.' : ''
                      ]
                          .filter(Boolean)
                          .join('\n\n')
                  }
              ];
    const model = input.model || (await textModel(ctx));
    const enc = new TextEncoder();
    const send = (event: string | null, data: unknown) => enc.encode(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            controller.enqueue(send('sources', sources.map(p => ({ title: p.title, url: p.url }))));
            try {
                for await (const delta of ai.stream!({ model, system: prompt, messages, maxTokens: mode === 'chat' ? 3000 : 2500, temperature: 0.6 })) controller.enqueue(send(null, { t: delta }));
                controller.enqueue(send('done', { model }));
            } catch (err: any) {
                controller.enqueue(send('error', { message: err?.message ?? 'The model stopped.' }));
            }
            controller.close();
        }
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

// ------------------------------------------------------------------ video

export async function startVideo(ctx: Ctx, input: { prompt: string; model?: string; aspectRatio?: string; duration?: number; reference?: string }, by: Principal) {
    const ai = provider(ctx);
    if (!ai.video) throw new HttpError(501, 'The AI provider cannot make video.');
    if (!input.prompt?.trim()) throw new HttpError(400, 'Describe the video.');
    const s = await aiSettings(ctx.env, ctx.db);
    const model = input.model || s.videoModel;
    if (!model) throw new HttpError(400, 'Choose a video model in Settings, AI.');
    // "Animate this image": the still becomes the clip's first frame.
    const firstFrame = input.reference ? await asDataUrl(ctx, input.reference) : undefined;
    const job = await ai.video.submit({ model, prompt: input.prompt.trim(), aspectRatio: input.aspectRatio ?? '16:9', duration: input.duration, firstFrame });
    const id = newId();
    const t = now();
    await ctx.db
        .prepare('INSERT INTO ai_jobs (id, kind, provider_id, status, prompt, model, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, 'video', job.id, job.status, input.prompt.trim(), model, by.staffId, t, t)
        .run();
    return { id, status: job.status };
}

/** Checks a video job; once finished, stores the file with the rest of the media and returns its address. */
export async function videoStatus(ctx: Ctx, id: string) {
    const job = await ctx.db.prepare('SELECT * FROM ai_jobs WHERE id = ? AND kind = ?').bind(id, 'video').first<any>();
    if (!job) throw new HttpError(404, 'No such video job.');
    if (job.status === 'completed' || job.status === 'failed') return { id, status: job.status, url: job.url, error: job.error };
    const ai = provider(ctx);
    const reach = <T>(p: Promise<T>) => p.catch((err: any): never => {
        throw new HttpError(502, `The video service said: ${err?.message ?? 'no answer'}`);
    });
    const state = await reach(ai.video!.status(job.provider_id));
    if (state.status === 'completed') {
        const bytes = await reach(ai.video!.content(job.provider_id));
        const d = new Date();
        const rel = `content/media/ai/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${id}.mp4`;
        await ctx.env.BUCKET.put(`${MEDIA_PREFIX}${rel}`, bytes, { httpMetadata: { contentType: 'video/mp4' } });
        await ctx.db.prepare('INSERT OR REPLACE INTO media (key, content_type, size, source_url, created_at) VALUES (?, ?, ?, ?, ?)').bind(rel, 'video/mp4', bytes.length, `ai:${job.model}`, now()).run();
        const url = `${ctx.basePath}${rel}`;
        await ctx.db.prepare("UPDATE ai_jobs SET status = 'completed', url = ?, updated_at = ? WHERE id = ?").bind(url, now(), id).run();
        return { id, status: 'completed', url };
    }
    if (state.status === 'failed') {
        await ctx.db.prepare("UPDATE ai_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(state.error ?? 'failed', now(), id).run();
        return { id, status: 'failed', error: state.error };
    }
    await ctx.db.prepare('UPDATE ai_jobs SET status = ?, updated_at = ? WHERE id = ?').bind(state.status, now(), id).run();
    return { id, status: state.status };
}

// ------------------------------------------------------------------ embeds

export interface Unfurled {
    type: 'embed' | 'bookmark';
    url: string;
    provider?: string;
    html?: string;
    title?: string;
    description?: string;
    image?: string | null;
    icon?: string | null;
    publisher?: string | null;
}

/** Turns a link into an embed (video, post) or a bookmark card with the page's title, summary and image. */
export async function unfurl(raw: string): Promise<Unfurled> {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new HttpError(400, 'That is not a link.');
    }
    const host = url.hostname.replace(/^www\./, '');
    const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const frame = (src: string, provider: string) => ({
        type: 'embed' as const,
        url: url.toString(),
        provider,
        html: `<iframe src="${attr(src)}" width="560" height="315" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy" title="${attr(provider)}"></iframe>`
    });
    const yt = host === 'youtu.be' ? url.pathname.slice(1) : host.endsWith('youtube.com') ? url.searchParams.get('v') ?? url.pathname.match(/\/(?:shorts|embed|live)\/([\w-]+)/)?.[1] : null;
    if (yt) return frame(`https://www.youtube.com/embed/${yt}`, 'YouTube');
    const vimeo = host.endsWith('vimeo.com') ? url.pathname.match(/\/(\d+)/)?.[1] : null;
    if (vimeo) return frame(`https://player.vimeo.com/video/${vimeo}`, 'Vimeo');
    const loom = host.endsWith('loom.com') ? url.pathname.match(/\/(?:share|embed)\/([\w-]+)/)?.[1] : null;
    if (loom) return frame(`https://www.loom.com/embed/${loom}`, 'Loom');
    if ((host === 'x.com' || host === 'twitter.com') && /\/status\/\d+/.test(url.pathname)) {
        return {
            type: 'embed',
            url: url.toString(),
            provider: 'X',
            html: `<blockquote class="twitter-tweet"><a href="${attr(url.toString().replace('x.com', 'twitter.com'))}"></a></blockquote><script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`
        };
    }
    // Anything else: a bookmark card from the page's own metadata.
    const res = await fetch(url.toString(), { headers: { 'user-agent': 'Mozilla/5.0 (compatible; masthead-unfurl)', accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(8000) }).catch(() => null);
    const page = res?.ok && (res.headers.get('content-type') ?? '').includes('html') ? (await res.text()).slice(0, 400_000) : '';
    const meta = (name: string) =>
        page.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))?.[1] ??
        page.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i'))?.[1] ??
        null;
    const decode = (s: string | null) => s?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() ?? null;
    const abs = (s: string | null) => {
        if (!s) return null;
        try {
            return new URL(s, url).toString();
        } catch {
            return null;
        }
    };
    const iconHref = page.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i)?.[1] ?? page.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i)?.[1] ?? '/favicon.ico';
    return {
        type: 'bookmark',
        url: url.toString(),
        title: decode(meta('og:title')) ?? decode(page.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? null) ?? host,
        description: decode(meta('og:description') ?? meta('description')) ?? '',
        image: abs(meta('og:image')),
        icon: abs(iconHref),
        publisher: decode(meta('og:site_name')) ?? host
    };
}

// ------------------------------------------------------------------ ideas

export async function listIdeas(ctx: Ctx, status = 'new') {
    const { results } = await ctx.db.prepare('SELECT * FROM ideas WHERE status = ? ORDER BY COALESCE(score, 0) DESC, created_at DESC LIMIT 200').bind(status).all<any>();
    return results.map(r => ({ ...r, sources: JSON.parse(r.sources || '[]') }));
}

export async function addIdeas(ctx: Ctx, ideas: { title: string; angle?: string; series?: string; sources?: unknown[]; score?: number }[]) {
    const t = now();
    const stmts = ideas
        .filter(i => i?.title?.trim())
        .slice(0, 100)
        .map(i =>
            ctx.db
                .prepare('INSERT INTO ideas (id, title, angle, series, sources, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .bind(newId(), i.title.trim().slice(0, 300), i.angle ?? null, i.series ?? null, JSON.stringify(i.sources ?? []), i.score ?? null, t, t)
        );
    if (stmts.length) await ctx.db.batch(stmts);
    return { added: stmts.length };
}

export async function draftIdea(ctx: Ctx, id: string, by: Principal) {
    const idea = await ctx.db.prepare('SELECT * FROM ideas WHERE id = ?').bind(id).first<any>();
    if (!idea) throw new HttpError(404, 'Idea not found.');
    const sources = JSON.parse(idea.sources || '[]') as { title?: string; url?: string; summary?: string }[];
    const notes = sources.map(s => `- ${s.title ?? ''}${s.url ? ` (${s.url})` : ''}${s.summary ? `: ${s.summary}` : ''}`).join('\n');
    const d = await draft(ctx, { prompt: `Write the post "${idea.title}". Angle: ${idea.angle ?? 'your call'}.${idea.series ? ` Series: ${idea.series}.` : ''}`, notes });
    const post = await savePost(ctx.db, { title: d.title || idea.title, markdown: d.markdown, bodyFormat: 'markdown', status: 'draft', type: 'post' }, { defaultAuthorId: by.staffId.startsWith('key:') ? undefined : by.staffId });
    await ctx.db.prepare("UPDATE ideas SET status = 'drafted', post_id = ?, updated_at = ? WHERE id = ?").bind(post.id, now(), id).run();
    return { post };
}
