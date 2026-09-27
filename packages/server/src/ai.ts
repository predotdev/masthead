import type { AIProvider, AspectRatio, ModelKind } from '@masthead/core';
import { aiSettings, savePost, siteSettings } from './content';
import type { Ctx, Principal } from './env';
import { MEDIA_PREFIX } from './public';
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

const modelCache = new Map<string, { at: number; list: unknown }>();

export async function listModels(ctx: Ctx, kind?: ModelKind) {
    const key = kind ?? 'all';
    const hit = modelCache.get(key);
    if (hit && Date.now() - hit.at < 600_000) return hit.list;
    const list = await provider(ctx).listModels(kind);
    modelCache.set(key, { at: Date.now(), list });
    return list;
}

async function textModel(ctx: Ctx): Promise<string> {
    const s = await aiSettings(ctx.env, ctx.db);
    if (!s.textModel) throw new HttpError(400, 'Choose a text model in Settings, AI.');
    return s.textModel;
}

async function system(ctx: Ctx, task: string): Promise<string> {
    const [site, s] = await Promise.all([siteSettings(ctx.env, ctx.db), aiSettings(ctx.env, ctx.db)]);
    return [
        `You write for the blog of ${site.title}${site.description ? ` (${site.description})` : ''}.`,
        s.voice ? `House style:\n${s.voice}` : 'Write plainly and specifically: concrete details, short paragraphs, active voice, no filler.',
        'Never invent facts, numbers, customers, quotes or links. When something needed is missing, write [TODO: what is missing] in its place.',
        task
    ].join('\n\n');
}

export async function draft(ctx: Ctx, input: { prompt: string; notes?: string }) {
    if (!input.prompt?.trim()) throw new HttpError(400, 'Describe the post you want.');
    const res = await provider(ctx).text({
        model: await textModel(ctx),
        system: await system(ctx, 'Write a complete blog post in Markdown. Start with the title as "# Title" on the first line, then the body using ## section headings. Return only the Markdown.'),
        messages: [{ role: 'user', content: `${input.prompt.trim()}${input.notes ? `\n\nSource material:\n${input.notes}` : ''}` }],
        maxTokens: 4000
    });
    const text = res.text.trim().replace(/^```(?:markdown)?\n?|```$/g, '');
    const m = text.match(/^#\s+(.+)\n+/);
    return { title: m ? m[1].trim() : '', markdown: m ? text.slice(m[0].length).trim() : text, model: res.model, usage: res.usage };
}

export async function edit(ctx: Ctx, input: { markdown: string; instruction: string }) {
    if (!input.markdown?.trim()) throw new HttpError(400, 'Select some text first.');
    const res = await provider(ctx).text({
        model: await textModel(ctx),
        system: await system(ctx, 'Rewrite the Markdown you are given according to the instruction. Keep facts, links and formatting unless told otherwise. Return only the rewritten Markdown.'),
        messages: [{ role: 'user', content: `Instruction: ${input.instruction || 'Tighten it.'}\n\nMarkdown:\n${input.markdown}` }],
        maxTokens: 3000
    });
    return { markdown: res.text.trim().replace(/^```(?:markdown)?\n?|```$/g, ''), model: res.model, usage: res.usage };
}

export async function meta(ctx: Ctx, input: { title?: string; markdown: string }) {
    const res = await provider(ctx).text({
        model: await textModel(ctx),
        system: await system(
            ctx,
            'Suggest search and share metadata for the post. Reply with one JSON object: {"titles": [3 titles, at most 60 characters], "descriptions": [3 descriptions, at most 155 characters], "excerpt": "one or two sentences for the post listing"}.'
        ),
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

export async function image(ctx: Ctx, input: { prompt: string; aspectRatio?: AspectRatio }) {
    if (!input.prompt?.trim()) throw new HttpError(400, 'Describe the image.');
    const s = await aiSettings(ctx.env, ctx.db);
    if (!s.imageModel) throw new HttpError(400, 'Choose an image model in Settings, AI.');
    const res = await provider(ctx).image({ model: s.imageModel, prompt: input.prompt, aspectRatio: input.aspectRatio ?? '16:9' });
    const ext = res.mimeType === 'image/png' ? 'png' : res.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const d = new Date();
    const rel = `content/images/ai/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${newId()}.${ext}`;
    await ctx.env.BUCKET.put(`${MEDIA_PREFIX}${rel}`, res.bytes, { httpMetadata: { contentType: res.mimeType } });
    await ctx.db.prepare('INSERT INTO media (key, content_type, size, source_url, created_at) VALUES (?, ?, ?, ?, ?)').bind(rel, res.mimeType, res.bytes.length, `ai:${res.model}`, now()).run();
    return { url: `${ctx.basePath}${rel}`, model: res.model, usage: res.usage };
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
