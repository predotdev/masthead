import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { base, session, type Post } from '../api';
import { Icon } from '../icons';
import { ModelPicker } from '../model-picker';
import { modelFor, myModels, setMyModel } from '../models';
import { Answered, Caret, StopButton, Working, credits, useAiRun } from '../streaming';
import { Button, Dialog, ErrorNote, Skeleton, toast } from '../ui';

/** Where the model puts the post's address; each channel gets its own tagged link in its place. */
const LINK = '{link}';

type Section = 'x' | 'thread' | 'linkedin' | 'subjects';

interface Kit {
    x: string;
    thread: string[];
    linkedin: string;
    subjects: { subject: string; preheader: string }[];
    /** The section being written, as far as the text so far shows. */
    at: Section | null;
}

const HEADINGS: [Section, RegExp][] = [
    ['x', /^x post$/i],
    ['thread', /^x thread$/i],
    ['linkedin', /^linkedin(?: post)?$/i],
    ['subjects', /^(?:newsletter )?subject lines$/i]
];

/** The kit from text that may still be arriving (the server reads the finished text the same way, share.ts). */
function parseKit(text: string, writing: boolean): Kit {
    const raw: Record<Section, string> = { x: '', thread: '', linkedin: '', subjects: '' };
    let at: Section | null = null;
    const lines = text.replace(/\r/g, '').split('\n');
    lines.forEach((line, i) => {
        const heading = line.match(/^\s*(?:#{1,4}\s*(.+?)\s*#*|\*\*(.+?)\*\*:?)\s*$/);
        const name = heading ? (heading[1] ?? heading[2]).replace(/[*:]/g, '').trim() : '';
        const found = name ? HEADINGS.find(([, re]) => re.test(name)) : undefined;
        if (found) at = found[0];
        // A heading still being written ("## X thr") is not text of the section before it.
        else if (writing && i === lines.length - 1 && /^\s*(?:#|\*\*)/.test(line)) return;
        else if (at) raw[at] += `${line}\n`;
    });
    // "{lin" at the very end is a link placeholder still arriving.
    const tidy = (t: string) => (writing ? t.replace(/\{l?i?n?k?$/, '') : t).trim();
    const subjects: Kit['subjects'] = [];
    for (const line of raw.subjects.split('\n')) {
        const m = line.replace(/^[\s>*_\-\d.)]+/, '').match(/^(subject|preheader)(?:\s+line)?\**\s*:\s*\**\s*(.*)$/i);
        const value = m?.[2].replace(/\**\s*$/, '').trim().replace(/^["“](.*)["”]$/, '$1').trim();
        if (!m || !value) continue;
        if (m[1].toLowerCase() === 'subject') subjects.push({ subject: value, preheader: '' });
        else if (subjects.length && !subjects[subjects.length - 1].preheader) subjects[subjects.length - 1].preheader = value;
    }
    return { x: tidy(raw.x), thread: threadPosts(raw.thread, writing).map(tidy).filter(Boolean), linkedin: tidy(raw.linkedin), subjects: subjects.slice(0, 5), at };
}

/** Thread posts come between lines of ---; once finished, numbered ("2/") or blank-line separated posts are read too. */
function threadPosts(text: string, writing: boolean): string[] {
    const split = (re: RegExp) =>
        text
            .split(re)
            .map(t => t.trim())
            .filter(Boolean);
    const dashed = split(/^\s*-{3,}\s*$/m);
    if (dashed.length > 1 || writing) return dashed;
    const numbered = split(/^(?=\s*\d{1,2}\/\d{0,2}\s)/m);
    if (numbered.length > 1) return numbered;
    const paragraphs = split(/\n\s*\n/);
    return paragraphs.length >= 3 && paragraphs.length <= 8 ? paragraphs : dashed;
}

/** A finished post the model wrote without its link gets it at the end, as the copy will. */
const withLink = (text: string, done: boolean) => (done && text && !text.includes(LINK) ? `${text}\n\n${LINK}` : text);

/** X counts a link as 23 characters, and an emoji as two. */
function xLength(text: string): number {
    let n = 0;
    for (const ch of text.replaceAll(LINK, 'x'.repeat(23)).replace(/https?:\/\/\S+/g, 'x'.repeat(23))) n += ch.codePointAt(0)! > 0xffff ? 2 : 1;
    return n;
}

function taggedUrl(post: Post, source: 'x' | 'linkedin'): string {
    const url = new URL(`${session.value?.site.url ?? `${location.origin}${base}`}${post.slug}/`);
    url.searchParams.set('utm_source', source);
    url.searchParams.set('utm_medium', 'social');
    url.searchParams.set('utm_campaign', post.slug);
    return url.toString();
}

/** The editor bar's Share, for posts on the site or scheduled to be. */
export function ShareButton({ post, onClick }: { post: Post; onClick: () => void }) {
    if (post.type !== 'post' || post.status === 'draft') return null;
    return (
        <Button class="share-btn" icon="share" aria-label="Share kit" data-tooltip="Posts for X and LinkedIn, and subject lines" onClick={onClick}>
            <span class="share-btn-label">Share</span>
        </Button>
    );
}

/**
 * The share kit: an X post, an X thread, a LinkedIn post and five subject lines with
 * preheaders, written as you watch. Each has a copy button; nothing is posted anywhere.
 */
export function ShareDialog({ post, onClose }: { post: Post; onClose: () => void }) {
    const run = useAiRun<{ finishReason?: string }>();
    const [angle, setAngle] = useState('');
    const write = () => run.start(`/posts/${post.id}/share`, { angle: angle.trim() || undefined, model: modelFor('text') });
    useEffect(write, []);
    const writing = run.state === 'working';
    const kit = useMemo(() => parseKit(run.text, writing), [run.text, writing]);
    const links = useMemo(() => ({ x: taggedUrl(post, 'x'), linkedin: taggedUrl(post, 'linkedin') }), [post.slug]);
    const done = run.state === 'done';
    const stateOf = (s: Section, has: boolean): CardState => (has ? (writing && kit.at === s ? 'writing' : 'done') : writing ? 'waiting' : 'empty');
    const caret = (s: Section) => (writing && kit.at === s ? <Caret /> : null);

    // The kit scrolls to keep the words being written in view, until you scroll it yourself;
    // each new section picks the following up again.
    const box = useRef<HTMLDivElement>(null);
    const follow = useRef(true);
    useEffect(() => void (follow.current = true), [kit.at]);
    useLayoutEffect(() => {
        if (writing && follow.current) box.current?.querySelector('.ai-caret')?.scrollIntoView({ block: 'nearest' });
    }, [run.text, writing]);

    const x = withLink(kit.x, done);
    const thread = kit.thread.map((t, i) => (i === kit.thread.length - 1 && !kit.thread.some(p => p.includes(LINK)) ? withLink(t, done) : t));
    const linkedin = withLink(kit.linkedin, done);
    const fill = (text: string, url: string) => text.replaceAll(LINK, url);
    const tags = (source: 'x' | 'linkedin') => `utm_source=${source} · utm_medium=social · utm_campaign=${post.slug}`;

    return (
        <Dialog title="Share kit" description="Written from the post in the house style. Nothing is posted anywhere: copy what you want." onClose={onClose} wide>
            <div class="kit" ref={box} aria-busy={writing} onWheel={() => (follow.current = false)} onTouchMove={() => (follow.current = false)}>
                {run.state === 'error' ? <ErrorNote text={run.text ? `${run.error} What it wrote before that is below.` : (run.error ?? '')} /> : null}
                <div class="kit-grid">
                    <div class="kit-col">
                        <KitCard mark="x" title="X post" state={stateOf('x', !!x)} meta={x ? <Limit n={xLength(x)} max={280} /> : null} copy={x && !writing ? fill(x, links.x) : undefined} tags={tags('x')}>
                            <p class="kit-text">
                                <Linked text={x} url={links.x} />
                                {caret('x')}
                            </p>
                        </KitCard>
                        <KitCard mark="linkedin" title="LinkedIn post" state={stateOf('linkedin', !!linkedin)} meta={linkedin ? `${linkedin.replaceAll(LINK, links.linkedin).length.toLocaleString()} characters` : null} copy={linkedin && !writing ? fill(linkedin, links.linkedin) : undefined} tags={tags('linkedin')}>
                            <p class="kit-text">
                                <Linked text={linkedin} url={links.linkedin} />
                                {caret('linkedin')}
                            </p>
                        </KitCard>
                    </div>
                    <KitCard mark="x" title="X thread" state={stateOf('thread', thread.length > 0)} meta={thread.length ? `${thread.length} posts` : null} copy={thread.length && !writing ? thread.map(t => fill(t, links.x)).join('\n\n') : undefined} copyLabel="Copy all" tags={tags('x')}>
                        <ol class="kit-thread">
                            {thread.map((t, i) => (
                                <li key={i}>
                                    <span class="kit-n" aria-hidden="true">
                                        {i + 1}
                                    </span>
                                    <div class="kit-post">
                                        <p class="kit-text">
                                            <Linked text={t} url={links.x} />
                                            {i === thread.length - 1 ? caret('thread') : null}
                                        </p>
                                        <div class="kit-post-foot">
                                            <Limit n={xLength(t)} max={280} />
                                            {!writing ? <CopyButton text={fill(t, links.x)} label={`Copy post ${i + 1}`} compact /> : null}
                                        </div>
                                    </div>
                                </li>
                            ))}
                        </ol>
                    </KitCard>
                </div>
                <KitCard mark="mail" title="Newsletter subject lines" state={stateOf('subjects', kit.subjects.length > 0)} meta={kit.subjects.length ? 'Subject, then the preheader shown after it in the inbox' : null}>
                    <ol class="kit-subjects">
                        {kit.subjects.map((s, i) => (
                            <li key={i}>
                                <span class="kit-n" aria-hidden="true">
                                    {i + 1}
                                </span>
                                <div class="kit-subject">
                                    <p class="kit-subject-line">
                                        {s.subject}
                                        {!s.preheader && i === kit.subjects.length - 1 ? caret('subjects') : null}
                                    </p>
                                    {s.preheader ? (
                                        <p class="kit-preheader">
                                            {s.preheader}
                                            {i === kit.subjects.length - 1 ? caret('subjects') : null}
                                        </p>
                                    ) : null}
                                </div>
                                {/* Each line's length and its copy button sit level with it. */}
                                <span class="kit-subject-tools">
                                    <Limit n={s.subject.length} max={60} />
                                    {!writing ? <CopyButton text={s.subject} label="Copy subject" compact /> : <span />}
                                    {s.preheader ? <Limit n={s.preheader.length} max={100} /> : null}
                                    {s.preheader && !writing ? <CopyButton text={s.preheader} label="Copy preheader" compact /> : null}
                                </span>
                            </li>
                        ))}
                    </ol>
                </KitCard>
                {run.state === 'stopped' ? <p class="ai-note">{run.text ? 'Stopped. What it wrote is above.' : 'Stopped before it wrote anything.'}</p> : null}
                {run.result?.finishReason === 'length' ? <p class="ai-note">It reached the length limit, so the end may be missing.</p> : null}
            </div>
            <div class="dialog-actions kit-actions">
                {writing ? (
                    <>
                        <Working label={run.stage === 'reading' || !run.stage ? 'Reading the post' : run.text ? 'Writing' : 'Thinking'} since={run.startedAt} />
                        <StopButton onClick={run.stop} />
                    </>
                ) : (
                    <>
                        <span class="kit-model">
                            <ModelPicker kind="text" compact allowDefault value={myModels.value.text ?? null} onChange={id => setMyModel('text', id)} label="Writing model" />
                            {/* The picker names the model; what answered is worth saying only when it was another one. */}
                            {run.requestedModel ? <Answered run={run} /> : run.usage?.charged != null ? <span class="ai-credits">{credits(run.usage.charged)}</span> : null}
                        </span>
                        <input
                            class="kit-angle"
                            value={angle}
                            placeholder="Lead with… (optional)"
                            aria-label="What to lead with"
                            onInput={e => setAngle(e.currentTarget.value)}
                            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), write())}
                        />
                        <Button onClick={write}>Write again</Button>
                        <Button tone="primary" onClick={onClose}>
                            Done
                        </Button>
                    </>
                )}
            </div>
        </Dialog>
    );
}

type CardState = 'waiting' | 'writing' | 'done' | 'empty';

function KitCard(props: { mark: 'x' | 'linkedin' | 'mail'; title: string; state: CardState; meta?: ComponentChildren; copy?: string; copyLabel?: string; tags?: string; children: ComponentChildren }) {
    return (
        <section class={`kit-card is-${props.state}`}>
            <header class="kit-head">
                <span class={`kit-mark ${props.mark}`} aria-hidden="true">
                    {props.mark === 'x' ? 'X' : props.mark === 'linkedin' ? 'in' : <Icon name="mail" size={13} />}
                </span>
                <h3>{props.title}</h3>
                {props.meta ? <span class="kit-meta">{props.meta}</span> : null}
                {props.copy ? <CopyButton text={props.copy} label={props.copyLabel ?? 'Copy'} /> : null}
            </header>
            <div class="kit-body">
                {props.state === 'waiting' ? (
                    <div class="kit-waiting">
                        <Skeleton width="92%" />
                        <Skeleton width="84%" />
                        <Skeleton width="58%" />
                    </div>
                ) : props.state === 'empty' ? (
                    <p class="muted small">Not written this time. Write again for another try.</p>
                ) : (
                    props.children
                )}
            </div>
            {props.tags && props.state !== 'waiting' ? <footer class="kit-tags">{props.tags}</footer> : null}
        </section>
    );
}

/** Text with the tagged link shown as the address people will see (the whole address is copied). */
function Linked({ text, url }: { text: string; url: string }) {
    const parts = text.split(LINK);
    const u = new URL(url);
    return (
        <>
            {parts.map((p, i) => (
                <Fragment key={i}>
                    {p}
                    {i < parts.length - 1 ? (
                        <span class="kit-link" title={url}>
                            {u.host}
                            {u.pathname.replace(/\/$/, '')}
                        </span>
                    ) : null}
                </Fragment>
            ))}
        </>
    );
}

function Limit({ n, max }: { n: number; max: number }) {
    return (
        <span class={`kit-limit${n > max ? ' over' : ''}`} title={n > max ? `Over the ${max}-character limit` : `${max} at most`}>
            {n}/{max}
        </span>
    );
}

function CopyButton({ text, label = 'Copy', compact }: { text: string; label?: string; compact?: boolean }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1600);
        return () => clearTimeout(t);
    }, [copied]);
    const copy = () => navigator.clipboard.writeText(text).then(() => setCopied(true), () => toast('Copying was blocked. Select the text and copy it.', 'error'));
    return (
        <button type="button" class={`kit-copy${compact ? ' compact' : ''}${copied ? ' copied' : ''}`} aria-label={compact ? label : undefined} data-tooltip={compact ? (copied ? 'Copied' : label) : undefined} onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            {compact ? null : <span aria-live="polite">{copied ? 'Copied' : label}</span>}
        </button>
    );
}
