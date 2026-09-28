/**
 * pre.dev AI: list models and generate text and images with one pre.dev API key.
 *
 * Create a key in the pre.dev dashboard under Integrations -> API Keys.
 * Catalog reads are free; generation is charged in pre.dev credits, reported
 * per call in the x-predev-credits-* response headers.
 * API reference: https://docs.pre.dev/ai-gateway/overview
 */
import type { AIProvider, EmbeddingResult, ImageRequest, ImageResult, ModelInfo, ModelKind, TextRequest, TextResult, Usage, VideoJob, VideoRequest } from '@masthead/core';

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

    async function call(path: string, init: RequestInit = {}): Promise<{ body: any; usage: Usage }> {
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${key()}`);
        headers.set('accept', 'application/json');
        if (init.body) headers.set('content-type', 'application/json');
        if (options.projectId) headers.set('x-predev-project-id', options.projectId);

        const res = await doFetch(`${baseUrl}${path}`, { ...init, headers });
        const text = await res.text();
        let body: any = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = null;
        }
        if (!res.ok) {
            const err = body?.error ?? body ?? {};
            const message = typeof err.message === 'string' ? err.message : `pre.dev AI returned ${res.status}`;
            const retry = Number(res.headers.get('retry-after'));
            throw new PredevAIError(res.status, err.code, message, Number.isFinite(retry) && retry > 0 ? retry : undefined);
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
                            supports: supports(row)
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
                })
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
            const { body, usage } = await call('/images', {
                method: 'POST',
                body: JSON.stringify({ model, prompt: request.prompt, aspect_ratio: request.aspectRatio, input_references: request.references?.length ? request.references.map(imageRef) : undefined })
            });
            const first = body?.data?.[0];
            let bytes: Uint8Array;
            if (typeof first?.b64_json === 'string') {
                bytes = Uint8Array.from(atob(first.b64_json), c => c.charCodeAt(0));
            } else if (typeof first?.url === 'string') {
                const res = await doFetch(first.url);
                if (!res.ok) throw new PredevAIError(res.status, undefined, `Could not download the generated image (${res.status}).`);
                bytes = new Uint8Array(await res.arrayBuffer());
            } else {
                throw new PredevAIError(502, undefined, 'The image response had no image data.');
            }
            return { bytes, mimeType: sniffImageType(bytes), model: String(body?.model ?? model), usage };
        },

        async *stream(request: TextRequest): AsyncIterable<string> {
            const model = request.model ?? options.textModel;
            if (!model) throw new Error('No text model. Pass model, or set textModel on predevAI().');
            const headers = new Headers({ authorization: `Bearer ${key()}`, 'content-type': 'application/json', accept: 'text/event-stream' });
            if (options.projectId) headers.set('x-predev-project-id', options.projectId);
            const res = await doFetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model,
                    stream: true,
                    messages: [...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages],
                    max_tokens: request.maxTokens,
                    temperature: request.temperature
                })
            });
            if (!res.ok || !res.body) {
                const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
                throw new PredevAIError(res.status, body?.error?.code, body?.error?.message ?? `pre.dev AI returned ${res.status}`);
            }
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += value;
                let nl: number;
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') return;
                    try {
                        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
                        if (typeof delta === 'string' && delta) yield delta;
                    } catch {
                        // Keep-alive comments and partial frames are skipped.
                    }
                }
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

/** The parameters a media model's catalog row says it accepts. */
function supports(row: any): ModelInfo['supports'] {
    const list = (v: unknown) => (Array.isArray(v) && v.length ? v : undefined);
    const out = {
        durations: list(row.supported_durations)?.filter((d: unknown): d is number => typeof d === 'number').sort((a: number, b: number) => a - b),
        aspectRatios: list(row.supported_aspect_ratios),
        resolutions: list(row.supported_resolutions),
        frameImages: list(row.supported_frame_images)
    };
    return Object.values(out).some(Boolean) ? out : undefined;
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
