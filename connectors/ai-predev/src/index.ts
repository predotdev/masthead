/**
 * pre.dev AI: list models and generate text and images with one pre.dev API key.
 *
 * Create a key in the pre.dev dashboard under Integrations -> API Keys.
 * Catalog reads are free; generation is charged in pre.dev credits, reported
 * per call in the x-predev-credits-* response headers. A stream's charge
 * settles after it ends and is read back with usage(requestId).
 * API reference: https://docs.pre.dev/ai-gateway/overview
 */
import type { AIProvider, EmbeddingResult, ImageRequest, ImageResult, ModelInfo, ModelKind, StreamEnd, TextRequest, TextResult, Usage, VideoJob, VideoRequest } from '@masthead/core';

export interface PredevAIOptions {
    /** Defaults to the PREDEV_API_KEY environment variable. */
    apiKey?: string;
    /** Defaults to https://api.pre.dev/v1 */
    baseUrl?: string;
    /** Attribute usage to one of your pre.dev projects. */
    projectId?: string;
    /** Model used when a request names none. Pick one with `masthead models`. */
    textModel?: string;
    imageModel?: string;
    videoModel?: string;
    embeddingModel?: string;
    fetch?: typeof fetch;
}

export class PredevAIError extends Error {
    constructor(
        readonly status: number,
        readonly code: string | undefined,
        message: string,
        readonly retryAfterSeconds?: number
    ) {
        super(message);
        this.name = 'PredevAIError';
    }
}

const CATALOG_PATHS: Record<ModelKind, string> = {
    text: '/models',
    image: '/images/models',
    video: '/videos/models',
    embedding: '/embeddings/models'
};

export function predevAI(options: PredevAIOptions = {}): AIProvider {
    const baseUrl = (options.baseUrl ?? 'https://api.pre.dev/v1').replace(/\/+$/, '');
    const doFetch = options.fetch ?? fetch;

    function key(): string {
        const value = options.apiKey ?? (globalThis as any).process?.env?.PREDEV_API_KEY;
        if (!value) {
            throw new Error('No pre.dev API key. Set PREDEV_API_KEY or pass apiKey. Create one under Integrations -> API Keys.');
        }
        return value;
    }

    function headersFor(accept: string, json: boolean): Headers {
        const headers = new Headers({ authorization: `Bearer ${key()}`, accept });
        if (json) headers.set('content-type', 'application/json');
        if (options.projectId) headers.set('x-predev-project-id', options.projectId);
        return headers;
    }

    async function call(path: string, init: RequestInit = {}): Promise<{ body: any; usage: Usage }> {
        const res = await doFetch(`${baseUrl}${path}`, { ...init, headers: headersFor('application/json', Boolean(init.body)) });
        if (!res.ok) throw await failure(res);
        const text = await res.text();
        let body: any = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = null;
        }
        const charged = res.headers.get('x-predev-credits-charged');
        const remaining = res.headers.get('x-predev-credits-remaining');
        return {
            body,
            usage: {
                charged: charged == null ? undefined : Number(charged),
                remaining: remaining == null ? null : Number(remaining),
                requestId: res.headers.get('x-predev-request-id') ?? undefined
            }
        };
    }

    /** Opens a server-sent event stream; the gateway answers errors before it starts as plain JSON. */
    async function open(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
        const res = await doFetch(`${baseUrl}${path}`, { method: 'POST', headers: headersFor('text/event-stream', true), body: JSON.stringify(body), signal });
        if (!res.ok || !res.body) throw await failure(res);
        return res;
    }

    /** Turns image data from the API (base64, or a URL to fetch) into bytes. */
    async function imageBytes(item: any, signal?: AbortSignal): Promise<Uint8Array> {
        if (typeof item?.b64_json === 'string') return fromBase64(item.b64_json);
        if (typeof item?.url === 'string') {
            const res = await doFetch(item.url, { signal });
            if (!res.ok) throw new PredevAIError(res.status, undefined, `Could not download the generated image (${res.status}).`);
            return new Uint8Array(await res.arrayBuffer());
        }
        throw new PredevAIError(502, undefined, 'The image response had no image data.');
    }

    return {
        id: 'predev',

        async listModels(kind?: ModelKind): Promise<ModelInfo[]> {
            const kinds = kind ? [kind] : (Object.keys(CATALOG_PATHS) as ModelKind[]);
            const lists = await Promise.all(
                kinds.map(async k => {
                    const { body } = await call(CATALOG_PATHS[k]);
                    const rows: any[] = Array.isArray(body?.data) ? body.data : [];
                    return rows.map(
                        (row): ModelInfo => ({
                            id: String(row.id),
                            name: String(row.name ?? row.id),
                            kind: k,
                            contextLength: typeof row.context_length === 'number' ? row.context_length : undefined,
                            price: row.predev && typeof row.predev === 'object' ? numericFields(row.predev) : undefined,
                            supports: supports(row, k),
                            released: typeof row.created === 'number' ? new Date(row.created * 1000).toISOString() : undefined,
                            score: typeof row.benchmarks?.artificial_analysis?.intelligence_index === 'number' ? row.benchmarks.artificial_analysis.intelligence_index : undefined,
                            aliasOf: typeof row.alias_target?.slug === 'string' ? { id: row.alias_target.slug, name: String(row.alias_target.name ?? row.alias_target.slug) } : undefined,
                            retires: typeof row.expiration_date === 'string' ? row.expiration_date : undefined
                        })
                    );
                })
            );
            return lists.flat();
        },

        async text(request: TextRequest): Promise<TextResult> {
            const model = request.model ?? options.textModel;
            if (!model) throw new Error('No text model. Pass model, or set textModel on predevAI().');
            const messages = [
                ...(request.system ? [{ role: 'system', content: request.system }] : []),
                ...request.messages
            ];
            const { body, usage } = await call('/chat/completions', {
                method: 'POST',
                body: JSON.stringify({
                    model,
                    messages,
                    max_tokens: request.maxTokens,
                    temperature: request.temperature,
                    response_format: request.json ? { type: 'json_object' } : undefined
                }),
                signal: request.signal
            });
            const content = body?.choices?.[0]?.message?.content;
            const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? '').join('') : '';
            return {
                text,
                model: String(body?.model ?? model),
                usage: {
                    ...usage,
                    inputTokens: body?.usage?.prompt_tokens,
                    outputTokens: body?.usage?.completion_tokens
                }
            };
        },

        async image(request: ImageRequest): Promise<ImageResult> {
            const model = request.model ?? options.imageModel;
            if (!model) throw new Error('No image model. Pass model, or set imageModel on predevAI().');
            const payload = { model, prompt: request.prompt, aspect_ratio: request.aspectRatio, input_references: request.references?.length ? request.references.map(imageRef) : undefined };
            if (!request.onPreview) {
                const { body, usage } = await call('/images', { method: 'POST', body: JSON.stringify(payload), signal: request.signal });
                const bytes = await imageBytes(body?.data?.[0], request.signal);
                return { bytes, mimeType: sniffImageType(bytes), model: String(body?.model ?? model), usage };
            }
            // Models that stream send rough versions while they paint, then the image.
            const res = await open('/images', { ...payload, stream: true, partial_images: 2 }, request.signal);
            const requestId = res.headers.get('x-predev-request-id') ?? undefined;
            if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
                const body = (await res.json()) as any;
                const bytes = await imageBytes(body?.data?.[0], request.signal);
                return { bytes, mimeType: sniffImageType(bytes), model: String(body?.model ?? model), usage: { requestId } };
            }
            let final: any = null;
            let previews = 0;
            for await (const data of events(res.body!)) {
                if (data === '[DONE]') break;
                const event = parse(data);
                if (event?.error) throw streamError(event.error);
                if (typeof event?.b64_json !== 'string') continue;
                if (String(event.type ?? '').includes('partial')) request.onPreview({ dataUrl: `data:${base64Type(event.b64_json)};base64,${event.b64_json}`, index: Number(event.partial_image_index ?? previews++) });
                else final = event;
            }
            if (!final) throw new PredevAIError(502, undefined, 'The image stream ended without an image.');
            const bytes = await imageBytes(final, request.signal);
            return {
                bytes,
                mimeType: sniffImageType(bytes),
                model,
                usage: { requestId, inputTokens: final.usage?.prompt_tokens, outputTokens: final.usage?.completion_tokens }
            };
        },

        async *stream(request: TextRequest): AsyncGenerator<string, StreamEnd> {
            const model = request.model ?? options.textModel;
            if (!model) throw new Error('No text model. Pass model, or set textModel on predevAI().');
            const res = await open(
                '/chat/completions',
                {
                    model,
                    stream: true,
                    messages: [...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages],
                    max_tokens: request.maxTokens,
                    temperature: request.temperature
                },
                request.signal
            );
            let id: string | undefined;
            let used = model;
            let tokens: any = null;
            let finish: string | undefined;
            let ended = false;
            for await (const data of events(res.body!)) {
                if (data === '[DONE]') {
                    ended = true;
                    break;
                }
                const chunk = parse(data);
                if (!chunk) continue;
                if (chunk.error) throw streamError(chunk.error);
                if (typeof chunk.id === 'string') id ??= chunk.id;
                if (typeof chunk.model === 'string') used = chunk.model;
                if (chunk.usage) tokens = chunk.usage;
                const choice = chunk.choices?.[0];
                if (choice?.finish_reason) finish = String(choice.finish_reason);
                if (finish === 'error') throw new PredevAIError(502, 'model_error', 'The model stopped with an error.');
                const delta = choice?.delta?.content;
                if (typeof delta === 'string' && delta) yield delta;
            }
            // A stream that stops without saying so was cut off, not finished.
            if (!ended && !finish) throw new PredevAIError(502, 'incomplete', 'The answer was cut off before it finished.');
            return {
                model: used,
                finishReason: finish,
                // The generation id (pdg-...) is what the charge is looked up by.
                usage: { inputTokens: tokens?.prompt_tokens, outputTokens: tokens?.completion_tokens, requestId: id ?? res.headers.get('x-predev-request-id') ?? undefined }
            };
        },

        async usage(requestId: string, signal?: AbortSignal): Promise<Usage | null> {
            try {
                const { body } = await call(`/generation?id=${encodeURIComponent(requestId)}`, { signal });
                const row = body?.data;
                if (typeof row?.credits !== 'number') return null;
                return { charged: row.credits, requestId, inputTokens: row.native_tokens_prompt ?? row.tokens_prompt ?? undefined, outputTokens: row.native_tokens_completion ?? row.tokens_completion ?? undefined };
            } catch (err) {
                // Stats take a few seconds to appear after a call.
                if (err instanceof PredevAIError && err.status === 404) return null;
                throw err;
            }
        },

        async embed(input: string[], model?: string): Promise<EmbeddingResult> {
            const use = model ?? options.embeddingModel;
            if (!use) throw new Error('No embedding model. Pass model, or set embeddingModel on predevAI().');
            const { body, usage } = await call('/embeddings', { method: 'POST', body: JSON.stringify({ model: use, input }) });
            const rows: any[] = Array.isArray(body?.data) ? body.data : [];
            const vectors = rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(r => r.embedding as number[]);
            return { vectors, model: String(body?.model ?? use), usage };
        },

        video: {
            async submit(request: VideoRequest): Promise<VideoJob> {
                const model = request.model ?? options.videoModel;
                if (!model) throw new Error('No video model. Pass model, or set videoModel on predevAI().');
                const { body } = await call('/videos', {
                    method: 'POST',
                    body: JSON.stringify({
                        model,
                        prompt: request.prompt,
                        aspect_ratio: request.aspectRatio,
                        duration: request.duration,
                        frame_images: request.firstFrame ? [{ ...imageRef(request.firstFrame), frame_type: 'first_frame' }] : undefined,
                        input_references: request.references?.length ? request.references.map(imageRef) : undefined
                    })
                });
                return videoJob(body, jobIdOf(body));
            },
            async status(id: string): Promise<VideoJob> {
                const { body } = await call(`/videos/${encodeURIComponent(id)}`);
                return videoJob(body, id);
            },
            async content(id: string): Promise<Uint8Array> {
                const res = await doFetch(`${baseUrl}/videos/${encodeURIComponent(id)}/content`, { headers: { authorization: `Bearer ${key()}` } });
                if (!res.ok) throw new PredevAIError(res.status, undefined, `The video is not ready (${res.status}).`);
                return new Uint8Array(await res.arrayBuffer());
            }
        }
    };
}

/** The error in a failed response, with the gateway's message and any retry-after. */
async function failure(res: Response): Promise<PredevAIError> {
    const body: any = await res.json().catch(() => null);
    const err = body?.error ?? body ?? {};
    const message = typeof err.message === 'string' ? err.message : `pre.dev AI returned ${res.status}`;
    const retry = Number(res.headers.get('retry-after'));
    return new PredevAIError(res.status, err.code, message, Number.isFinite(retry) && retry > 0 ? retry : undefined);
}

/** An error the gateway sends inside a stream that has already started. */
function streamError(err: any): PredevAIError {
    const status = Number(err?.status ?? err?.code);
    return new PredevAIError(Number.isInteger(status) && status >= 400 ? status : 502, typeof err?.code === 'string' ? err.code : undefined, String(err?.message ?? 'The model stopped with an error.'));
}

/**
 * The data of each server-sent event, in order. Comments (the gateway's
 * keep-alives), event names and ids carry nothing used here. Stopping early
 * closes the connection.
 */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let scanned = 0;
    let data: string[] = [];
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            // Scan only what's new: a partial image is one data line of a megabyte or more.
            while ((nl = buffer.indexOf('\n', scanned)) >= 0) {
                const line = buffer.slice(0, nl).replace(/\r$/, '');
                buffer = buffer.slice(nl + 1);
                scanned = 0;
                if (line === '') {
                    if (data.length) yield data.join('\n');
                    data = [];
                } else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
            }
            scanned = buffer.length;
        }
        if (data.length) yield data.join('\n');
    } finally {
        reader.cancel().catch(() => {});
    }
}

function parse(data: string): any {
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/** The image type of base64 data, from its first bytes. */
function base64Type(b64: string): string {
    return b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('UklGR') ? 'image/webp' : b64.startsWith('R0lGOD') ? 'image/gif' : 'image/png';
}

/** The id to poll a job by: the last segment of its polling_url (the documented address), else its id. */
function jobIdOf(body: any): string {
    const url = typeof body?.polling_url === 'string' ? body.polling_url.replace(/\/+$/, '') : '';
    return (url && decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))) || String(body?.id ?? '');
}

/** Maps a provider job body onto the four states callers act on. */
function videoJob(body: any, id?: string): VideoJob {
    const raw = String(body?.status ?? 'queued').toLowerCase();
    const status: VideoJob['status'] = /complete|succeed|done|finished/.test(raw) ? 'completed' : /fail|error|cancel|expire/.test(raw) ? 'failed' : /run|process|progress|generat/.test(raw) ? 'running' : 'queued';
    return { id: String(id || body?.id || ''), status, error: status === 'failed' ? String(body?.error?.message ?? body?.error ?? 'The video could not be made.') : undefined };
}

/** An image for the API: a URL or data: URL in the image_url shape. */
function imageRef(url: string) {
    return { type: 'image_url', image_url: { url } };
}

/**
 * The parameters a media model's catalog row says it accepts. Video rows list them as
 * supported_*; image rows describe them under supported_parameters.
 */
function supports(row: any, kind: ModelKind): ModelInfo['supports'] {
    const list = (v: unknown) => (Array.isArray(v) && v.length ? v : undefined);
    const params = row.supported_parameters && !Array.isArray(row.supported_parameters) ? row.supported_parameters : {};
    const choices = (p: any) => (p?.type === 'enum' ? list(p.values)?.filter((v: unknown) => typeof v === 'string' && v !== 'auto') : undefined);
    const refs = params.input_references;
    const out = {
        durations: list(row.supported_durations)?.filter((d: unknown): d is number => typeof d === 'number').sort((a: number, b: number) => a - b),
        aspectRatios: list(row.supported_aspect_ratios) ?? choices(params.aspect_ratio),
        resolutions: list(row.supported_resolutions) ?? choices(params.resolution),
        frameImages: list(row.supported_frame_images),
        streaming: row.supports_streaming === true || undefined,
        references: kind !== 'image' ? undefined : typeof refs?.max === 'number' ? refs.max > 0 : Array.isArray(row.architecture?.input_modalities) ? row.architecture.input_modalities.includes('image') : undefined,
        audio: row.generate_audio === true || undefined
    };
    return Object.values(out).some(v => v !== undefined) ? out : undefined;
}

function numericFields(obj: Record<string, unknown>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'number') out[k] = v;
    return out;
}

function sniffImageType(b: Uint8Array): string {
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
    if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
    return 'application/octet-stream';
}
