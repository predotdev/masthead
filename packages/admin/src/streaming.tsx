import { useEffect, useRef, useState } from 'preact/hooks';
import { streamAi, type Source, type Usage } from './stream';
import { Button } from './ui';

export type RunState = 'idle' | 'working' | 'done' | 'stopped' | 'error';

export interface AiRun<T> {
    state: RunState;
    /** The server's current step: reading, writing, painting or saving. */
    stage: string;
    /** The text on screen. It follows what arrived a few characters at a time, so bursts read as a steady flow. */
    text: string;
    sources: Source[];
    /** The latest rough version of an image being painted. */
    preview: string | null;
    result: T | null;
    usage: Usage | null;
    error: string | null;
    startedAt: number;
    start: (path: string, body: unknown) => void;
    /** Stops the model; what it wrote stays. */
    stop: () => void;
    reset: () => void;
    /** Everything that arrived, including what is not on screen yet. Use it to insert or save. */
    all: () => string;
}

/** One streamed AI request at a time: its state, text, sources and result. Leaving the page stops it. */
export function useAiRun<T = Record<string, unknown>>(): AiRun<T> {
    const [state, setState] = useState<RunState>('idle');
    const [stage, setStage] = useState('');
    const [text, setText] = useState('');
    const [sources, setSources] = useState<Source[]>([]);
    const [preview, setPreview] = useState<string | null>(null);
    const [result, setResult] = useState<T | null>(null);
    const [usage, setUsage] = useState<Usage | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [startedAt, setStartedAt] = useState(0);
    const ctl = useRef<AbortController | null>(null);
    const received = useRef('');
    const shown = useRef(0);
    const frame = useRef(0);
    const painted = useRef(0);
    const complete = useRef(false);

    // Text arrives in bursts. Each paint reveals what is waiting spread over about 0.6 s, so a
    // burst reads as steady writing and the screen is never far behind; once the answer is
    // complete the rest comes quickly. Long texts paint less often, since every paint renders
    // the whole text again.
    const paint = (now: number) => {
        frame.current = 0;
        const all = received.current;
        if (shown.current >= all.length) return;
        const since = painted.current ? now - painted.current : 16.7;
        if (since < Math.min(120, all.length / 200)) {
            frame.current = requestAnimationFrame(paint);
            return;
        }
        const dt = Math.min(since, 250);
        const waiting = all.length - shown.current;
        const step = Math.max(Math.ceil(dt / 8), Math.ceil((waiting * dt) / (complete.current ? 150 : 600)));
        shown.current = Math.min(all.length, shown.current + step);
        painted.current = now;
        setText(all.slice(0, shown.current));
        if (shown.current < all.length) frame.current = requestAnimationFrame(paint);
    };
    const flush = () => {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        shown.current = received.current.length;
        setText(received.current);
    };

    useEffect(
        () => () => {
            ctl.current?.abort();
            cancelAnimationFrame(frame.current);
        },
        []
    );

    const clear = () => {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        received.current = '';
        shown.current = 0;
        painted.current = 0;
        complete.current = false;
        setText('');
        setStage('');
        setSources([]);
        setPreview(null);
        setResult(null);
        setUsage(null);
        setError(null);
    };

    const start = (path: string, body: unknown) => {
        ctl.current?.abort();
        const c = new AbortController();
        ctl.current = c;
        clear();
        setStartedAt(Date.now());
        setState('working');
        // Events from a run that was replaced or reset are ignored.
        const current = () => ctl.current === c;
        streamAi<T>(
            path,
            body,
            {
                text: t => {
                    if (!current()) return;
                    received.current += t;
                    if (!frame.current) frame.current = requestAnimationFrame(paint);
                },
                stage: s => current() && setStage(s),
                sources: s => current() && setSources(s),
                preview: src => current() && setPreview(src),
                usage: u => current() && setUsage(u)
            },
            c.signal
        ).then(
            data => {
                if (!current()) return;
                setResult(data);
                // Some results come with their charge already (an image made in one call).
                const used = (data as { usage?: Usage } | null)?.usage;
                if (used?.charged != null) setUsage(used);
                complete.current = true;
                if (!frame.current && shown.current < received.current.length) frame.current = requestAnimationFrame(paint);
                setState('done');
            },
            (err: unknown) => {
                if (!current()) return;
                flush();
                if (c.signal.aborted) setState('stopped');
                else {
                    setError(err instanceof Error ? err.message : String(err));
                    setState('error');
                }
            }
        );
    };

    return {
        state,
        stage,
        text,
        sources,
        preview,
        result,
        usage,
        error,
        startedAt,
        start,
        stop: () => ctl.current?.abort(),
        reset: () => {
            ctl.current?.abort();
            ctl.current = null;
            clear();
            setState('idle');
        },
        all: () => received.current
    };
}

/** Whole seconds since `since`, ticking while `running`. */
export function useElapsed(since: number, running: boolean): number {
    const [, tick] = useState(0);
    useEffect(() => {
        if (!running) return;
        const t = setInterval(() => tick(n => n + 1), 1000);
        return () => clearInterval(t);
    }, [running, since]);
    return since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0;
}

export const clock = (seconds: number) => (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);

/** What the AI is doing, and for how long. */
export function Working({ label, since }: { label: string; since: number }) {
    const seconds = useElapsed(since, true);
    return (
        <span class="ai-working">
            <span class="spinner" aria-hidden="true" />
            <span role="status">{label}…</span>
            <span class="ai-elapsed" aria-hidden="true">
                {clock(seconds)}
            </span>
        </span>
    );
}

export function StopButton({ onClick, hint, size }: { onClick: () => void; hint?: string; size?: 'sm' | 'md' }) {
    return (
        <Button class="ai-stop" size={size} onClick={onClick} title={hint}>
            <span class="ai-stop-icon" aria-hidden="true" />
            Stop
        </Button>
    );
}

export function Caret() {
    return <span class="ai-caret" aria-hidden="true" />;
}

/** Marks the end of text that is still being written; models never write this character. */
export const CARET = '';

/** Swaps the mark in rendered text for the blinking caret. A mark that ended up inside a tag is dropped. */
export function withCaret(html: string): string {
    const at = html.lastIndexOf(CARET);
    if (at < 0) return html;
    const before = html.slice(0, at);
    const inTag = before.lastIndexOf('<') > before.lastIndexOf('>');
    return `${before}${inTag ? '' : '<span class="ai-caret" aria-hidden="true"></span>'}${html.slice(at + 1).replaceAll(CARET, '')}`;
}

/**
 * A drafted post while it is written: "# Title" on the first line is the
 * title (`titleDone` once its line ends), the rest is the body.
 */
export function splitDraft(text: string): { title: string; body: string; titleDone: boolean } {
    const t = text.replace(/^\s*```(?:markdown|md)?\n/, '').replace(/\n```\s*$/, '');
    if (/^#\s*$/.test(t)) return { title: '', body: '', titleDone: false };
    const m = t.match(/^#[ \t]+([^\n]*)(\n|$)/);
    if (!m) return { title: '', body: t.trim(), titleDone: true };
    return { title: m[1].trim(), body: t.slice(m[0].length).trim(), titleDone: m[2] === '\n' };
}

/** What a finished request cost, once the provider has settled it. */
export function Credits({ usage }: { usage: Usage | null }) {
    const n = usage?.charged;
    if (n == null) return null;
    return <span class="ai-credits">{n < 0.01 ? 'Under 0.01' : n < 10 ? n.toFixed(2) : Math.round(n)} credits</span>;
}
