import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, fmtDate, fmtNum, type Post, type Tag } from '../api';
import { Icon, type IconName } from '../icons';
import { Button, Dialog, ErrorNote, Field, IconButton, Loading, PageHead, Pill, Segmented, errorToast, toast, useLoad } from '../ui';

/**
 * Newsletters > Welcome series: the emails every new subscriber gets. The steps sit in a
 * row like a timeline; the chosen one is edited on the left while the email renders live
 * on the right, at desktop or phone width, light or dark.
 */

interface StepPosts {
    mode: 'best' | 'pinned' | 'none';
    count: number;
    tags: string[];
    pinned: string[];
    heading: string;
}

interface Step {
    id: string;
    delay: number;
    subject: string;
    preheader: string;
    intro: string;
    posts: StepPosts;
    outro: string;
    button: { label: string; url: string } | null;
}

interface Sequence {
    id: string;
    name: string;
    enabled: boolean;
    enabledAt: string | null;
    steps: Step[];
    updatedAt: string | null;
}

interface StepStats {
    sent: number;
    failed: number;
    skipped: number;
    delivered: number;
    opened: number;
    clicked: number;
    unsubscribed: number;
}

interface Joiner {
    id: string;
    email: string | null;
    status: 'active' | 'done' | 'stopped';
    reason: string | null;
    enrolledAt: string;
    nextAt: string | null;
    sent: number;
}

interface Payload {
    sequence: Sequence;
    saved: boolean;
    stats: { testMode: boolean; steps: Record<string, StepStats>; people: { active: number; done: number; stopped: number }; recent: Joiner[] | null };
    environment: { testMode: boolean; email: boolean; webhooks: boolean; from: string | null; you: { email: string; team: boolean } | null };
}

interface Preview {
    subject: string;
    preheader: string;
    html: string;
    posts: { id: string; title: string; slug: string; tag: string | null; opens: number; readers: number }[];
}

const DAY = 1440;
const SERIES = 'welcome';

// ------------------------------------------------------------------ time words

type Unit = 'now' | 'minutes' | 'hours' | 'days';
const PER: Record<Exclude<Unit, 'now'>, number> = { minutes: 1, hours: 60, days: DAY };

function split(m: number): { n: number; unit: Unit } {
    if (!m) return { n: 1, unit: 'now' };
    if (m % DAY === 0) return { n: m / DAY, unit: 'days' };
    if (m % 60 === 0) return { n: m / 60, unit: 'hours' };
    return { n: m, unit: 'minutes' };
}

const plural = (n: number, word: string) => `${fmtNum(n)} ${word}${n === 1 ? '' : 's'}`;

/** How long a wait is, in the largest whole unit: "3 days", "6 hours", "30 minutes". */
function span(m: number): string {
    const { n, unit } = split(m);
    return unit === 'now' ? 'no wait' : plural(n, unit.slice(0, -1));
}

/** When a step goes out, counted from the day someone subscribes. */
function when(m: number): string {
    if (!m) return 'Right away';
    return m % DAY === 0 ? `Day ${m / DAY}` : `After ${span(m)}`;
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '–');

function blankStep(after: Step | undefined): Step {
    return {
        id: `s${Date.now().toString(36)}`,
        delay: after ? after.delay + 3 * DAY : 0,
        subject: '',
        preheader: '',
        intro: '',
        posts: { mode: 'best', count: 3, tags: [], pinned: [], heading: '' },
        outro: '',
        button: null
    };
}

/** Steps in send order; a tie keeps the order they had. */
const ordered = (steps: Step[]) => steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.delay - b.s.delay || a.i - b.i).map(x => x.s);

// ------------------------------------------------------------------ the page

/** The tabs over both newsletter screens. */
export function NewsletterTabs({ on }: { on: 'sent' | 'welcome' }) {
    const tabs: [typeof on, string, string][] = [
        ['sent', 'Sent', '#/newsletters'],
        ['welcome', 'Welcome series', '#/newsletters/welcome']
    ];
    return (
        <nav class="an-nav" aria-label="Newsletters">
            {tabs.map(([key, label, href]) => (
                <a key={key} href={href} class={key === on ? 'on' : ''} aria-current={key === on ? 'page' : undefined}>
                    {label}
                </a>
            ))}
        </nav>
    );
}

export function WelcomeSeries() {
    const { data, error } = useLoad(() => api<Payload>(`/sequences/${SERIES}`), []);
    return (
        <div class="ws">
            <PageHead title="Newsletters" description="The emails every new subscriber gets, one after another, starting when they subscribe." />
            <NewsletterTabs on="welcome" />
            {error ? <ErrorNote text={error} /> : !data ? <Loading /> : <SeriesEditor initial={data} />}
        </div>
    );
}

function SeriesEditor({ initial }: { initial: Payload }) {
    const [saved, setSaved] = useState(initial);
    const [steps, setSteps] = useState<Step[]>(initial.sequence.steps);
    const [selected, setSelected] = useState(initial.sequence.steps[0]?.id ?? '');
    const [saving, setSaving] = useState(false);
    const [confirm, setConfirm] = useState<'on' | 'off' | null>(null);
    const env = saved.environment;
    const seq = saved.sequence;
    const dirty = !saved.saved || JSON.stringify(steps) !== JSON.stringify(seq.steps);
    const index = Math.max(0, steps.findIndex(s => s.id === selected));
    const step = steps[index] as Step | undefined;
    const { data: tags } = useLoad(() => api<Tag[]>('/tags'), []);

    const save = async (patch: { enabled?: boolean } = {}) => {
        setSaving(true);
        try {
            const res = await api<Payload>(`/sequences/${SERIES}`, { method: 'PUT', body: { name: seq.name, steps, ...patch } });
            setSaved(res);
            setSteps(res.sequence.steps);
            // The server may have given a new step an id of its own.
            if (!res.sequence.steps.some(s => s.id === selected)) setSelected(res.sequence.steps[Math.min(index, res.sequence.steps.length - 1)]?.id ?? '');
            toast(patch.enabled === undefined ? 'Saved' : patch.enabled ? 'The welcome series is on' : 'The welcome series is off');
            return true;
        } catch (err) {
            errorToast(err);
            return false;
        } finally {
            setSaving(false);
        }
    };

    // Unsaved work: the browser asks before leaving, and Cmd/Ctrl+S saves.
    const saveRef = useRef(save);
    saveRef.current = save;
    useEffect(() => {
        const warn = (e: BeforeUnloadEvent) => {
            if (dirty) e.preventDefault();
        };
        const keys = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                if (dirty) saveRef.current();
            }
        };
        window.addEventListener('beforeunload', warn);
        window.addEventListener('keydown', keys);
        return () => (window.removeEventListener('beforeunload', warn), window.removeEventListener('keydown', keys));
    }, [dirty]);

    const update = (patch: Partial<Step>) => setSteps(list => ordered(list.map(s => (s.id === selected ? { ...s, ...patch } : s))));
    const add = () => {
        const next = blankStep(steps[steps.length - 1]);
        setSteps(ordered([...steps, next]));
        setSelected(next.id);
    };
    const remove = () => {
        if (!step) return;
        const sent = saved.stats.steps[step.id]?.sent ?? 0;
        const warning = sent ? ` It went to ${plural(sent, 'person')} so far; anyone who hasn't had it yet won't get it.` : '';
        if (!window.confirm(`Remove email ${index + 1} from the series?${warning}`)) return;
        const rest = steps.filter(s => s.id !== step.id);
        setSteps(rest);
        setSelected(rest[Math.min(index, rest.length - 1)]?.id ?? '');
    };

    const last = steps[steps.length - 1];
    const people = saved.stats.people;
    return (
        <>
            <section class="ws-head">
                <div class="ws-head-text">
                    <div class="ws-title">
                        <h2>{seq.name}</h2>
                        {seq.enabled ? (
                            <Pill tone={env.testMode ? 'amber' : 'green'} dot>
                                {env.testMode ? 'On for the team' : 'On'}
                            </Pill>
                        ) : (
                            <Pill dot>Off</Pill>
                        )}
                    </div>
                    <p class="ws-sub">
                        {steps.length ? `${plural(steps.length, 'email')}${last?.delay ? ` over ${span(last.delay)}` : ''} for everyone who subscribes${seq.enabled && seq.enabledAt ? ` since ${fmtDate(seq.enabledAt)}` : ' once it is on'}.` : 'No emails yet.'} People already on
                        the list don't get them.
                    </p>
                </div>
                <div class="ws-controls">
                    {dirty ? (
                        <>
                            <span class="ws-unsaved">{saved.saved ? 'Unsaved changes' : 'Not saved yet'}</span>
                            <Button tone="primary" busy={saving && !confirm} onClick={() => save()}>
                                Save
                            </Button>
                        </>
                    ) : (
                        <span class="ws-saved">
                            <Icon name="check" size={14} />
                            Saved
                        </span>
                    )}
                    <Switch on={seq.enabled} label="Send the welcome series" onClick={() => setConfirm(seq.enabled ? 'off' : 'on')} />
                </div>
            </section>

            {env.testMode ? (
                <div class="note warn">
                    <strong>Test mode is on.</strong> Only team addresses join the series and get its emails. Anyone else who subscribes meanwhile is skipped for good, so nobody gets a stale series when test mode ends.
                </div>
            ) : null}
            {!env.email ? <div class="note">Email isn't set up on this server: people still join, and their emails go out once it is.</div> : null}

            <Flow steps={steps} selected={step?.id} stats={saved.stats.steps} people={people} onSelect={setSelected} onAdd={add} />

            {step ? (
                <div class="ws-work">
                    <StepEditor key={step.id} step={step} index={index} total={steps.length} stats={saved.stats.steps[step.id]} statsTest={saved.stats.testMode} webhooks={env.webhooks} tags={tags ?? []} onChange={update} onRemove={remove} />
                    <PreviewPane steps={steps} step={step} from={env.from} canTest={env.email && !!env.you?.team} you={env.you?.email ?? null} emailReady={env.email} />
                </div>
            ) : (
                <div class="empty">
                    <p class="empty-title">No emails in the series</p>
                    <div class="empty-body">Add the first one: it can go out the moment someone subscribes.</div>
                    <div class="empty-actions">
                        <Button tone="primary" icon="plus" onClick={add}>
                            Add an email
                        </Button>
                    </div>
                </div>
            )}

            {saved.stats.recent?.length ? <Joiners list={saved.stats.recent} steps={seq.steps.length} testMode={env.testMode} /> : null}

            {confirm ? (
                <ConfirmSwitch
                    turn={confirm}
                    steps={steps}
                    dirty={dirty}
                    testMode={env.testMode}
                    email={env.email}
                    busy={saving}
                    onClose={() => setConfirm(null)}
                    onConfirm={async () => {
                        if (await save({ enabled: confirm === 'on' })) setConfirm(null);
                    }}
                />
            ) : null}
        </>
    );
}

function Switch({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
    return (
        <button type="button" role="switch" aria-checked={on} aria-label={label} class="ws-switch" onClick={onClick}>
            <span class="ws-switch-track" aria-hidden="true">
                <span class="ws-switch-thumb" />
            </span>
            <span class="ws-switch-text">{on ? 'On' : 'Off'}</span>
        </button>
    );
}

// ------------------------------------------------------------------ the timeline

function Flow({
    steps,
    selected,
    stats,
    people,
    onSelect,
    onAdd
}: {
    steps: Step[];
    selected?: string;
    stats: Record<string, StepStats>;
    people: Payload['stats']['people'];
    onSelect: (id: string) => void;
    onAdd: () => void;
}) {
    const box = useRef<HTMLDivElement>(null);
    // When the timeline is wider than the page, its cut-off ends fade out.
    const [fade, setFade] = useState('');
    useEffect(() => {
        const el = box.current!;
        const update = () => {
            const left = el.scrollLeft > 2;
            const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
            setFade(left && right ? 'both' : left ? 'left' : right ? 'right' : '');
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        el.addEventListener('scroll', update, { passive: true });
        return () => (ro.disconnect(), el.removeEventListener('scroll', update));
    }, [steps.length]);
    useEffect(() => box.current?.querySelector('.ws-step.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }), [selected, steps.length]);
    return (
        <div class="ws-flow" ref={box} data-fade={fade || undefined} aria-label="Emails in the series">
            <div class="ws-node">
                <span class="ws-node-icon">
                    <Icon name="userPlus" size={15} />
                </span>
                <span class="ws-node-text">
                    <b>Someone subscribes</b>
                    <span>{people.active ? `${fmtNum(people.active)} in the series now` : 'on the blog, in your product or by import'}</span>
                </span>
            </div>
            {steps.map((s, i) => {
                const st = stats[s.id];
                return (
                    <Fragment key={s.id}>
                        <span class="ws-link" aria-hidden="true" />
                        <button type="button" class={`ws-step${s.id === selected ? ' on' : ''}`} aria-pressed={s.id === selected} onClick={() => onSelect(s.id)}>
                            <span class="ws-step-top">
                                <span class="ws-num">{i + 1}</span>
                                <span>{when(s.delay)}</span>
                            </span>
                            <span class={`ws-step-subject${s.subject ? '' : ' ws-blank'}`}>{s.subject || 'No subject yet'}</span>
                            <span class="ws-step-foot">{st?.sent ? `${fmtNum(st.sent)} sent · ${pct(st.opened, st.sent)} opened` : 'Not sent yet'}</span>
                        </button>
                    </Fragment>
                );
            })}
            <span class="ws-link" aria-hidden="true" />
            <button type="button" class="ws-add" onClick={onAdd} disabled={steps.length >= 12} aria-label="Add an email" data-tooltip="Add an email">
                <Icon name="plus" size={16} />
            </button>
            <span class="ws-link" aria-hidden="true" />
            <div class="ws-node end">
                <span class="ws-node-icon">
                    <Icon name="checkCircle" size={15} />
                </span>
                <span class="ws-node-text">
                    <b>{people.done ? `${fmtNum(people.done)} finished` : 'Then new posts'}</b>
                    <span>{people.done || people.stopped ? `${fmtNum(people.stopped)} left early` : 'as they come out'}</span>
                </span>
            </div>
        </div>
    );
}

// ------------------------------------------------------------------ one email

function StepEditor({
    step,
    index,
    total,
    stats,
    statsTest,
    webhooks,
    tags,
    onChange,
    onRemove
}: {
    step: Step;
    index: number;
    total: number;
    stats?: StepStats;
    statsTest: boolean;
    webhooks: boolean;
    tags: Tag[];
    onChange: (patch: Partial<Step>) => void;
    onRemove: () => void;
}) {
    const posts = step.posts;
    const setPosts = (patch: Partial<StepPosts>) => onChange({ posts: { ...posts, ...patch } });
    const s = stats ?? { sent: 0, failed: 0, skipped: 0, delivered: 0, opened: 0, clicked: 0, unsubscribed: 0 };
    return (
        <div class="ws-editor">
            <div class="ws-editor-head">
                <div>
                    <p class="ws-kicker">
                        Email {index + 1} of {total}
                    </p>
                    <h3>{when(step.delay)}</h3>
                </div>
                <IconButton icon="trash" label="Remove this email" onClick={onRemove} />
            </div>

            <div class="ws-stats" aria-label={statsTest ? 'Numbers from test mode' : 'Numbers'}>
                <Tile label="Sent" value={fmtNum(s.sent)} note={s.failed ? `${fmtNum(s.failed)} failed` : s.skipped ? `${fmtNum(s.skipped)} skipped` : undefined} />
                <Tile label="Opened" value={webhooks || s.opened ? pct(s.opened, s.sent) : '–'} note={s.opened ? plural(s.opened, 'person') : undefined} />
                <Tile label="Clicked" value={webhooks || s.clicked ? pct(s.clicked, s.sent) : '–'} note={s.clicked ? plural(s.clicked, 'person') : undefined} />
                <Tile label="Unsubscribed" value={fmtNum(s.unsubscribed)} note={s.unsubscribed ? pct(s.unsubscribed, s.sent) : undefined} />
            </div>
            {statsTest && s.sent ? <p class="ws-fine">Counts from test mode: team addresses only.</p> : null}
            {!webhooks ? <p class="ws-fine">Opens and clicks arrive from the email provider's webhook, which isn't connected.</p> : null}

            <Section title="When">
                <Delay value={step.delay} onChange={delay => onChange({ delay })} />
            </Section>

            <Section title="Subject and preview">
                <Field label="Subject">
                    <input value={step.subject} maxLength={200} placeholder="Welcome to {site}" onInput={e => onChange({ subject: e.currentTarget.value })} />
                </Field>
                <Field label="Preview text" hint="Inboxes show it after the subject.">
                    <input value={step.preheader} maxLength={300} onInput={e => onChange({ preheader: e.currentTarget.value })} />
                </Field>
            </Section>

            <Section title="Opening">
                <Field label="Text above the posts" hint="Markdown: # for a heading, **bold**, - for a list, [words](link). {site} becomes the blog's name.">
                    <textarea rows={9} value={step.intro} onInput={e => onChange({ intro: e.currentTarget.value })} />
                </Field>
            </Section>

            <Section title="Posts">
                <Segmented
                    label="Which posts"
                    value={posts.mode}
                    options={[
                        { value: 'best', label: 'Best of' },
                        { value: 'pinned', label: 'Chosen' },
                        { value: 'none', label: 'None' }
                    ]}
                    onChange={mode => setPosts({ mode })}
                />
                {posts.mode === 'best' ? (
                    <>
                        <p class="ws-fine">The posts most people opened in newsletters and read on the blog. Nobody gets a post twice: posts from earlier emails and past newsletters are left out.</p>
                        <div class="ws-count">
                            <span>Show</span>
                            <select value={posts.count} aria-label="How many posts" onChange={e => setPosts({ count: Number(e.currentTarget.value) })}>
                                {[1, 2, 3, 4, 5, 6].map(n => (
                                    <option key={n} value={n}>
                                        {n}
                                    </option>
                                ))}
                            </select>
                            <span>{posts.count === 1 ? 'post' : 'posts'} from</span>
                        </div>
                        <TagPicker tags={tags} value={posts.tags} onChange={t => setPosts({ tags: t })} />
                    </>
                ) : posts.mode === 'pinned' ? (
                    <PostPicker value={posts.pinned} onChange={pinned => setPosts({ pinned })} />
                ) : null}
                {posts.mode !== 'none' ? (
                    <Field label="Heading over the posts">
                        <input value={posts.heading} maxLength={80} placeholder="Start with these" onInput={e => setPosts({ heading: e.currentTarget.value })} />
                    </Field>
                ) : null}
            </Section>

            <Section title="Closing">
                <Field label="Text under the posts" hint="Markdown. Leave it empty to end with the posts.">
                    <textarea rows={4} value={step.outro} onInput={e => onChange({ outro: e.currentTarget.value })} />
                </Field>
                <div class="ws-button-fields">
                    <Field label="Button">
                        <input value={step.button?.label ?? ''} maxLength={60} placeholder="Try it" onInput={e => onChange({ button: button(e.currentTarget.value, step.button?.url ?? '') })} />
                    </Field>
                    <Field label="Button link">
                        <input type="url" value={step.button?.url ?? ''} placeholder="https://" onInput={e => onChange({ button: button(step.button?.label ?? '', e.currentTarget.value) })} />
                    </Field>
                </div>
            </Section>
        </div>
    );
}

const button = (label: string, url: string) => (label.trim() || url.trim() ? { label, url } : null);

function Section({ title, children }: { title: string; children: ComponentChildren }) {
    return (
        <section class="ws-section">
            <h4>{title}</h4>
            {children}
        </section>
    );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
    return (
        <div class="ws-tile">
            <span>{label}</span>
            <b>{value}</b>
            {note ? <em>{note}</em> : null}
        </div>
    );
}

function Delay({ value, onChange }: { value: number; onChange: (m: number) => void }) {
    const { n, unit } = split(value);
    const [count, setCount] = useState(String(n));
    useEffect(() => setCount(String(split(value).n)), [value]);
    const set = (c: number, u: Unit) => onChange(u === 'now' ? 0 : Math.max(1, Math.round(c)) * PER[u]);
    return (
        <div class="ws-delay">
            <span>Send</span>
            {unit !== 'now' ? (
                <input
                    type="number"
                    min={1}
                    max={365}
                    value={count}
                    aria-label="How long after they subscribe"
                    onInput={e => {
                        setCount(e.currentTarget.value);
                        const c = Number(e.currentTarget.value);
                        if (c >= 1) set(c, unit);
                    }}
                />
            ) : null}
            <select value={unit} aria-label="Unit" onChange={e => set(unit === 'now' ? 1 : n, e.currentTarget.value as Unit)}>
                <option value="now">right away</option>
                <option value="minutes">{n === 1 ? 'minute' : 'minutes'}</option>
                <option value="hours">{n === 1 ? 'hour' : 'hours'}</option>
                <option value="days">{n === 1 ? 'day' : 'days'}</option>
            </select>
            <span>{unit === 'now' ? 'when they subscribe' : 'after they subscribe'}</span>
        </div>
    );
}

function TagPicker({ tags, value, onChange }: { tags: Tag[]; value: string[]; onChange: (v: string[]) => void }) {
    const shown = tags.filter(t => t.visibility === 'public');
    const unknown = value.filter(v => !shown.some(t => t.slug === v));
    const toggle = (slug: string) => onChange(value.includes(slug) ? value.filter(v => v !== slug) : [...value, slug]);
    return (
        <div class="chips ws-tags" role="group" aria-label="Tags">
            <button type="button" class={`chip${value.length ? '' : ' on'}`} aria-pressed={!value.length} onClick={() => onChange([])}>
                All topics
            </button>
            {shown.map(t => (
                <button key={t.id} type="button" class={`chip${value.includes(t.slug) ? ' on' : ''}`} aria-pressed={value.includes(t.slug)} onClick={() => toggle(t.slug)}>
                    {t.name}
                    {t.posts ? <span class="ws-chip-count">{t.posts}</span> : null}
                </button>
            ))}
            {unknown.map(slug => (
                <button key={slug} type="button" class="chip on" aria-pressed="true" title="No tag has this slug yet" onClick={() => toggle(slug)}>
                    {slug}
                    <Icon name="x" size={12} />
                </button>
            ))}
        </div>
    );
}

function PostPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
    const [q, setQ] = useState('');
    const [query, setQuery] = useState('');
    useEffect(() => {
        const t = setTimeout(() => setQuery(q.trim()), 250);
        return () => clearTimeout(t);
    }, [q]);
    const { data } = useLoad(() => api<{ items: Post[] }>(`/posts?type=post&status=published&limit=100${query ? `&q=${encodeURIComponent(query)}` : ''}`), [query]);
    const [known, setKnown] = useState<Record<string, string>>({});
    useEffect(() => {
        if (data) setKnown(k => ({ ...k, ...Object.fromEntries(data.items.map(p => [p.id, p.title])) }));
    }, [data]);
    // Titles for chosen posts that the list doesn't show.
    useEffect(() => {
        for (const id of value.filter(id => !known[id])) api<Post>(`/posts/${id}`).then(p => setKnown(k => ({ ...k, [id]: p.title })), () => setKnown(k => ({ ...k, [id]: 'Post not found' })));
    }, [value.join(',')]);
    const move = (i: number, by: number) => {
        const next = [...value];
        [next[i], next[i + by]] = [next[i + by], next[i]];
        onChange(next);
    };
    const options = (data?.items ?? []).filter(p => !value.includes(p.id)).slice(0, 8);
    return (
        <div class="ws-picker">
            {value.length ? (
                <ol class="ws-chosen">
                    {value.map((id, i) => (
                        <li key={id}>
                            <span class="ws-chosen-n">{i + 1}</span>
                            <span class="ws-chosen-title">{known[id] ?? '…'}</span>
                            <span class="row-tools">
                                <IconButton icon="arrowUp" size={14} label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                                <IconButton icon="arrowDown" size={14} label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)} />
                                <IconButton icon="x" size={14} label="Remove" onClick={() => onChange(value.filter(v => v !== id))} />
                            </span>
                        </li>
                    ))}
                </ol>
            ) : (
                <p class="ws-fine">Choose up to 6 published posts. Anyone who already got one of them skips it.</p>
            )}
            {value.length < 6 ? (
                <>
                    <input type="search" class="search ws-picker-search" placeholder="Find a post" value={q} onInput={e => setQ(e.currentTarget.value)} aria-label="Find a post" />
                    <ul class="ws-options">
                        {options.map(p => (
                            <li key={p.id}>
                                <button type="button" onClick={() => onChange([...value, p.id])}>
                                    <Icon name="plus" size={13} />
                                    <span>{p.title}</span>
                                    <span class="ws-option-date">{fmtDate(p.publishedAt)}</span>
                                </button>
                            </li>
                        ))}
                        {data && !options.length ? <li class="ws-fine">{data.items.length ? 'Every match is chosen already.' : 'No published posts match.'}</li> : null}
                    </ul>
                </>
            ) : null}
        </div>
    );
}

// ------------------------------------------------------------------ the preview

type Device = 'desktop' | 'phone';
type Scheme = 'light' | 'dark';
const WIDTH: Record<Device, number> = { desktop: 660, phone: 390 };

function PreviewPane({ steps, step, from, canTest, you, emailReady }: { steps: Step[]; step: Step; from: string | null; canTest: boolean; you: string | null; emailReady: boolean }) {
    const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
    const dark = typeof matchMedia === 'function' && (document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches));
    const [device, setDevice] = useState<Device>(narrow ? 'phone' : 'desktop');
    const [scheme, setScheme] = useState<Scheme>(dark ? 'dark' : 'light');
    const [preview, setPreview] = useState<Preview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [testing, setTesting] = useState(false);
    const latest = useRef(0);
    const payload = JSON.stringify({ steps, step: step.id });

    // Re-render a moment after typing stops; a slow answer never replaces a newer one.
    useEffect(() => {
        const n = ++latest.current;
        setBusy(true);
        const t = setTimeout(
            () =>
                api<Preview>(`/sequences/${SERIES}/preview`, { body: JSON.parse(payload) })
                    .then(p => n === latest.current && (setPreview(p), setError(null)))
                    .catch(err => n === latest.current && setError(err.message))
                    .finally(() => n === latest.current && setBusy(false)),
            preview ? 350 : 0
        );
        return () => clearTimeout(t);
    }, [payload]);

    const sendTest = async () => {
        setTesting(true);
        try {
            const r = await api<{ to: string }>(`/sequences/${SERIES}/test`, { body: JSON.parse(payload) });
            toast(`Test sent to ${r.to}`);
        } catch (err) {
            errorToast(err);
        } finally {
            setTesting(false);
        }
    };

    const picked = preview?.posts ?? [];
    return (
        <aside class="ws-preview" aria-label="Preview">
            <div class="ws-preview-bar">
                <Segmented
                    label="Width"
                    value={device}
                    options={[
                        { value: 'desktop', label: <Glyph icon="monitor" text="Desktop" /> },
                        { value: 'phone', label: <Glyph icon="smartphone" text="Phone" /> }
                    ]}
                    onChange={setDevice}
                />
                <Segmented
                    label="Color scheme"
                    value={scheme}
                    options={[
                        { value: 'light', label: <Glyph icon="sun" text="Light" /> },
                        { value: 'dark', label: <Glyph icon="moon" text="Dark" /> }
                    ]}
                    onChange={setScheme}
                />
                <span class="ws-spacer" />
                {busy ? <span class="spinner ws-busy" aria-label="Updating the preview" /> : null}
                <Button
                    size="sm"
                    icon="mail"
                    busy={testing}
                    disabled={!canTest}
                    title={!emailReady ? "Email isn't set up on this server" : !you ? 'Sign in as a staff member to get tests' : `Sends this email, as it is now, to ${you}`}
                    onClick={sendTest}
                >
                    Send me a test
                </Button>
            </div>
            <div class="ws-inbox">
                <span class="ws-inbox-mark" aria-hidden="true">
                    {(from ?? 'B').slice(0, 1).toUpperCase()}
                </span>
                <span class="ws-inbox-text">
                    <span class="ws-inbox-top">
                        <b>{from ?? 'Your blog'}</b>
                        <span>now</span>
                    </span>
                    <span class="ws-inbox-subject">{preview?.subject || step.subject || 'No subject'}</span>
                    <span class="ws-inbox-pre">{preview?.preheader || 'No preview text: inboxes show the start of the email instead.'}</span>
                </span>
            </div>
            {error ? <ErrorNote text={error} /> : null}
            <Stage html={preview?.html ?? null} device={device} scheme={scheme} />
            {step.posts.mode !== 'none' ? (
                <div class="ws-picked">
                    <p>{picked.length ? `A new subscriber gets ${picked.length === 1 ? 'this post' : `these ${picked.length} posts`}` : preview ? 'No posts to show: every match was in an earlier email' : 'Picking posts…'}</p>
                    {picked.length ? (
                        <ol>
                            {picked.map(p => (
                                <li key={p.id}>
                                    <span class="ws-picked-title">{p.title}</span>
                                    <span class="ws-picked-why">{[p.opens ? `${fmtNum(p.opens)} opens` : '', p.readers ? `${fmtNum(p.readers)} readers` : '', p.tag ?? ''].filter(Boolean).join(' · ')}</span>
                                </li>
                            ))}
                        </ol>
                    ) : null}
                </div>
            ) : null}
        </aside>
    );
}

function Glyph({ icon, text }: { icon: IconName; text: string }) {
    return (
        <span class="ws-glyph">
            <Icon name={icon} size={14} />
            <span>{text}</span>
        </span>
    );
}

/**
 * The email in a frame at the chosen width, scaled down when the pane is narrower. The frame
 * runs no scripts; links open in a new tab; the scroll position survives each re-render.
 */
function Stage({ html, device, scheme }: { html: string | null; device: Device; scheme: Scheme }) {
    const box = useRef<HTMLDivElement>(null);
    const frame = useRef<HTMLIFrameElement>(null);
    const scroll = useRef(0);
    const [size, setSize] = useState({ w: 0, h: 0 });
    useLayoutEffect(() => {
        const el = box.current!;
        const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const doc = useMemo(() => (html ? html.replace('<head>', '<head><base target="_blank">') : ''), [html]);
    // Each new version opens where the last one was scrolled to.
    const loaded = () => {
        const win = frame.current?.contentWindow;
        if (!win) return;
        win.scrollTo(0, scroll.current);
        win.addEventListener('scroll', () => (scroll.current = win.scrollY), { passive: true });
    };
    const bezel = device === 'phone' ? 12 : 0;
    const width = WIDTH[device] + bezel * 2;
    const scale = size.w ? Math.min(1, (size.w - (device === 'phone' ? 24 : 0)) / width) : 1;
    const height = Math.max(0, (size.h - (device === 'phone' ? 32 : 0)) / scale);
    return (
        <div ref={box} class={`ws-stage ${device}`}>
            {html === null ? (
                <span class="ws-stage-wait">
                    <span class="spinner" /> Rendering the email
                </span>
            ) : (
                <div class="ws-device" style={{ width: `${width}px`, height: `${height}px`, transform: `translateX(-50%) scale(${scale})` }}>
                    <iframe
                        ref={frame}
                        title="Email preview"
                        srcDoc={doc}
                        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                        style={{ colorScheme: scheme }}
                        onLoad={loaded}
                    />
                </div>
            )}
        </div>
    );
}

// ------------------------------------------------------------------ switching it on and off

function ConfirmSwitch({
    turn,
    steps,
    dirty,
    testMode,
    email,
    busy,
    onClose,
    onConfirm
}: {
    turn: 'on' | 'off';
    steps: Step[];
    dirty: boolean;
    testMode: boolean;
    email: boolean;
    busy: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const first = steps[0];
    return (
        <Dialog title={turn === 'on' ? 'Turn on the welcome series?' : 'Turn off the welcome series?'} onClose={onClose} size="sm">
            <div class="stack">
                {turn === 'on' ? (
                    <p class="ws-confirm-text">
                        Everyone who subscribes from now on gets {steps.length === 1 ? 'this email' : `these ${steps.length} emails`}, the first {first?.delay ? `${span(first.delay)} after they subscribe` : 'right away'}. People already on the list
                        don't.
                    </p>
                ) : (
                    <p class="ws-confirm-text">Nobody new joins and nothing more is sent. If you turn it back on, people partway through pick up where they left off, except for emails that would be more than 3 days late.</p>
                )}
                {turn === 'on' && testMode ? <div class="note warn">Test mode is on: only team addresses join. Anyone else who subscribes meanwhile is skipped for good.</div> : null}
                {turn === 'on' && !email ? <div class="note">Email isn't set up on this server yet, so nothing goes out until it is.</div> : null}
                {dirty ? <p class="ws-fine">Your unsaved changes are saved too.</p> : null}
                <div class="dialog-actions">
                    <Button tone="plain" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button tone={turn === 'on' ? 'primary' : 'danger'} busy={busy} onClick={onConfirm} autoFocus>
                        {turn === 'on' ? 'Turn on' : 'Turn off'}
                    </Button>
                </div>
            </div>
        </Dialog>
    );
}

// ------------------------------------------------------------------ who joined

const LEFT: Record<string, string> = { unsubscribed: 'Unsubscribed', bounced: 'Bounced', complained: 'Marked as spam', removed: 'Removed', 'test mode': 'Not on the team' };

function Joiners({ list, steps, testMode }: { list: Joiner[]; steps: number; testMode: boolean }) {
    return (
        <section class="panel ws-joiners">
            <div class="row between">
                <h2>Latest to join</h2>
                {testMode ? <span class="muted small">Test mode: team addresses only</span> : null}
            </div>
            <div class="table-wrap">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Subscriber</th>
                            <th>Joined</th>
                            <th>Progress</th>
                        </tr>
                    </thead>
                    <tbody>
                        {list.map(j => (
                            <tr key={j.id}>
                                <td>
                                    <span class="title-cell">{j.email ?? 'Removed'}</span>
                                </td>
                                <td class="muted nowrap">{fmtDate(j.enrolledAt)}</td>
                                <td class="nowrap">
                                    {j.status === 'done' ? (
                                        <Pill tone="green">Finished</Pill>
                                    ) : j.status === 'stopped' ? (
                                        <Pill tone="neutral">{LEFT[j.reason ?? ''] ?? 'Left'}</Pill>
                                    ) : (
                                        <span class="ws-progress">
                                            <span class="ws-dots" aria-hidden="true">
                                                {Array.from({ length: steps }, (_, i) => (
                                                    <i key={i} class={i < j.sent ? 'on' : ''} />
                                                ))}
                                            </span>
                                            {fmtNum(j.sent)} of {steps} sent{j.nextAt ? `, next ${fmtDate(j.nextAt)}` : ''}
                                        </span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
