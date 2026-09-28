import type { Editor } from '@tiptap/core';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, session } from '../api';
import { insertAi, previewHtml, unfence, type AssistMode } from '../editor/assist';
import { selectionMarkdown, snapshot } from '../editor/setup';
import type { Source } from '../stream';
import { CARET, Caret, StopButton, Working, useAiRun, withCaret } from '../streaming';
import { Button, errorToast, toast } from '../ui';
import { MemoryPanel } from './memory';

/** Rendered Markdown, with the blinking caret at the end while it is still being written. */
export function liveHtml(editor: Editor, text: string, writing: boolean): string {
    return writing ? withCaret(previewHtml(editor, text + CARET)) : previewHtml(editor, text);
}

const SOURCES_LABEL = 'Reading the post and your sources';

/** The step to show: reading sources, then thinking until the first words arrive, then writing. */
const stageLabel = (stage: string, text: string) => (stage === 'reading' || !stage ? 'Reading' : text ? 'Writing' : 'Thinking');

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

/**
 * Streams an AI edit or insertion into a card next to the text; nothing touches the post until
 * you accept it. Stop keeps what was written, and that can go in too.
 */
export function AiPreview({ editor, job, title, onClose }: { editor: Editor; job: AiJob; title: string; onClose: () => void }) {
    const run = useAiRun<{ finishReason?: string }>();
    const [attempt, setAttempt] = useState(0);
    const card = useRef<HTMLDivElement>(null);
    const writing = run.state === 'working';

    // Keep the card, and its buttons once the text is in, on screen.
    useEffect(() => card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), [run.state]);

    useEffect(() => {
        const doc = editor.state.doc;
        const selection = job.mode === 'edit' ? selectionMarkdownAt(editor, job.from, job.to) : undefined;
        const before = doc.textBetween(0, job.from, '\n\n');
        const after = doc.textBetween(job.to, doc.content.size, '\n\n');
        run.start('/ai/assist', { mode: job.mode, instruction: job.instruction, selection, before, after, title });
    }, [attempt]);

    // Escape stops the writing; pressed again, it closes the card. Only from the editor or the
    // card (or nowhere in particular), so it never reaches past an open dialog or the assistant.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !(e.target === document.body || card.current?.parentElement?.contains(e.target as Node))) return;
            e.preventDefault();
            writing ? run.stop() : onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [writing]);

    const html = useMemo(() => (run.text ? liveHtml(editor, run.text, writing) : ''), [run.text, writing]);
    const usable = !writing && run.all().trim().length > 0;

    const apply = (how: 'replace' | 'below' | 'at') => {
        if (insertAi(editor, run.all(), { from: job.from, to: job.to }, how)) onClose();
    };

    return (
        <div class="ai-card" ref={card} style={{ top: job.top, left: job.left }} onMouseDown={e => e.stopPropagation()}>
            <div class="ai-card-head">
                <span class="ai-spark">✦</span>
                <span class="ai-card-title">{job.label ?? (job.mode === 'continue' ? 'Continue writing' : job.instruction ?? (job.mode === 'edit' ? 'Rewrite' : 'Write'))}</span>
                {writing ? (
                    <>
                        <Working label={stageLabel(run.stage, run.text)} since={run.startedAt} />
                        <StopButton onClick={run.stop} hint="Stop (Esc)" />
                    </>
                ) : null}
                <button class="icon-btn" onClick={() => (run.stop(), onClose())} aria-label="Discard" title="Discard">
                    ×
                </button>
            </div>
            {html ? (
                <div class="ai-card-body prose-preview" aria-busy={writing} dangerouslySetInnerHTML={{ __html: html }} />
            ) : writing ? (
                <div class="ai-card-body">
                    {run.stage === 'writing' ? null : <span class="muted">{SOURCES_LABEL}… </span>}
                    <Caret />
                </div>
            ) : null}
            {run.state === 'error' ? <p class="note error">{run.text ? `${run.error} What it wrote before that is above.` : run.error}</p> : null}
            {run.state === 'stopped' ? <p class="ai-note">{run.text ? 'Stopped. You can still use what it wrote.' : 'Stopped before it wrote anything.'}</p> : null}
            {run.result?.finishReason === 'length' ? <p class="ai-note">It reached the length limit, so the end may be missing.</p> : null}
            {run.sources.length ? (
                <div class="ai-sources">
                    {run.sources.slice(0, 4).map(s => (
                        <a key={s.title} href={s.url ?? '#'} target="_blank" rel="noreferrer" title={s.title}>
                            {s.title.length > 36 ? `${s.title.slice(0, 34)}…` : s.title}
                        </a>
                    ))}
                </div>
            ) : null}
            <div class="ai-card-actions">
                {job.mode === 'edit' ? (
                    <>
                        <Button tone="primary" disabled={!usable} onClick={() => apply('replace')}>
                            Replace
                        </Button>
                        <Button disabled={!usable} onClick={() => apply('below')}>
                            Insert below
                        </Button>
                    </>
                ) : (
                    <Button tone="primary" disabled={!usable} onClick={() => apply('at')}>
                        Insert
                    </Button>
                )}
                <Button tone="plain" disabled={writing} onClick={() => setAttempt(a => a + 1)}>
                    Try again
                </Button>
                <Button tone="plain" disabled={!usable} onClick={() => navigator.clipboard.writeText(unfence(run.all())).then(() => toast('Copied'), () => {})}>
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
    /** Why an answer is incomplete: stopped, failed, or out of room. */
    note?: { text: string; error?: boolean };
}

const starters = (site: string) => ['Suggest five sharper titles', `What ${site} features should this post mention?`, 'Which past posts should I link to?', 'Review this for accuracy against the docs', 'Write a tweet thread announcing this post'];

/** The conversation as the model reads it: roles alternate, so two questions in a row (the answer between them was stopped before it began) become one. */
function messages(turns: Turn[]) {
    const out: { role: Turn['role']; content: string }[] = [];
    for (const t of turns) {
        if (!t.content.trim()) continue;
        const last = out[out.length - 1];
        if (last?.role === t.role) last.content += `\n\n${t.content}`;
        else out.push({ role: t.role, content: t.content });
    }
    return out;
}

/** The assistant: chat that sees the whole post and knows the site and its sources, with answers you can drop into the post. */
export function AssistantPanel({ editor, title }: { editor: Editor | null; title: string }) {
    const [tab, setTab] = useState<'chat' | 'memory'>('chat');
    // The conversation before the latest answer; that one lives in `live` while it is written, and after.
    const [turns, setTurns] = useState<Turn[]>([]);
    const [input, setInput] = useState('');
    const live = useAiRun<{ finishReason?: string }>();
    const scroll = useRef<HTMLDivElement>(null);
    // New text keeps the log scrolled to the bottom, unless you scrolled up to read.
    const follow = useRef(true);
    const writing = live.state === 'working';

    const latest: Turn | null =
        live.state === 'idle'
            ? null
            : {
                  role: 'assistant',
                  content: live.text,
                  sources: live.sources,
                  note:
                      live.state === 'error'
                          ? { text: live.error ?? 'The assistant stopped.', error: true }
                          : live.state === 'stopped'
                            ? { text: live.text ? 'Stopped.' : 'Stopped before it wrote anything.' }
                            : live.result?.finishReason === 'length'
                              ? { text: 'It reached the length limit, so the end may be missing.' }
                              : undefined
              };

    useEffect(() => {
        const el = scroll.current;
        if (el && follow.current) el.scrollTop = el.scrollHeight;
    }, [turns, live.text, live.state]);

    const ask = (history: Turn[]) => {
        follow.current = true;
        live.start('/ai/assist', { mode: 'chat', title, post: editor ? snapshot(editor).markdown : '', messages: messages(history) });
    };

    const send = (text: string) => {
        if (!text.trim() || writing) return;
        const history: Turn[] = [...turns, ...(latest ? [{ ...latest, content: live.all() }] : []), { role: 'user', content: text.trim() }];
        setTurns(history);
        setInput('');
        ask(history);
    };

    const insert = (text: string, replace: boolean) => {
        if (!editor) return;
        const { from, to, empty } = editor.state.selection;
        insertAi(editor, text, replace && !empty ? { from, to } : { from: to, to }, replace && !empty ? 'replace' : 'at');
        toast(replace && !empty ? 'Replaced the selection' : 'Inserted at the cursor');
    };

    const shown = latest ? [...turns, latest] : turns;

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
                    <div
                        class="assistant-log"
                        ref={scroll}
                        onScroll={e => {
                            const el = e.currentTarget;
                            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                        }}
                    >
                        {shown.length === 0 ? (
                            <div class="assistant-empty">
                                <p class="muted small">Knows this post, every post on the blog, your knowledge sources, and what you ask it to remember.</p>
                                {starters(session.value?.site.title ?? 'our').map(s => (
                                    <button key={s} class="starter" onClick={() => send(s)}>
                                        {s}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            shown.map((t, i) => {
                                const isLatest = t === latest;
                                const full = isLatest ? live.all() : t.content;
                                return (
                                    <TurnView key={i} turn={t} editor={editor} writing={isLatest && writing} stage={live.stage} since={live.startedAt}>
                                        {t.role === 'assistant' && full.trim() && !(isLatest && writing) ? (
                                            <div class="turn-actions">
                                                <button onClick={() => insert(full, false)}>Insert</button>
                                                <button onClick={() => insert(full, true)}>Replace selection</button>
                                                <button onClick={() => navigator.clipboard.writeText(unfence(full)).then(() => toast('Copied'), () => {})}>Copy</button>
                                                <button
                                                    onClick={async () => {
                                                        const text = window.prompt('Remember this (edit it down to the fact that matters)', full.slice(0, 300));
                                                        if (!text) return;
                                                        await api('/ai/memory', { body: { text } }).then(() => toast('Remembered'), errorToast);
                                                    }}
                                                >
                                                    Remember
                                                </button>
                                                {isLatest ? <button onClick={() => ask(turns)}>Try again</button> : null}
                                            </div>
                                        ) : isLatest && !writing ? (
                                            <div class="turn-actions">
                                                <button onClick={() => ask(turns)}>Try again</button>
                                            </div>
                                        ) : null}
                                    </TurnView>
                                );
                            })
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
                                else if (e.key === 'Escape' && writing) (e.preventDefault(), live.stop());
                            }}
                        />
                        {writing ? (
                            <StopButton onClick={live.stop} hint="Stop (Esc)" />
                        ) : (
                            <Button tone="primary" type="submit" disabled={!input.trim()}>
                                Send
                            </Button>
                        )}
                    </form>
                    {shown.length ? (
                        <button class="link-btn small" onClick={() => (live.reset(), setTurns([]))}>
                            New conversation
                        </button>
                    ) : null}
                </>
            )}
        </aside>
    );
}

/** One turn of the chat. An answer renders as it will look in the post, with the caret while it is written. */
function TurnView({ turn, editor, writing, stage, since, children }: { turn: Turn; editor: Editor | null; writing: boolean; stage: string; since: number; children?: ComponentChildren }) {
    const html = useMemo(() => (turn.role === 'assistant' && turn.content && editor ? liveHtml(editor, turn.content, writing) : null), [turn.content, writing, editor]);
    return (
        <div class={`turn turn-${turn.role}`} aria-busy={writing}>
            {html ? (
                <div class="turn-text prose-preview" dangerouslySetInnerHTML={{ __html: html }} />
            ) : turn.content ? (
                <div class="turn-text">
                    {turn.content}
                    {writing ? <Caret /> : null}
                </div>
            ) : writing ? (
                <div class="turn-text">
                    <Working label={stage === 'writing' ? 'Thinking' : SOURCES_LABEL} since={since} />
                </div>
            ) : null}
            {turn.note ? <p class={`turn-note ${turn.note.error ? 'error' : ''}`}>{turn.note.text}</p> : null}
            {children}
            {turn.sources?.length ? (
                <div class="ai-sources">
                    {turn.sources.slice(0, 5).map(s => (
                        <a key={s.title} href={s.url ?? '#'} target="_blank" rel="noreferrer" title={s.title}>
                            {s.title.length > 32 ? `${s.title.slice(0, 30)}…` : s.title}
                        </a>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
