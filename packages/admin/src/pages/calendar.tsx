/**
 * The content calendar: what goes out when. Scheduled and published posts sit on the day they go out,
 * drafts on the day they are planned for, colored by where they stand. Drag a scheduled post or a
 * draft to another day, or an idea or an unplanned draft from the side onto a day. Phones get a list.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, dayKey, fromDayKey, type Post } from '../api';
import { Icon } from '../icons';
import { Avatar, Button, Dialog, ErrorNote, Field, IconButton, PageHead, Segmented, errorToast, toast, useLoad } from '../ui';
import { REVIEW_LABEL, type ReviewStatus } from './review-status';

interface Item {
    id: string;
    type: 'post' | 'page';
    title: string;
    status: Post['status'];
    publishedAt: string | null;
    targetDate: string | null;
    featureImage: string | null;
    authors: { id: string; name: string; profileImage: string | null }[];
    review: ReviewStatus | null;
}

interface Idea {
    id: string;
    title: string;
    angle: string | null;
    series: string | null;
}

type Kind = 'published' | 'scheduled' | 'draft' | ReviewStatus;
const KINDS: Kind[] = ['published', 'scheduled', 'approved', 'in_review', 'changes_requested', 'draft'];
const KIND_LABEL: Record<Kind, string> = { published: 'Published', scheduled: 'Scheduled', draft: 'Draft', ...REVIEW_LABEL };
const kindOf = (i: Item): Kind => (i.status === 'published' ? 'published' : i.status === 'scheduled' ? 'scheduled' : (i.review ?? 'draft'));
/** The day an item sits on, in the viewer's time zone. */
const dayOf = (i: Item) => (i.status === 'draft' ? i.targetDate! : dayKey(new Date(i.publishedAt!)));

type View = 'month' | 'week';
type Drag = { kind: 'item'; item: Item } | { kind: 'idea'; idea: Idea } | { kind: 'draft'; post: Post };

const VIEW_KEY = 'masthead-calendar-view';
const SIDE_KEY = 'masthead-calendar-ideas';
const stored = (key: string) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};
/** Per-viewer choices; private windows may refuse storage, and the choice then lasts until reload. */
const store = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Kept in memory only.
    }
};
const readView = (): View => (stored(VIEW_KEY) === 'week' ? 'week' : 'month');

/** 0 for Sunday: the locale's first day of the week. */
function weekStart(): number {
    try {
        const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
        const first = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
        if (first) return first % 7;
    } catch {
        // Older browsers: Sunday.
    }
    return 0;
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d: Date, first: number) => addDays(d, -((d.getDay() - first + 7) % 7));

function visibleDays(view: View, cursor: Date, first: number): Date[] {
    if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor, first), i));
    const start = startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1), first);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const days: Date[] = [];
    for (let d = start; d <= last || days.length % 7; d = addDays(d, 1)) days.push(d);
    return days;
}

const HOUR24 = ['h23', 'h24'].includes(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle ?? '');
/** "9am", "4:30pm", or "16:30" where clocks run to 24. */
function shortTime(iso: string): string {
    const d = new Date(iso);
    if (HOUR24) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const h = d.getHours() % 12 || 12;
    return `${h}${d.getMinutes() ? `:${String(d.getMinutes()).padStart(2, '0')}` : ''}${d.getHours() < 12 ? 'am' : 'pm'}`;
}
const longDay = (key: string) => fromDayKey(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function useNarrow(): boolean {
    const query = '(max-width: 640px)';
    const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
    useEffect(() => {
        const m = matchMedia(query);
        const on = () => setNarrow(m.matches);
        m.addEventListener('change', on);
        return () => m.removeEventListener('change', on);
    }, []);
    return narrow;
}

export function Calendar() {
    const first = useMemo(weekStart, []);
    const narrow = useNarrow();
    const [view, setView] = useState<View>(readView);
    const [side, setSide] = useState(() => stored(SIDE_KEY) !== 'hidden');
    const [cursor, setCursor] = useState(() => {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    });
    const shown: View = narrow ? 'month' : view;
    const days = useMemo(() => visibleDays(shown, cursor, first), [shown, cursor.getTime(), first]);
    const start = dayKey(days[0]);
    const end = dayKey(days[days.length - 1]);
    const today = dayKey(new Date());

    const cal = useLoad(() => api<{ items: Item[] }>(`/calendar?from=${encodeURIComponent(days[0].toISOString())}&to=${encodeURIComponent(addDays(days[days.length - 1], 1).toISOString())}&start=${start}&end=${end}`), [start, end]);
    const ideas = useLoad(() => api<Idea[]>('/ideas'), []);
    const drafts = useLoad(() => api<{ items: Post[] }>('/posts?type=post&status=draft&limit=200').then(r => r.items.filter(p => !p.targetDate)), []);

    const [drag, setDrag] = useState<Drag | null>(null);
    const [over, setOver] = useState<string | null>(null);
    const [moving, setMoving] = useState<{ item: Item; day: string } | null>(null);
    const [planning, setPlanning] = useState<Idea | null>(null);
    const [undo, setUndo] = useState<{ text: string; label?: string; run?: () => void } | null>(null);
    useEffect(() => {
        if (!undo) return;
        const t = setTimeout(() => setUndo(null), 7000);
        return () => clearTimeout(t);
    }, [undo]);

    const byDay = useMemo(() => {
        const map = new Map<string, Item[]>();
        for (const i of cal.data?.items ?? []) map.set(dayOf(i), [...(map.get(dayOf(i)) ?? []), i]);
        // Timed posts first, in time order; then the day's planned drafts.
        for (const list of map.values()) list.sort((a, b) => (a.publishedAt && b.publishedAt ? a.publishedAt.localeCompare(b.publishedAt) : a.publishedAt ? -1 : b.publishedAt ? 1 : a.title.localeCompare(b.title)));
        return map;
    }, [cal.data]);

    const go = (step: number) => setCursor(c => (shown === 'week' ? addDays(c, 7 * step) : new Date(c.getFullYear(), c.getMonth() + step, 1)));
    const toToday = () => setCursor(fromDayKey(today));
    const pickView = (v: View) => {
        setView(v);
        store(VIEW_KEY, v);
    };
    const toggleSide = () => {
        setSide(!side);
        store(SIDE_KEY, side ? 'hidden' : 'shown');
    };

    // ------------------------------------------------------------------ moving things
    const canDrop = (day: string) => !!drag && canDropFor(drag, day, today);
    const setTarget = async (id: string, targetDate: string | null) => api(`/calendar/posts/${id}`, { method: 'PUT', body: { targetDate } });
    const moveDraft = async (item: Item, day: string) => {
        const before = item.targetDate;
        cal.setData(d => (d ? { items: d.items.map(i => (i.id === item.id ? { ...i, targetDate: day } : i)) } : d));
        try {
            await setTarget(item.id, day);
            setUndo({
                text: `Moved “${item.title || 'Untitled'}” to ${longDay(day)}.`,
                label: 'Undo',
                run: async () => {
                    await setTarget(item.id, before).catch(errorToast);
                    cal.reload();
                }
            });
        } catch (err) {
            errorToast(err);
            cal.reload();
        }
    };
    const planDraft = async (post: Post, day: string) => {
        try {
            await setTarget(post.id, day);
            drafts.setData(list => (list ?? []).filter(p => p.id !== post.id));
            cal.reload();
            setUndo({
                text: `Planned “${post.title || 'Untitled'}” for ${longDay(day)}.`,
                label: 'Undo',
                run: async () => {
                    await setTarget(post.id, null).catch(errorToast);
                    cal.reload();
                    drafts.reload();
                }
            });
        } catch (err) {
            errorToast(err);
        }
    };
    const unplan = async (item: Item) => {
        try {
            await setTarget(item.id, null);
            cal.reload();
            drafts.reload();
            setUndo({ text: `“${item.title || 'Untitled'}” is off the calendar.`, label: 'Undo', run: async () => (await setTarget(item.id, item.targetDate).catch(errorToast), cal.reload(), drafts.reload()) });
        } catch (err) {
            errorToast(err);
        }
    };
    const planIdea = async (idea: Idea, day: string) => {
        try {
            const post = await api<Post>(`/calendar/ideas/${idea.id}`, { body: { targetDate: day } });
            ideas.setData(list => (list ?? []).filter(i => i.id !== idea.id));
            cal.reload();
            setUndo({ text: `Draft planned for ${longDay(day)}.`, label: 'Open', run: () => (location.hash = `#/edit/${post.id}`) });
        } catch (err) {
            errorToast(err);
        }
    };
    const drop = (day: string) => {
        const d = drag;
        setDrag(null);
        setOver(null);
        if (!d || !canDropFor(d, day, today)) return;
        if (d.kind === 'idea') planIdea(d.idea, day);
        else if (d.kind === 'draft') planDraft(d.post, day);
        else if (d.item.status === 'scheduled') setMoving({ item: d.item, day });
        else moveDraft(d.item, day);
    };
    const newDraftOn = async (day: string) => {
        try {
            const post = await api<Post>('/posts', { body: { type: 'post', title: '', targetDate: day } });
            location.hash = `#/edit/${post.id}`;
        } catch (err) {
            errorToast(err);
        }
    };
    const dragProps = (d: Drag, title: string) => ({
        draggable: true,
        onDragStart: (e: DragEvent) => {
            e.dataTransfer?.setData('text/plain', title);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            setDrag(d);
        },
        onDragEnd: () => (setDrag(null), setOver(null))
    });
    const dayProps = (key: string) => ({
        onDragOver: (e: DragEvent) => {
            if (!canDrop(key)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            if (over !== key) setOver(key);
        },
        onDragLeave: (e: DragEvent) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(o => (o === key ? null : o));
        },
        onDrop: (e: DragEvent) => (e.preventDefault(), drop(key))
    });

    const title =
        shown === 'week'
            ? `${days[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} to ${days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
            : cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const inMonth = (d: Date) => shown === 'week' || d.getMonth() === cursor.getMonth();
    const draggingDraft = drag?.kind === 'item' && drag.item.status === 'draft';

    return (
        <div class={`calendar${drag ? ' is-dragging' : ''}`}>
            <PageHead title="Calendar" description={narrow ? 'What goes out when, day by day.' : 'What goes out when. Drag a post to move it, or an idea onto a day to plan a draft.'}>
                {narrow ? null : (
                    <Segmented
                        label="View"
                        value={view}
                        options={[
                            { value: 'month', label: 'Month' },
                            { value: 'week', label: 'Week' }
                        ]}
                        onChange={pickView}
                    />
                )}
            </PageHead>
            <div class={`cal-layout${side || narrow ? '' : ' no-side'}`}>
                <section class="cal-main" aria-label="Calendar">
                    <div class="cal-bar">
                        <div class="cal-nav">
                            <IconButton icon="chevronLeft" label={shown === 'week' ? 'Previous week' : 'Previous month'} onClick={() => go(-1)} />
                            <IconButton icon="chevronRight" label={shown === 'week' ? 'Next week' : 'Next month'} onClick={() => go(1)} />
                            <h2 class="cal-title" aria-live="polite">
                                {title}
                            </h2>
                        </div>
                        <div class="cal-bar-end">
                            {cal.loading && cal.data ? <span class="spinner cal-spin" aria-label="Loading" /> : null}
                            {narrow ? null : (
                                <Button size="sm" tone="plain" icon="ideas" aria-pressed={side} title={side ? 'Hide ideas and unplanned drafts' : 'Show ideas and unplanned drafts'} onClick={toggleSide}>
                                    {side ? 'Hide ideas' : 'Ideas'}
                                </Button>
                            )}
                            <Button size="sm" onClick={toToday}>
                                Today
                            </Button>
                        </div>
                    </div>
                    <ul class="cal-legend" aria-label="Colors">
                        {KINDS.map(k => (
                            <li key={k} class={`k-${k}`}>
                                <span class="cal-dot" />
                                {KIND_LABEL[k]}
                            </li>
                        ))}
                    </ul>
                    {cal.error ? <ErrorNote text={cal.error} /> : null}
                    {narrow ? (
                        <Agenda days={days.filter(inMonth)} byDay={byDay} today={today} loading={!cal.data} />
                    ) : (
                        <div class={`cal-grid ${shown}${cal.data ? '' : ' is-loading'}`} role="grid" aria-label={title}>
                            <div class="cal-weekdays" role="row">
                                {days.slice(0, 7).map(d => (
                                    <span key={d.getDay()} role="columnheader" class="cal-weekday">
                                        {d.toLocaleDateString(undefined, { weekday: 'short' })}
                                    </span>
                                ))}
                            </div>
                            <div class="cal-days">
                                {days.map(d => {
                                    const key = dayKey(d);
                                    const items = byDay.get(key) ?? [];
                                    const max = shown === 'week' ? Infinity : 3;
                                    const more = items.length - Math.min(items.length, max);
                                    return (
                                        <div
                                            key={key}
                                            role="gridcell"
                                            class={`cal-day${key === today ? ' is-today' : ''}${inMonth(d) ? '' : ' is-outside'}${key < today ? ' is-past' : ''}${over === key ? ' is-over' : ''}${drag && canDrop(key) ? ' can-drop' : ''}`}
                                            aria-label={fromDayKey(key).toLocaleDateString(undefined, { dateStyle: 'full' })}
                                            {...dayProps(key)}
                                        >
                                            <div class="cal-day-head">
                                                <span class="cal-date">{shown === 'week' ? <>{d.toLocaleDateString(undefined, { weekday: 'short' })} <b>{d.getDate()}</b></> : d.getDate() === 1 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.getDate()}</span>
                                                {key >= today ? <IconButton icon="plus" label={`New draft for ${longDay(key)}`} size={14} class="cal-add" tooltip={false} onClick={() => newDraftOn(key)} /> : null}
                                            </div>
                                            <div class="cal-items">
                                                {items.slice(0, max).map(i =>
                                                    shown === 'week' ? <Card key={i.id} item={i} drag={dragProps} /> : <Chip key={i.id} item={i} drag={dragProps} />
                                                )}
                                                {more > 0 ? (
                                                    <button type="button" class="cal-more" onClick={() => (setCursor(d), pickView('week'))}>
                                                        {more} more
                                                    </button>
                                                ) : null}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </section>
                {side || narrow ? (
                    <Planner
                        ideas={ideas.data}
                        drafts={drafts.data}
                        narrow={narrow}
                        dragProps={dragProps}
                        dropping={draggingDraft}
                        onUnplan={() => drag?.kind === 'item' && (unplan(drag.item), setDrag(null))}
                        onPlan={setPlanning}
                    />
                ) : null}
            </div>
            {undo ? (
                <div class="cal-undo" role="status">
                    <span>{undo.text}</span>
                    {undo.run ? (
                        <button type="button" class="cal-undo-btn" onClick={() => (undo.run!(), setUndo(null))}>
                            {undo.label}
                        </button>
                    ) : null}
                    <button type="button" class="icon-btn cal-undo-close" aria-label="Dismiss" onClick={() => setUndo(null)}>
                        <Icon name="x" size={14} />
                    </button>
                </div>
            ) : null}
            {moving ? <Reschedule item={moving.item} day={moving.day} onClose={() => setMoving(null)} onDone={() => (setMoving(null), cal.reload())} /> : null}
            {planning ? <PlanIdea idea={planning} today={today} onClose={() => setPlanning(null)} onPlan={day => (setPlanning(null), planIdea(planning, day))} /> : null}
        </div>
    );
}

function canDropFor(d: Drag, day: string, today: string): boolean {
    if (day < today) return false;
    return d.kind !== 'item' || (d.item.status !== 'published' && dayOf(d.item) !== day);
}

type DragProps = (d: Drag, title: string) => Record<string, unknown>;

function itemTitle(i: Item): string {
    const who = i.authors.map(a => a.name).join(', ');
    const when = i.publishedAt ? new Date(i.publishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : `planned for ${longDay(i.targetDate!)}`;
    return `${i.title || 'Untitled'}\n${KIND_LABEL[kindOf(i)]}, ${when}${who ? `\nBy ${who}` : ''}`;
}

function Chip({ item, drag }: { item: Item; drag: DragProps }) {
    const kind = kindOf(item);
    return (
        <a class={`cal-chip k-${kind}`} href={`#/edit/${item.id}`} title={itemTitle(item)} {...(item.status === 'published' ? { draggable: false } : drag({ kind: 'item', item }, item.title))}>
            <span class="cal-dot" aria-hidden="true" />
            <span class="cal-chip-text">
                <span class="cal-chip-title">{item.title || 'Untitled'}</span>
                {item.publishedAt ? <span class="cal-chip-time">{shortTime(item.publishedAt)}</span> : null}
            </span>
            <span class="an-sr">, {KIND_LABEL[kind]}</span>
        </a>
    );
}

function Card({ item, drag }: { item: Item; drag: DragProps }) {
    const kind = kindOf(item);
    const author = item.authors[0];
    return (
        <a class={`cal-card k-${kind}`} href={`#/edit/${item.id}`} title={itemTitle(item)} {...(item.status === 'published' ? { draggable: false } : drag({ kind: 'item', item }, item.title))}>
            <span class="cal-card-top">
                <span class="cal-dot" aria-hidden="true" />
                <span class="cal-card-kind">{KIND_LABEL[kind]}</span>
            </span>
            {item.publishedAt ? <span class="cal-card-time">{shortTime(item.publishedAt)}</span> : null}
            <span class="cal-card-title">{item.title || 'Untitled'}</span>
            {author ? (
                <span class="cal-card-foot">
                    <Avatar name={author.name} src={author.profileImage} size={18} />
                    <span>{author.name}</span>
                </span>
            ) : null}
        </a>
    );
}

/** Phones: the month as a list of the days that have something on them. */
function Agenda({ days, byDay, today, loading }: { days: Date[]; byDay: Map<string, Item[]>; today: string; loading: boolean }) {
    const withItems = days.map(d => dayKey(d)).filter(k => byDay.has(k));
    if (loading) return <p class="cal-agenda-empty">Loading…</p>;
    if (!withItems.length) return <p class="cal-agenda-empty">Nothing planned this month.</p>;
    return (
        <ol class="cal-agenda">
            {withItems.map(key => (
                <li key={key} class={`cal-agenda-day${key === today ? ' is-today' : ''}${key < today ? ' is-past' : ''}`}>
                    <h3 class="cal-agenda-date">
                        {key === today ? <span class="cal-agenda-today">Today</span> : null}
                        {fromDayKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                    </h3>
                    <ul>
                        {byDay.get(key)!.map(i => {
                            const kind = kindOf(i);
                            return (
                                <li key={i.id}>
                                    <a class={`cal-agenda-item k-${kind}`} href={`#/edit/${i.id}`}>
                                        <span class="cal-agenda-time">{i.publishedAt ? shortTime(i.publishedAt) : 'Planned'}</span>
                                        <span class="cal-agenda-main">
                                            <span class="cal-agenda-title">{i.title || 'Untitled'}</span>
                                            <span class="cal-agenda-meta">
                                                <span class="cal-kind">
                                                    <span class="cal-dot" aria-hidden="true" />
                                                    {KIND_LABEL[kind]}
                                                </span>
                                                {i.authors[0] ? <span>{i.authors[0].name}</span> : null}
                                            </span>
                                        </span>
                                        <Icon name="chevronRight" size={16} class="cal-agenda-go" />
                                    </a>
                                </li>
                            );
                        })}
                    </ul>
                </li>
            ))}
        </ol>
    );
}

/** The side: ideas and drafts without a day, to drag onto one. A draft dragged here comes off the calendar. */
function Planner(props: { ideas: Idea[] | null; drafts: Post[] | null; narrow: boolean; dragProps: DragProps; dropping: boolean; onUnplan: () => void; onPlan: (idea: Idea) => void }) {
    const [tab, setTab] = useState<'ideas' | 'drafts'>('ideas');
    const [over, setOver] = useState(false);
    const list = tab === 'ideas' ? props.ideas : props.drafts;
    return (
        <aside
            class={`cal-side${props.dropping ? ' can-drop' : ''}${over ? ' is-over' : ''}`}
            aria-label="Plan"
            onDragOver={e => {
                if (!props.dropping) return;
                e.preventDefault();
                setOver(true);
            }}
            onDragLeave={e => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node) && setOver(false)}
            onDrop={e => (e.preventDefault(), setOver(false), props.onUnplan())}
        >
            <Segmented
                label="Plan"
                value={tab}
                options={[
                    { value: 'ideas', label: 'Ideas', count: props.ideas?.length ?? null },
                    { value: 'drafts', label: 'Unplanned', count: props.drafts?.length ?? null }
                ]}
                onChange={setTab}
            />
            <p class="cal-side-hint">{props.dropping ? 'Drop here to take it off the calendar.' : props.narrow ? 'Pick a day for an idea to plan its draft.' : tab === 'ideas' ? 'Drag an idea onto a day to plan a draft for it.' : 'Drafts without a day. Drag one onto the calendar.'}</p>
            {list === null ? (
                <p class="cal-side-empty">Loading…</p>
            ) : !list.length ? (
                <p class="cal-side-empty">
                    {tab === 'ideas' ? (
                        <>
                            No ideas waiting. <a href="#/ideas">Add some</a>.
                        </>
                    ) : (
                        'Every draft has a day.'
                    )}
                </p>
            ) : (
                <ul class="cal-side-list">
                    {tab === 'ideas'
                        ? (list as Idea[]).map(idea => (
                              <li key={idea.id} class="cal-idea" {...(props.narrow ? {} : props.dragProps({ kind: 'idea', idea }, idea.title))}>
                                  {props.narrow ? null : <Icon name="grip" size={14} class="cal-grip" />}
                                  <span class="cal-idea-text">
                                      <span class="cal-idea-title">{idea.title}</span>
                                      {idea.angle ? <span class="cal-idea-angle">{idea.angle}</span> : null}
                                  </span>
                                  <IconButton icon="calendarPlus" label="Plan on a day" size={15} tooltip={false} onClick={() => props.onPlan(idea)} />
                              </li>
                          ))
                        : (list as Post[]).map(post => (
                              <li key={post.id} class="cal-idea" {...(props.narrow ? {} : props.dragProps({ kind: 'draft', post }, post.title))}>
                                  {props.narrow ? null : <Icon name="grip" size={14} class="cal-grip" />}
                                  <a class="cal-idea-text" href={`#/edit/${post.id}`}>
                                      <span class="cal-idea-title">{post.title || 'Untitled'}</span>
                                      <span class="cal-idea-angle">Draft{post.review ? `, ${REVIEW_LABEL[post.review.status].toLowerCase()}` : ''}</span>
                                  </a>
                              </li>
                          ))}
                </ul>
            )}
        </aside>
    );
}

function Reschedule({ item, day, onClose, onDone }: { item: Item; day: string; onClose: () => void; onDone: () => void }) {
    const old = new Date(item.publishedAt!);
    const pad = (n: number) => String(n).padStart(2, '0');
    const [time, setTime] = useState(`${pad(old.getHours())}:${pad(old.getMinutes())}`);
    const [busy, setBusy] = useState(false);
    const when = fromDayKey(day);
    const [h, m] = time.split(':').map(Number);
    when.setHours(h || 0, m || 0, 0, 0);
    const past = !time || when.getTime() <= Date.now() + 60_000;
    const go = async () => {
        setBusy(true);
        try {
            await api(`/posts/${item.id}/publish`, { body: { publishedAt: when.toISOString() } });
            toast(`Rescheduled for ${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`);
            onDone();
        } catch (err) {
            errorToast(err);
            setBusy(false);
        }
    };
    return (
        <Dialog title="Reschedule this post?" description={item.title || 'Untitled'} onClose={onClose} size="sm">
            <dl class="cal-move">
                <dt>Now</dt>
                <dd>{old.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd>
                <dt>Moves to</dt>
                <dd class="cal-move-to">
                    <span>{longDay(day)}</span>
                    <input type="time" value={time} onInput={e => setTime(e.currentTarget.value)} aria-label="Time" />
                </dd>
            </dl>
            {past ? <p class="note warn cal-move-note">That time has passed. Pick a later one.</p> : <p class="muted small cal-move-note">It goes live then. Sending it by email stays a separate step.</p>}
            <div class="dialog-actions">
                <Button onClick={onClose}>Cancel</Button>
                <Button tone="primary" busy={busy} disabled={past} onClick={go}>
                    Reschedule
                </Button>
            </div>
        </Dialog>
    );
}

/** Planning an idea without dragging: pick the day. */
function PlanIdea({ idea, today, onClose, onPlan }: { idea: Idea; today: string; onClose: () => void; onPlan: (day: string) => void }) {
    const [day, setDay] = useState(today);
    return (
        <Dialog title="Plan a draft" description={idea.title} onClose={onClose} size="sm">
            <form class="stack" onSubmit={e => (e.preventDefault(), day >= today && onPlan(day))}>
                <Field label="Target date" hint="A draft is made for it, planned for that day. The idea's angle and sources are kept as a comment on it.">
                    <input type="date" required min={today} value={day} onInput={e => setDay(e.currentTarget.value)} autoFocus />
                </Field>
                <div class="dialog-actions">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button tone="primary" type="submit" disabled={!day || day < today}>
                        Plan draft
                    </Button>
                </div>
            </form>
        </Dialog>
    );
}
