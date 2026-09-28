import type { Editor } from '@tiptap/core';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, session } from '../api';
import { insertAi, previewHtml, streamAssist, unfence, type AssistMode, type Source } from '../editor/assist';
import { selectionMarkdown, snapshot } from '../editor/setup';
import { Button, errorToast, toast } from '../ui';
import { MemoryPanel } from './memory';

export interface AiJob {
    mode: Exclude<AssistMode, 'chat'>;
    instruction?: string;
    /** A short name for the card, e.g. "Shorten". */
    label?: string;
    from: number;
    to: number;
    /** Where the card sits, relative to the editor. */
    top: number;
    left: number;
}

export const QUICK_EDITS: { label: string; instruction: string }[] = [
    { label: 'Improve', instruction: 'Improve it: clearer, tighter, more specific. Keep the meaning.' },
    { label: 'Shorten', instruction: 'Make it about half as long without losing anything important.' },
    { label: 'Expand', instruction: 'Expand it with concrete detail and one example, grounded in the reference passages.' },
    { label: 'Simplify', instruction: 'Rewrite for a reader new to the topic: plain words, short sentences.' },
    { label: 'Fix grammar', instruction: 'Fix spelling, grammar and punctuation only. Change nothing else.' },
    { label: 'Punchier', instruction: 'Make it punchier: stronger verbs, fewer words, no hype.' },
    { label: 'More technical', instruction: 'Make it more technical and precise for engineers, using the reference passages for specifics.' }
];

/** Streams an AI edit or insertion into a card next to the text; nothing touches the post until you accept it. */
export function AiPreview({ editor, job, title, onClose }: { editor: Editor; job: AiJob; title: string; onClose: () => void }) {
    const [text, setText] = useState('');
    const [state, setState] = useState<'streaming' | 'done' | 'error'>('streaming');
    const [error, setError] = useState('');
    const [sources, setSources] = useState<Source[]>([]);
    const [run, setRun] = useState(0);
    const abort = useRef<AbortController | null>(null);
    const card = useRef<HTMLDivElement>(null);

    // Keep the card, and its buttons once the text is in, on screen.
    useEffect(() => card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), [state]);

    useEffect(() => {
        const ctl = new AbortController();
        abort.current = ctl;
        setText('');
        setState('streaming');
        const doc = editor.state.doc;
        const selection = job.mode === 'edit' ? selectionMarkdownAt(editor, job.from, job.to) : undefined;
        const before = doc.textBetween(0, job.from, '\n\n');
        const after = doc.textBetween(job.to, doc.content.size, '\n\n');
        streamAssist({ mode: job.mode, instruction: job.instruction, selection, before, after, title }, { delta: t => setText(x => x + t), sources: setSources }, ctl.signal)
            .then(() => setState('done'))
            .catch(err => {
                if (ctl.signal.aborted) return;
                setError(err.message);
                setState('error');
            });
        return () => ctl.abort();
    }, [run]);

    const html = useMemo(() => (text ? previewHtml(editor, text) : ''), [text]);

    const apply = (how: 'replace' | 'below' | 'at') => {
        if (insertAi(editor, text, { from: job.from, to: job.to }, how)) onClose();
    };

    return (
        <div class="ai-card" ref={card} style={{ top: job.top, left: job.left }} onMouseDown={e => e.stopPropagation()}>
            <div class="ai-card-head">
                <span class="ai-spark">✦</span>
                <span class="ai-card-title">{job.label ?? (job.mode === 'continue' ? 'Continue writing' : job.instruction ?? (job.mode === 'edit' ? 'Rewrite' : 'Write'))}</span>
                {state === 'streaming' ? <span class="spinner" aria-label="Writing" /> : null}
                <button class="icon-btn" onClick={() => (abort.current?.abort(), onClose())} aria-label="Discard">
                    ×
                </button>
            </div>
            {state === 'error' ? (
                <p class="note error">{error}</p>
            ) : html ? (
                <div class="ai-card-body prose-preview" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
                <div class="ai-card-body">
                    <span class="muted">Reading the post and your sources…</span>
                </div>
            )}
            {sources.length ? (
                <div class="ai-sources">
                    {sources.slice(0, 4).map(s => (
                        <a key={s.title} href={s.url ?? '#'} target="_blank" rel="noreferrer" title={s.title}>
                            {s.title.length > 36 ? `${s.title.slice(0, 34)}…` : s.title}
                        </a>
                    ))}
                </div>
            ) : null}
            <div class="ai-card-actions">
                {job.mode === 'edit' ? (
                    <>
                        <Button tone="primary" disabled={state !== 'done'} onClick={() => apply('replace')}>
                            Replace
                        </Button>
                        <Button disabled={state !== 'done'} onClick={() => apply('below')}>
                            Insert below
                        </Button>
                    </>
                ) : (
                    <Button tone="primary" disabled={state !== 'done'} onClick={() => apply('at')}>
                        Insert
                    </Button>
                )}
                <Button tone="plain" disabled={state === 'streaming'} onClick={() => setRun(r => r + 1)}>
                    Try again
                </Button>
                <Button tone="plain" disabled={!text} onClick={() => navigator.clipboard.writeText(unfence(text)).then(() => toast('Copied'), () => {})}>
                    Copy
                </Button>
            </div>
        </div>
    );
}

function selectionMarkdownAt(editor: Editor, from: number, to: number): string {
    const sel = editor.state.selection;
    if (sel.from === from && sel.to === to) return selectionMarkdown(editor);
    return editor.state.doc.textBetween(from, to, '\n\n');
}

/** ⌘J: a prompt at the cursor. With a selection it rewrites; without, it writes. */
export function AiPrompt({ hasSelection, top, left, onRun, onClose }: { hasSelection: boolean; top: number; left: number; onRun: (instruction: string, mode: 'edit' | 'write' | 'continue', label?: string) => void; onClose: () => void }) {
    const [value, setValue] = useState('');
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => input.current?.focus(), []);
    const suggestions = hasSelection ? QUICK_EDITS.slice(0, 5) : [{ label: 'Continue writing', instruction: '' }, { label: 'Write an intro', instruction: 'Write a two-paragraph introduction for this post that hooks a developer reader.' }, { label: 'Add a TL;DR', instruction: 'Write a three-bullet TL;DR of the post.' }, { label: 'Explain the feature', instruction: 'Explain the product feature this post is about, accurately, citing the reference passages.' }, { label: 'Write a conclusion', instruction: 'Write a short conclusion with one clear next step for the reader.' }];
    return (
        <div class="ai-prompt" style={{ top, left }} onMouseDown={e => e.stopPropagation()}>
            <form
                onSubmit={e => {
                    e.preventDefault();
                    if (value.trim()) onRun(value.trim(), hasSelection ? 'edit' : 'write');
                }}
            >
                <span class="ai-spark">✦</span>
                <input ref={input} value={value} onInput={e => setValue(e.currentTarget.value)} onKeyDown={e => e.key === 'Escape' && onClose()} placeholder={hasSelection ? 'How should this change?' : 'What should AI write here?'} />
                <kbd>↵</kbd>
            </form>
            <div class="ai-prompt-chips">
                {suggestions.map(s => (
                    <button key={s.label} type="button" onClick={() => (s.label === 'Continue writing' ? onRun('', 'continue') : onRun(s.instruction, hasSelection ? 'edit' : 'write', s.label))}>
                        {s.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

interface Turn {
    role: 'user' | 'assistant';
    content: string;
    sources?: Source[];
}

const starters = (site: string) => ['Suggest five sharper titles', `What ${site} features should this post mention?`, 'Which past posts should I link to?', 'Review this for accuracy against the docs', 'Write a tweet thread announcing this post'];

/** The assistant: chat that sees the whole post and knows the site and its sources, with answers you can drop into the post. */
export function AssistantPanel({ editor, title }: { editor: Editor | null; title: string }) {
    const [tab, setTab] = useState<'chat' | 'memory'>('chat');
    const [turns, setTurns] = useState<Turn[]>([]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const abort = useRef<AbortController | null>(null);
    const scroll = useRef<HTMLDivElement>(null);

    useEffect(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight }), [turns]);

    const send = async (text: string) => {
        if (!text.trim() || busy) return;
        const history = [...turns, { role: 'user' as const, content: text.trim() }];
        setTurns([...history, { role: 'assistant', content: '' }]);
        setInput('');
        setBusy(true);
        const ctl = new AbortController();
        abort.current = ctl;
        try {
            const post = editor ? snapshot(editor).markdown : '';
            await streamAssist(
                { mode: 'chat', title, post, messages: history.map(t => ({ role: t.role, content: t.content })) },
                {
                    delta: t => setTurns(ts => ts.map((x, i) => (i === ts.length - 1 ? { ...x, content: x.content + t } : x))),
                    sources: s => setTurns(ts => ts.map((x, i) => (i === ts.length - 1 ? { ...x, sources: s } : x)))
                },
                ctl.signal
            );
        } catch (err: any) {
            if (!ctl.signal.aborted) setTurns(ts => ts.map((x, i) => (i === ts.length - 1 ? { ...x, content: `${x.content}\n\n(${err.message})` } : x)));
        } finally {
            setBusy(false);
        }
    };

    const insert = (text: string, replace: boolean) => {
        if (!editor) return;
        const { from, to, empty } = editor.state.selection;
        insertAi(editor, text, replace && !empty ? { from, to } : { from: to, to }, replace && !empty ? 'replace' : 'at');
        toast(replace && !empty ? 'Replaced the selection' : 'Inserted at the cursor');
    };

    return (
        <aside class="assistant">
            <div class="assistant-tabs">
                <button class={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
                    ✦ Assistant
                </button>
                <button class={tab === 'memory' ? 'on' : ''} onClick={() => setTab('memory')}>
                    Memory
                </button>
            </div>
            {tab === 'memory' ? (
                <MemoryPanel />
            ) : (
                <>
                    <div class="assistant-log" ref={scroll}>
                        {turns.length === 0 ? (
                            <div class="assistant-empty">
                                <p class="muted small">Knows this post, every post on the blog, your knowledge sources, and what you ask it to remember.</p>
                                {starters(session.value?.site.title ?? 'our').map(s => (
                                    <button key={s} class="starter" onClick={() => send(s)}>
                                        {s}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            turns.map((t, i) => (
                                <div key={i} class={`turn turn-${t.role}`}>
                                    {t.role === 'assistant' && t.content && editor ? (
                                        <div class="turn-text prose-preview" dangerouslySetInnerHTML={{ __html: previewHtml(editor, t.content) }} />
                                    ) : (
                                        <div class="turn-text">{t.content || (busy && i === turns.length - 1 ? <span class="spinner" /> : '')}</div>
                                    )}
                                    {t.role === 'assistant' && t.content && !(busy && i === turns.length - 1) ? (
                                        <div class="turn-actions">
                                            <button onClick={() => insert(t.content, false)}>Insert</button>
                                            <button onClick={() => insert(t.content, true)}>Replace selection</button>
                                            <button onClick={() => navigator.clipboard.writeText(unfence(t.content)).then(() => toast('Copied'), () => {})}>Copy</button>
                                            <button
                                                onClick={async () => {
                                                    const text = window.prompt('Remember this (edit it down to the fact that matters)', t.content.slice(0, 300));
                                                    if (!text) return;
                                                    await api('/ai/memory', { body: { text } }).then(() => toast('Remembered'), errorToast);
                                                }}
                                            >
                                                Remember
                                            </button>
                                        </div>
                                    ) : null}
                                    {t.sources?.length ? (
                                        <div class="ai-sources">
                                            {t.sources.slice(0, 5).map(s => (
                                                <a key={s.title} href={s.url ?? '#'} target="_blank" rel="noreferrer" title={s.title}>
                                                    {s.title.length > 32 ? `${s.title.slice(0, 30)}…` : s.title}
                                                </a>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                            ))
                        )}
                    </div>
                    <form
                        class="assistant-input"
                        onSubmit={e => {
                            e.preventDefault();
                            send(input);
                        }}
                    >
                        <textarea
                            rows={2}
                            value={input}
                            placeholder="Ask about this post, or ask for text…"
                            onInput={e => setInput(e.currentTarget.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), send(input));
                            }}
                        />
                        {busy ? (
                            <Button onClick={() => (abort.current?.abort(), setBusy(false))}>Stop</Button>
                        ) : (
                            <Button tone="primary" type="submit" disabled={!input.trim()}>
                                Send
                            </Button>
                        )}
                    </form>
                    {turns.length ? (
                        <button class="link-btn small" onClick={() => setTurns([])}>
                            New conversation
                        </button>
                    ) : null}
                </>
            )}
        </aside>
    );
}
