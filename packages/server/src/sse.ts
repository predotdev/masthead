/**
 * Server-sent events for AI work that takes a while.
 *
 * The response goes out at once and the work runs while its body is read, so
 * nothing outlives the response. The events come from an async generator that
 * only moves on when the client has taken the last event (backpressure). After
 * 10 seconds without an event a comment goes out, so proxies keep the line
 * open while a model thinks. When the client goes away the signal aborts,
 * which cancels the model call upstream, and the generator is closed.
 *
 * Events: `status` {stage, model?, requestedModel?}, `sources` [{title, url}], unnamed {t: text},
 * `preview` {src}, `done` {...result}, `usage` {charged, ...} and
 * `error` {message, status}.
 */
import { HttpError } from './util';

export interface SseEvent {
    event?: 'status' | 'sources' | 'preview' | 'done' | 'usage' | 'error';
    data: unknown;
}

const KEEP_ALIVE_MS = 10_000;

/** The client asked for events rather than one JSON answer. */
export function wantsEvents(req: Request): boolean {
    return (req.headers.get('accept') ?? '').includes('text/event-stream');
}

/** Where the work is; `extra` rides along, e.g. the model doing it. */
export const status = (stage: string, extra?: Record<string, unknown>): SseEvent => ({ event: 'status', data: { stage, ...extra } });

/**
 * `client` is the request's signal. The runtime cancels the body when it
 * notices the client is gone, which can be late while nothing is being sent;
 * with the enable_request_signal compatibility flag the request's own signal
 * says so right away.
 */
export function eventStream(run: (signal: AbortSignal) => AsyncIterable<SseEvent>, client?: AbortSignal): Response {
    const abort = new AbortController();
    const encoder = new TextEncoder();
    const events = run(abort.signal)[Symbol.asyncIterator]();
    // The step being worked on; it carries over when a keep-alive goes out first.
    let next: Promise<IteratorResult<SseEvent>> | null = null;
    let out: ReadableStreamDefaultController<Uint8Array> | null = null;
    // Ends the work once: the model call is aborted and the generator's cleanup runs.
    const stop = () => {
        if (abort.signal.aborted) return;
        abort.abort();
        next?.catch(() => {});
        events.return?.()?.catch(() => {});
    };
    client?.addEventListener('abort', () => {
        stop();
        close(out);
    });
    // A body that can't take data any more means the client is gone. The runtime may error the
    // body rather than cancel it, and then cancel() never runs: this is where the work stops.
    const send = (controller: ReadableStreamDefaultController<Uint8Array>, text: string) => {
        try {
            controller.enqueue(encoder.encode(text));
        } catch {
            stop();
        }
    };
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            out = controller;
        },
        async pull(controller) {
            next ??= events.next();
            // The executor runs at once, so the timer is set before it is cleared.
            let timer!: ReturnType<typeof setTimeout>;
            const quiet = new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), KEEP_ALIVE_MS)));
            let step: IteratorResult<SseEvent> | null;
            try {
                step = await Promise.race([next, quiet]);
            } catch (err) {
                next = null;
                if (!abort.signal.aborted) send(controller, frame({ event: 'error', data: errorData(err) }));
                return close(controller);
            } finally {
                clearTimeout(timer);
            }
            if (abort.signal.aborted) return;
            if (step === null) return send(controller, ': keep-alive\n\n');
            next = null;
            if (step.done) return close(controller);
            send(controller, frame(step.value));
        },
        cancel() {
            stop();
        }
    });
    return new Response(body, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }
    });
}

/** Closes the body unless it already ended (the client may have cancelled it). */
function close(controller: ReadableStreamDefaultController<Uint8Array> | null) {
    try {
        controller?.close();
    } catch {
        // Already closed or cancelled.
    }
}

function frame(e: SseEvent): string {
    // JSON escapes newlines, so the data always fits on one line.
    return `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`;
}

function errorData(err: unknown): { message: string; status: number } {
    if (err instanceof HttpError) return { message: err.message, status: err.status };
    console.error(err);
    return { message: 'Something went wrong on the server.', status: 500 };
}
