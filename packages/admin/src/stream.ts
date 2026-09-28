import { base, session } from './api';

export interface Source {
    title: string;
    url: string | null;
}

export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    /** Credits, known a few seconds after the result. */
    charged?: number;
    requestId?: string;
}

export interface StreamHandlers {
    /** Text as the model writes it. */
    text?: (piece: string) => void;
    /** What the server is doing: reading, writing, painting or saving. */
    stage?: (stage: string) => void;
    sources?: (sources: Source[]) => void;
    /** A rough version of an image being painted, as a data: URL. */
    preview?: (src: string) => void;
    usage?: (usage: Usage) => void;
}

export class StreamError extends Error {
    constructor(
        message: string,
        readonly status = 0
    ) {
        super(message);
    }
}

/**
 * Calls an AI route for server-sent events and hands each one out as it
 * arrives. Resolves with the done event's data as soon as it comes; the
 * charge may follow a few seconds later (see usage). Aborting the signal
 * also stops the work on the server.
 */
export async function streamAi<T = Record<string, unknown>>(path: string, body: unknown, on: StreamHandlers, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${base}admin/api${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-masthead': '1' },
        body: JSON.stringify(body),
        signal
    });
    if (res.status === 401) {
        session.value = null;
        throw new StreamError('Sign in to continue.', 401);
    }
    if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new StreamError(data?.error ?? `The AI is unavailable (${res.status}).`, res.status);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    return new Promise<T>((resolve, reject) => {
        let finished = false;
        const handle = (event: string, data: any) => {
            if (event === 'status') on.stage?.(String(data.stage ?? ''));
            else if (event === 'sources') on.sources?.((data as Source[]).filter((x, i, all) => all.findIndex(y => (y.url ?? y.title) === (x.url ?? x.title)) === i));
            else if (event === 'preview') on.preview?.(String(data.src));
            else if (event === 'usage') on.usage?.(data as Usage);
            else if (event === 'error') throw new StreamError(String(data.message ?? 'The AI stopped.'), Number(data.status) || 0);
            else if (event === 'done') {
                finished = true;
                resolve(data as T);
            } else if (typeof data?.t === 'string') on.text?.(data.t);
        };
        (async () => {
            let buffer = '';
            // Where to look for the end of a frame: an image preview is one frame of a megabyte or more.
            let scanned = 0;
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += value;
                let end: number;
                while ((end = buffer.indexOf('\n\n', scanned)) >= 0) {
                    const frame = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    scanned = 0;
                    let event = 'message';
                    let data = '';
                    for (const line of frame.split('\n')) {
                        if (line.startsWith('event:')) event = line.slice(6).trim();
                        else if (line.startsWith('data:')) data += line.slice(line.startsWith('data: ') ? 6 : 5);
                    }
                    // Comments (": keep-alive") carry no data.
                    if (data) handle(event, JSON.parse(data));
                }
                scanned = Math.max(0, buffer.length - 1);
            }
            if (!finished) throw new StreamError('The connection closed before the answer finished. Try again.');
        })().catch(err => {
            // After done, only the charge was still coming: losing it is fine.
            if (!finished) reject(err);
        });
    });
}
