import type { AIProvider, AspectRatio, ImageResult, ModelInfo, ModelKind, StreamEnd, TextMessage, TextRequest, Usage } from '@masthead/core';
import { aiSettings, savePost, siteSettings } from './content';
import type { Ctx, Principal } from './env';
import { storeImage } from './images';
import { MEDIA_PREFIX } from './public';
import { listMemory, retrieve, type Passage } from './knowledge';
import { eventStream, status, type SseEvent } from './sse';
import { HttpError, newId, now, sleep } from './util';

/** The configured AI provider; its failures come back as clear 502s instead of server errors. */
export function provider(ctx: Ctx): AIProvider {
    const ai = ctx.options.ai?.(ctx.env);
    if (!ai) throw new HttpError(501, 'No AI provider is configured. Set PREDEV_API_KEY.');
    const wrap =
        <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
        async (...a: A): Promise<R> => {
            try {
                return await fn(...a);
            } catch (err) {
                throw failed(err);
            }
        };
    return { ...ai, listModels: wrap(ai.listModels.bind(ai)), text: wrap(ai.text.bind(ai)), image: wrap(ai.image.bind(ai)) };
}

/** A provider failure as people should read it. An abort (the client left) passes through as is. */
function failed(err: any): unknown {
    if (err instanceof HttpError || err?.name === 'AbortError') return err;
    return new HttpError(err?.status === 429 ? 429 : 502, `The AI provider said: ${err?.message ?? 'request failed'}`);
}

/**
 * The model's text as it is written, piece by piece; `onEnd` gets the model
 * and token counts. A provider that cannot stream answers in one piece.
 */
async function* write(ai: AIProvider, request: TextRequest, onEnd: (end: StreamEnd) => void): AsyncGenerator<string> {
    if (!ai.stream) {
        const res = await ai.text(request);
        if (res.text) yield res.text;
        return onEnd({ model: res.model, usage: res.usage });
    }
    const pieces = ai.stream(request)[Symbol.asyncIterator]();
    try {
        for (;;) {
            const step = await pieces.next();
            if (step.done) {
                const end = (step.value ?? {}) as Partial<StreamEnd>;
                return onEnd({ model: end.model ?? request.model ?? '', usage: end.usage ?? {}, finishReason: end.finishReason });
            }
            yield step.value;
        }
    } catch (err) {
        throw failed(err);
    } finally {
        // Stopping early (the client left) closes the provider's connection too.
        await pieces.return?.();
    }
}

export interface WritingJob {
    task: string;
    /** What to look up in the blog and the knowledge sources; none: no passages. */
    query?: string;
    messages: TextMessage[];
    model: string;
    /** The model asked for, when the site default writes instead. */
    requested?: string;
    maxTokens: number;
    temperature?: number;
}

/**
 * The events of one piece of writing: what it read, then the text as it is
 * written. Returns the whole text and how the stream ended, for the done event.
 * The first event names the model that writes, so the page can show it at once.
 */
export async function* compose(ctx: Ctx, ai: AIProvider, job: WritingJob, signal: AbortSignal): AsyncGenerator<SseEvent, { text: string; end: StreamEnd }> {
    yield status('reading', answeredBy(job.model, job));
    const { prompt, sources } = await system(ctx, job.task, job.query ? { query: job.query, ai } : undefined);
    if (job.query) yield { event: 'sources', data: sources.map(p => ({ title: p.title, url: p.url })) };
    yield status('writing');
    let text = '';
    let end: StreamEnd = { model: job.model, usage: {} };
    for await (const t of write(ai, { model: job.model, system: prompt, messages: job.messages, maxTokens: job.maxTokens, temperature: job.temperature, signal }, e => (end = e))) {
        text += t;
        yield { data: { t } };
    }
    return { text, end };
}

/** What a finished stream was charged, sent once the provider has settled it (a few seconds after the text ends). */
export async function* settled(ai: AIProvider, usage: Usage, signal: AbortSignal): AsyncGenerator<SseEvent> {
    if (!ai.usage || !usage.requestId || usage.charged != null) return;
    for (const wait of [1000, 1500, 2500, 3000]) {
        await sleep(wait);
        if (signal.aborted) return;
        const found = await ai.usage(usage.requestId, signal).catch(() => null);
        if (found?.charged != null) {
            yield { event: 'usage', data: { ...usage, charged: found.charged } };
            return;
        }
    }
}

const unfence = (text: string) => text.trim().replace(/^```(?:markdown)?\n?|```$/g, '');

/** "# Title" on the first line becomes the title; the rest is the body. */
function splitTitle(raw: string): { title: string; markdown: string } {
    const text = unfence(raw);
    const m = text.match(/^#\s+(.+)\n+/);
    return { title: m ? m[1].trim() : '', markdown: m ? text.slice(m[0].length).trim() : text };
}

const modelCache = new Map<string, { at: number; list: ModelInfo[] }>();

/** The provider's catalog, kept for ten minutes. */
async function catalog(ctx: Ctx, kind?: ModelKind): Promise<ModelInfo[]> {
    const key = kind ?? 'all';
    const hit = modelCache.get(key);
    if (hit && Date.now() - hit.at < 600_000) return hit.list;
    const list = await provider(ctx).listModels(kind);
    modelCache.set(key, { at: Date.now(), list });
    return list;
}

export async function listModels(ctx: Ctx, kind?: ModelKind) {
    const list = await catalog(ctx, kind);
    // Mark the site's default for each kind, so pickers can show what "default" means. The text
    // catalog also lists some image models, so a model counts as default only for its own kind.
    const s = await aiSettings(ctx.env, ctx.db);
    const defaults: Record<ModelKind, string | null | undefined> = { text: s.textModel, image: s.imageModel, video: s.videoModel, embedding: s.embeddingModel };
    return list.map(m => (defaults[m.kind] === m.id ? { ...m, isDefault: true } : m));
}

export type Chosen = { model: string; requested?: string };

const NO_DEFAULT: Record<'text' | 'image' | 'video', string> = {
    text: 'Choose a text model in Settings, AI.',
    image: 'Choose an image model in Settings, AI.',
    video: 'Choose a video model in Settings, AI.'
};

/**
 * The model for a request: the one asked for when the catalog lists it for this kind, else
 * the site default. A model the catalog doesn't list (or a catalog that can't be read) never
 * fails the request; `requested` then says which model was asked for instead.
 */
export async function chooseModel(ctx: Ctx, kind: 'text' | 'image' | 'video', asked?: unknown): Promise<Chosen> {
    const s = await aiSettings(ctx.env, ctx.db);
    const fallback = kind === 'text' ? s.textModel : kind === 'image' ? s.imageModel : s.videoModel;
    const want = typeof asked === 'string' ? asked.trim() : '';
    if (want && want !== fallback && (await catalog(ctx, kind).catch(() => [])).some(m => m.id === want)) return { model: want };
    if (!fallback) throw new HttpError(400, NO_DEFAULT[kind]);
    return want && want !== fallback ? { model: fallback, requested: want } : { model: fallback };
}

/** Which model answered, for a result or a done event; `requestedModel` only when the one asked for was not used. */
export const answeredBy = (used: string, chosen: Chosen): { model: string; requestedModel?: string } => (chosen.requested ? { model: used, requestedModel: chosen.requested } : { model: used });

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

// ------------------------------------------------------------------ drafts, rewrites, metadata
//
// Each answers in one JSON piece, for API clients, or as server-sent events
// (text as it is written) when the request accepts text/event-stream.

interface DraftInput {
    prompt: string;
    notes?: string;
    /** A text model from the catalog; the site default when absent or not listed. */
    model?: string;
}

function draftJob(input: DraftInput) {
    if (!input.prompt?.trim()) throw new HttpError(400, 'Describe the post you want.');
    return {
        task: 'Write a complete blog post in Markdown. Start with the title as "# Title" on the first line, then the body using ## section headings. Return only the Markdown.',
        query: `${input.prompt}\n${input.notes ?? ''}`,
        messages: [{ role: 'user' as const, content: `${input.prompt.trim()}${input.notes ? `\n\nSource material:\n${input.notes}` : ''}` }],
        maxTokens: 6000
    };
}

export async function draft(ctx: Ctx, input: DraftInput) {
    const job = draftJob(input);
    const ai = provider(ctx);
    const chosen = await chooseModel(ctx, 'text', input.model);
    const { prompt } = await system(ctx, job.task, { query: job.query, ai });
    const res = await ai.text({ model: chosen.model, system: prompt, messages: job.messages, maxTokens: job.maxTokens });
    return { ...splitTitle(res.text), ...answeredBy(res.model, chosen), usage: res.usage };
}

export async function draftStream(ctx: Ctx, input: DraftInput, client?: AbortSignal): Promise<Response> {
    const job = draftJob(input);
    const ai = provider(ctx);
    const chosen = await chooseModel(ctx, 'text', input.model);
    return eventStream(async function* (signal) {
        const { text, end } = yield* compose(ctx, ai, { ...job, ...chosen }, signal);
        yield { event: 'done', data: { ...splitTitle(text), ...answeredBy(end.model, chosen), usage: end.usage, finishReason: end.finishReason } };
        yield* settled(ai, end.usage, signal);
    }, client);
}

interface EditInput {
    markdown: string;
    instruction?: string;
    model?: string;
}

function editJob(input: EditInput) {
    if (!input.markdown?.trim()) throw new HttpError(400, 'Select some text first.');
    return {
        task: 'Rewrite the Markdown you are given according to the instruction. Keep facts, links and formatting unless told otherwise. Return only the rewritten Markdown.',
        messages: [{ role: 'user' as const, content: `Instruction: ${input.instruction || 'Tighten it.'}\n\nMarkdown:\n${input.markdown}` }],
        maxTokens: 3000
    };
}

export async function edit(ctx: Ctx, input: EditInput) {
    const job = editJob(input);
    const chosen = await chooseModel(ctx, 'text', input.model);
    const res = await provider(ctx).text({ model: chosen.model, system: (await system(ctx, job.task)).prompt, messages: job.messages, maxTokens: job.maxTokens });
    return { markdown: unfence(res.text), ...answeredBy(res.model, chosen), usage: res.usage };
}

export async function editStream(ctx: Ctx, input: EditInput, client?: AbortSignal): Promise<Response> {
    const job = editJob(input);
    const ai = provider(ctx);
    const chosen = await chooseModel(ctx, 'text', input.model);
    return eventStream(async function* (signal) {
        const { text, end } = yield* compose(ctx, ai, { ...job, ...chosen }, signal);
        yield { event: 'done', data: { markdown: unfence(text), ...answeredBy(end.model, chosen), usage: end.usage, finishReason: end.finishReason } };
        yield* settled(ai, end.usage, signal);
    }, client);
}

interface MetaInput {
    title?: string;
    markdown: string;
    model?: string;
    /** What people search for when the post shows in Google, most searched first (from Search Console). */
    searches?: unknown;
    /** The search title and description it has now, when they draw fewer clicks than its position should. */
    current?: { title?: unknown; description?: unknown };
}

// One suggestion per line, so each shows up as soon as its line is written.
function metaJob(input: MetaInput) {
    const searches = Array.isArray(input.searches) ? input.searches.map(s => String(s).replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean).slice(0, 8) : [];
    const now = input.current && typeof input.current === 'object' ? input.current : null;
    const context = [
        searches.length
            ? `People find this post by searching Google for these words, most searched first:\n${searches.map(s => `- ${s}`).join('\n')}\nUse the words they search with, so the result is plainly the one to click for them. Promise only what the post delivers.`
            : '',
        now && (now.title || now.description)
            ? `Its search result gets fewer clicks than its position should bring. It shows now as:\nTitle: ${String(now.title ?? '').slice(0, 200)}\nDescription: ${String(now.description ?? '').slice(0, 400)}\nWrite clearly better options, not rewordings.`
            : ''
    ].filter(Boolean);
    return {
        task: 'Suggest search and share metadata for the post. Reply with seven lines and nothing else: three lines that start "TITLE: " (titles, at most 60 characters each), three that start "DESCRIPTION: " (search descriptions, at most 155 characters each), then one that starts "EXCERPT: " (one or two sentences for the post listing). No quotes, no numbering.',
        messages: [{ role: 'user' as const, content: `${context.length ? `${context.join('\n\n')}\n\n` : ''}Current title: ${input.title ?? ''}\n\n${(input.markdown ?? '').slice(0, 12000)}` }],
        // Seven short lines, but a reasoning model thinks first and that counts too: at 800 some wrote nothing.
        maxTokens: 3000
    };
}

/** Reads the TITLE:, DESCRIPTION: and EXCERPT: lines, forgiving numbering, bold and quotes. */
export function parseMeta(text: string): { titles: string[]; descriptions: string[]; excerpt: string } {
    const out = { titles: [] as string[], descriptions: [] as string[], excerpt: '' };
    for (const line of text.split('\n')) {
        const m = line.replace(/^[\s>*_\-\d.)]+/, '').match(/^(title|description|excerpt)\**\s*:\s*\**\s*(.+)$/i);
        const value = m?.[2].replace(/\**$/, '').trim().replace(/^["“](.*)["”]$/, '$1').trim();
        if (!m || !value) continue;
        const kind = m[1].toLowerCase();
        if (kind === 'title') out.titles.push(value);
        else if (kind === 'description') out.descriptions.push(value);
        else out.excerpt ||= value;
    }
    return out;
}

export async function meta(ctx: Ctx, input: MetaInput) {
    const job = metaJob(input);
    const chosen = await chooseModel(ctx, 'text', input.model);
    const res = await provider(ctx).text({ model: chosen.model, system: (await system(ctx, job.task)).prompt, messages: job.messages, maxTokens: job.maxTokens });
    const found = parseMeta(res.text);
    if (!found.titles.length && !found.descriptions.length && !found.excerpt) throw new HttpError(502, 'The model answered in the wrong shape. Try again.');
    return { ...found, ...answeredBy(res.model, chosen), usage: res.usage };
}

export async function metaStream(ctx: Ctx, input: MetaInput, client?: AbortSignal): Promise<Response> {
    const job = metaJob(input);
    const ai = provider(ctx);
    const chosen = await chooseModel(ctx, 'text', input.model);
    return eventStream(async function* (signal) {
        const { text, end } = yield* compose(ctx, ai, { ...job, ...chosen }, signal);
        yield { event: 'done', data: { ...parseMeta(text), ...answeredBy(end.model, chosen), usage: end.usage, finishReason: end.finishReason } };
        yield* settled(ai, end.usage, signal);
    }, client);
}

// ------------------------------------------------------------------ images

interface ImageInput {
    prompt: string;
    aspectRatio?: AspectRatio;
    model?: string;
    reference?: string;
}

async function imageModel(ctx: Ctx, input: ImageInput): Promise<Chosen> {
    if (!input.prompt?.trim()) throw new HttpError(400, 'Describe the image.');
    return chooseModel(ctx, 'image', input.model);
}

async function keepImage(ctx: Ctx, res: ImageResult): Promise<string> {
    const ext = res.mimeType === 'image/png' ? 'png' : res.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const d = new Date();
    const rel = `content/images/ai/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${newId()}.${ext}`;
    await storeImage(ctx.env, ctx.db, rel, res.bytes, res.mimeType, `ai:${res.model}`);
    return `${ctx.basePath}${rel}`;
}

export async function image(ctx: Ctx, input: ImageInput) {
    const chosen = await imageModel(ctx, input);
    const references = input.reference ? [await asDataUrl(ctx, input.reference)] : undefined;
    const res = await provider(ctx).image({ model: chosen.model, prompt: input.prompt, aspectRatio: input.aspectRatio ?? '16:9', references });
    return { url: await keepImage(ctx, res), ...answeredBy(res.model, chosen), usage: res.usage };
}

/**
 * An image can't be written piece by piece, so this streams where the work is:
 * reading the image to edit, painting (with rough previews from models that
 * send them), saving, then the address of the result.
 */
export async function imageStream(ctx: Ctx, input: ImageInput, client?: AbortSignal): Promise<Response> {
    const chosen = await imageModel(ctx, input);
    const model = chosen.model;
    const ai = provider(ctx);
    return eventStream(async function* (signal) {
        let references: string[] | undefined;
        if (input.reference) {
            yield status('reading', answeredBy(model, chosen));
            references = [await asDataUrl(ctx, input.reference)];
        }
        yield status('painting', answeredBy(model, chosen));
        const previews: string[] = [];
        let wake = () => {};
        const sendsPreviews = (await catalog(ctx, 'image').catch(() => [])).some(m => m.id === model && m.supports?.streaming);
        const job = ai.image({
            model,
            prompt: input.prompt,
            aspectRatio: input.aspectRatio ?? '16:9',
            references,
            signal,
            onPreview: sendsPreviews ? p => (previews.push(p.dataUrl), wake()) : undefined
        });
        let finished = false;
        const over = job.then(
            () => void (finished = true),
            () => void (finished = true)
        );
        while (!finished) {
            await Promise.race([over, new Promise<void>(resolve => (wake = resolve))]);
            while (previews.length) yield { event: 'preview', data: { src: previews.shift() } };
        }
        const res = await job;
        yield status('saving');
        yield { event: 'done', data: { url: await keepImage(ctx, res), ...answeredBy(res.model, chosen), usage: res.usage } };
    }, client);
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
    /** A text model from the catalog; the site default when absent or not listed. */
    model?: string;
}

const TASKS: Record<AssistMode, string> = {
    chat: 'You are the writing partner inside the blog editor. Answer the writer directly and briefly. When you draft text for the post, give it as Markdown the writer can insert as is, without commentary around it.',
    edit: 'Rewrite the selected passage according to the instruction. Keep facts, links and formatting unless told otherwise. Reply with only the rewritten Markdown, nothing else.',
    write: 'Write what the instruction asks for, to insert at the cursor of the post. It must read naturally with the text around it. Reply with only the Markdown to insert.',
    continue: 'Continue the post from the cursor for one to three paragraphs, in the same voice, moving the argument forward. Reply with only the Markdown to insert.'
};

/** Streams the assistant's reply as server-sent events: what it read, the text as it is written, then done. */
export async function assist(ctx: Ctx, input: AssistInput, client?: AbortSignal): Promise<Response> {
    const ai = provider(ctx);
    const mode: AssistMode = TASKS[input.mode] ? input.mode : 'chat';
    const clip = (s: string | undefined, n: number, fromEnd = false) => (!s ? '' : s.length <= n ? s : fromEnd ? s.slice(-n) : s.slice(0, n));
    const lastUser = [...(input.messages ?? [])].reverse().find(m => m.role === 'user')?.content ?? '';
    // What to look up: the request, plus the text just before the cursor so "continue" finds the topic at hand.
    const query = [input.instruction, input.selection, lastUser, input.title, mode === 'continue' || mode === 'write' ? clip(input.before, 1200, true) : ''].filter(Boolean).join('\n').slice(0, 2400);

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
    const chosen = await chooseModel(ctx, 'text', input.model);
    // The headers go out now; looking up passages happens inside the stream, so the client sees "reading" at once.
    return eventStream(async function* (signal) {
        const { end } = yield* compose(ctx, ai, { task: TASKS[mode], query: query || clip(input.post, 1500), messages, ...chosen, maxTokens: mode === 'chat' ? 3000 : 2500, temperature: 0.6 }, signal);
        yield { event: 'done', data: { ...answeredBy(end.model, chosen), usage: end.usage, finishReason: end.finishReason } };
        yield* settled(ai, end.usage, signal);
    }, client);
}

// ------------------------------------------------------------------ video

export async function startVideo(ctx: Ctx, input: { prompt: string; model?: string; aspectRatio?: string; duration?: number; reference?: string }, by: Principal) {
    const ai = provider(ctx);
    if (!ai.video) throw new HttpError(501, 'The AI provider cannot make video.');
    if (!input.prompt?.trim()) throw new HttpError(400, 'Describe the video.');
    const chosen = await chooseModel(ctx, 'video', input.model);
    const model = chosen.model;
    // "Animate this image": the still becomes the clip's first frame.
    const firstFrame = input.reference ? await asDataUrl(ctx, input.reference) : undefined;
    const job = await ai.video.submit({ model, prompt: input.prompt.trim(), aspectRatio: input.aspectRatio ?? '16:9', duration: input.duration, firstFrame });
    const id = newId();
    const t = now();
    await ctx.db
        .prepare('INSERT INTO ai_jobs (id, kind, provider_id, status, prompt, model, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, 'video', job.id, job.status, input.prompt.trim(), model, by.staffId, t, t)
        .run();
    return { id, status: job.status, ...answeredBy(model, chosen) };
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

async function ideaFor(ctx: Ctx, id: string) {
    const idea = await ctx.db.prepare('SELECT * FROM ideas WHERE id = ?').bind(id).first<any>();
    if (!idea) throw new HttpError(404, 'Idea not found.');
    return idea;
}

function ideaDraftInput(idea: any): DraftInput {
    const sources = JSON.parse(idea.sources || '[]') as { title?: string; url?: string; summary?: string }[];
    const notes = sources.map(s => `- ${s.title ?? ''}${s.url ? ` (${s.url})` : ''}${s.summary ? `: ${s.summary}` : ''}`).join('\n');
    return { prompt: `Write the post "${idea.title}". Angle: ${idea.angle ?? 'your call'}.${idea.series ? ` Series: ${idea.series}.` : ''}`, notes };
}

/** Saves the text as a new draft post for the idea, and marks the idea drafted. */
async function keepIdeaDraft(ctx: Ctx, idea: any, by: Principal, d: { title?: string; markdown: string }) {
    const post = await savePost(ctx.db, { title: d.title || idea.title, markdown: d.markdown, bodyFormat: 'markdown', status: 'draft', type: 'post' }, { defaultAuthorId: by.staffId.startsWith('key:') ? undefined : by.staffId });
    await ctx.db.prepare("UPDATE ideas SET status = 'drafted', post_id = ?, updated_at = ? WHERE id = ?").bind(post.id, now(), idea.id).run();
    return post;
}

export async function draftIdea(ctx: Ctx, id: string, by: Principal, model?: string) {
    const idea = await ideaFor(ctx, id);
    const d = await draft(ctx, { ...ideaDraftInput(idea), model });
    return { post: await keepIdeaDraft(ctx, idea, by, d), model: d.model, requestedModel: d.requestedModel };
}

/** Text someone already has (say, a draft they stopped part way) saved as the idea's draft. */
export async function saveIdeaDraft(ctx: Ctx, id: string, by: Principal, d: { title?: string; markdown?: string }) {
    if (!d.markdown?.trim()) throw new HttpError(400, 'There is no text to save.');
    return { post: await keepIdeaDraft(ctx, await ideaFor(ctx, id), by, { title: d.title?.trim(), markdown: d.markdown }) };
}

/** Writes the idea's draft as events, then saves it as a post once the model finishes. Stopping early saves nothing. */
export async function draftIdeaStream(ctx: Ctx, id: string, by: Principal, client?: AbortSignal, model?: string): Promise<Response> {
    const idea = await ideaFor(ctx, id);
    const job = draftJob(ideaDraftInput(idea));
    const ai = provider(ctx);
    const chosen = await chooseModel(ctx, 'text', model);
    return eventStream(async function* (signal) {
        const { text, end } = yield* compose(ctx, ai, { ...job, ...chosen }, signal);
        const d = splitTitle(text);
        if (!d.markdown.trim()) throw new HttpError(502, 'The model wrote nothing. Try again.');
        yield status('saving');
        const post = await keepIdeaDraft(ctx, idea, by, d);
        yield { event: 'done', data: { ...d, post: { id: post.id, slug: post.slug, title: post.title }, ...answeredBy(end.model, chosen), usage: end.usage, finishReason: end.finishReason } };
        yield* settled(ai, end.usage, signal);
    }, client);
}
