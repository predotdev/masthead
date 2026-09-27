/**
 * pre.dev AI: list models and generate text and images with one pre.dev API key.
 *
 * Create a key in the pre.dev dashboard under Integrations -> API Keys.
 * Catalog reads are free; generation is charged in pre.dev credits, reported
 * per call in the x-predev-credits-* response headers.
 * API reference: https://docs.pre.dev/ai-gateway/overview
 */
import type { AIProvider, ImageRequest, ImageResult, ModelInfo, ModelKind, TextRequest, TextResult, Usage } from '@masthead/core';

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
                            price: row.predev && typeof row.predev === 'object' ? numericFields(row.predev) : undefined
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
                body: JSON.stringify({ model, prompt: request.prompt, aspect_ratio: request.aspectRatio })
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
        }
    };
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
