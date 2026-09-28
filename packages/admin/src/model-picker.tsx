/**
 * The model picker: a button that shows the model, and a searchable menu of the
 * whole catalog grouped by provider. Only the rows in view are drawn, so the
 * text catalog's four hundred and more models scroll and filter smoothly. On a
 * phone the menu rises from the bottom as a sheet.
 */
import { render, type ComponentChildren } from 'preact';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';
import { groupModels, haystack, hintsOf, isNew, modelName, priceOf, providerKey, providerLabels, strongest, useModels, type Model, type ModelKind } from './models';
import { Button } from './ui';

type Item = { type: 'head'; key: string; label: string; note?: string } | { type: 'option'; key: string; model: Model };

const ROW = 52;
const HEAD = 30;
const OVERSCAN = 6;
/** Indexes into the list; the site default row sits above it, so it has its own. */
const SITE = -1;
const NONE = -2;
const heightOf = (it: Item) => (it.type === 'head' ? HEAD : ROW);

const termsOf = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** What the list shows: the strongest models (text, before any search), then each provider's. */
function buildItems(models: Model[], query: string, kind: ModelKind): Item[] {
    const labels = providerLabels(models);
    const terms = termsOf(query);
    const items: Item[] = [];
    if (!terms.length && kind === 'text') {
        const top = strongest(models);
        if (top.length) {
            items.push({ type: 'head', key: 'h:top', label: 'Most capable', note: 'By benchmark score' });
            for (const m of top) items.push({ type: 'option', key: `top:${m.id}`, model: m });
        }
    }
    for (const group of groupModels(models)) {
        const hits = terms.length ? group.models.filter(m => terms.every(t => haystack(m, labels).includes(t))) : group.models;
        if (!hits.length) continue;
        items.push({ type: 'head', key: `h:${group.key}`, label: group.label, note: String(hits.length) });
        for (const m of hits) items.push({ type: 'option', key: m.id, model: m });
    }
    return items;
}

/**
 * Draws its children at the end of <body>, clear of any parent that scrolls, clips or makes a
 * containing block for fixed elements (dialogs and the editor bar blur what is behind them).
 * preact/compat's createPortal would do the same, but importing compat changes how every
 * element's events are wired.
 */
function Portal({ children }: { children: ComponentChildren }) {
    const host = useRef<HTMLDivElement | null>(null);
    host.current ??= document.createElement('div');
    useLayoutEffect(() => {
        const el = host.current!;
        document.body.append(el);
        return () => {
            render(null, el);
            el.remove();
        };
    }, []);
    useLayoutEffect(() => render(<>{children}</>, host.current!));
    return null;
}

function useMedia(query: string): boolean {
    const [on, setOn] = useState(() => matchMedia(query).matches);
    useEffect(() => {
        const mq = matchMedia(query);
        const change = () => setOn(mq.matches);
        mq.addEventListener('change', change);
        return () => mq.removeEventListener('change', change);
    }, [query]);
    return on;
}

/** The provider's initial, standing in for its logo. */
function Mark({ label, site }: { label?: string; site?: boolean }) {
    return (
        <span class={`model-mark${site ? ' site' : ''}`} aria-hidden="true">
            {site || !label ? <Icon name="sparkles" size={12} /> : (label.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()}
        </span>
    );
}

export interface ModelPickerProps {
    kind: ModelKind;
    /** A model id. null: the site default with `allowDefault`, otherwise nothing chosen yet. */
    value: string | null;
    onChange: (id: string | null) => void;
    /** Lists "Use site default" first; choosing it gives null. */
    allowDefault?: boolean;
    /** What the choice is for, e.g. "Writing model". Screen readers hear it with the value. */
    label: string;
    disabled?: boolean;
    /** A borderless chip, for footers and toolbars. */
    compact?: boolean;
}

export function ModelPicker({ kind, value, onChange, allowDefault = false, label, disabled, compact }: ModelPickerProps) {
    const { models, error, retry } = useModels(kind);
    const [open, setOpen] = useState<{ query: string } | null>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const site = models?.find(m => m.isDefault);
    const chosen = value ? models?.find(m => m.id === value) : allowDefault ? site : undefined;
    const missing = !!value && !!models && !chosen;
    const text = chosen ? modelName(chosen) : value ? value : allowDefault ? 'Site default' : 'Choose a model';
    const tag = missing ? 'Unavailable' : chosen && (value === null || chosen.isDefault) ? 'Default' : null;

    const close = (refocus: boolean) => {
        setOpen(null);
        if (refocus) trigger.current?.focus();
    };
    const onKeyDown = (e: KeyboardEvent) => {
        if (open) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), setOpen({ query: '' }));
        // Typing on the closed control starts a search with what was typed.
        else if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) (e.preventDefault(), setOpen({ query: e.key }));
    };

    return (
        <>
            <button
                ref={trigger}
                type="button"
                class={`model-trigger${compact ? ' compact' : ''}${missing ? ' missing' : ''}`}
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={!!open}
                aria-label={`${label}: ${text}${tag ? `, ${tag.toLowerCase()}` : ''}`}
                title={missing ? 'Not in the model list any more' : undefined}
                onClick={() => setOpen(open ? null : { query: '' })}
                onKeyDown={onKeyDown}
            >
                <Mark label={chosen && models ? providerLabels(models).get(providerKey(chosen.id)) : undefined} />
                <span class="model-trigger-name">{text}</span>
                {tag ? <span class={`model-tag${missing ? ' warn' : ''}`}>{tag}</span> : null}
                <Icon name="chevronsUpDown" size={14} class="model-trigger-icon" />
            </button>
            {open && trigger.current ? (
                <Portal>
                    <ModelMenu
                        anchor={trigger.current}
                        kind={kind}
                        models={models}
                        error={error}
                        retry={retry}
                        value={value}
                        allowDefault={allowDefault}
                        label={label}
                        initialQuery={open.query}
                        onPick={id => (close(true), id !== value && onChange(id))}
                        onClose={close}
                    />
                </Portal>
            ) : null}
        </>
    );
}

interface Placement {
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
}

function ModelMenu(props: {
    anchor: HTMLElement;
    kind: ModelKind;
    models: Model[] | null;
    error: string | null;
    retry: () => void;
    value: string | null;
    allowDefault: boolean;
    label: string;
    initialQuery: string;
    onPick: (id: string | null) => void;
    onClose: (refocus: boolean) => void;
}) {
    const { anchor, kind, models, value, label, onPick, onClose } = props;
    const [query, setQuery] = useState(props.initialQuery);
    const [active, setActive] = useState(NONE);
    const [view, setView] = useState({ top: 0, height: 0 });
    const [place, setPlace] = useState<Placement | null>(null);
    const pop = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const id = useId();
    const sheet = useMedia('(max-width: 640px)');
    const items = useMemo(() => (models ? buildItems(models, query, kind) : []), [models, query, kind]);
    const layout = useMemo(() => {
        const tops: number[] = [];
        let y = 0;
        for (const it of items) (tops.push(y), (y += heightOf(it)));
        return { tops, total: y };
    }, [items]);
    const labels = useMemo(() => (models ? providerLabels(models) : new Map<string, string>()), [models]);
    const site = models?.find(m => m.isDefault) ?? null;
    // "Use site default" stays above the list, so it is one step away however far the list scrolls.
    const showSite = props.allowDefault && !!models && termsOf(query).every(t => `use site default ${site ? haystack(site, labels) : ''}`.includes(t));
    // Everything the arrow keys step through, in order.
    const steps = useMemo(() => [...(showSite ? [SITE] : []), ...items.flatMap((it, i) => (it.type === 'option' ? [i] : []))], [items, showSite]);
    const first = steps[0] ?? NONE;

    // Under the button, or above it when there is more room there; a sheet on phones.
    useLayoutEffect(() => {
        if (sheet) return setPlace(null);
        const update = () => {
            const r = anchor.getBoundingClientRect();
            if (r.bottom < 0 || r.top > innerHeight) return onClose(false);
            const width = Math.min(Math.max(r.width, 420), innerWidth - 16);
            const left = Math.min(Math.max(8, r.left), innerWidth - width - 8);
            const below = innerHeight - r.bottom - 14;
            const above = r.top - 14;
            setPlace(below >= 320 || below >= above ? { left, width, top: r.bottom + 6, maxHeight: Math.min(480, below) } : { left, width, bottom: innerHeight - r.top + 6, maxHeight: Math.min(480, above) });
        };
        update();
        let frame = 0;
        const later = (e: Event) => {
            if (e.target instanceof Node && pop.current?.contains(e.target)) return;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(update);
        };
        window.addEventListener('resize', later);
        window.addEventListener('scroll', later, true);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('resize', later);
            window.removeEventListener('scroll', later, true);
        };
    }, [sheet]);

    useEffect(() => {
        const down = (e: PointerEvent) => {
            const t = e.target as Node;
            if (!pop.current?.contains(t) && !anchor.contains(t)) onClose(false);
        };
        document.addEventListener('pointerdown', down, true);
        // Keyboards and mice start in the search box; a touch screen waits for a tap, so its keyboard doesn't cover the list.
        if (!matchMedia('(pointer: coarse)').matches) input.current?.focus({ preventScroll: true });
        document.documentElement.classList.toggle('has-sheet', sheet);
        return () => {
            document.removeEventListener('pointerdown', down, true);
            document.documentElement.classList.remove('has-sheet');
        };
    }, [sheet]);

    // The list measures itself, so only the rows in view are drawn.
    useLayoutEffect(() => {
        const el = list.current;
        if (!el) return;
        const measure = () => setView(v => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // It opens on the current choice: the site default, or the model, in the middle of the list.
    const opened = useRef(false);
    useLayoutEffect(() => {
        const el = list.current;
        if (opened.current || !el || !models || (!sheet && !place)) return;
        opened.current = true;
        let i = first;
        if (!query && value === null && showSite) i = SITE;
        else if (!query && value !== null) {
            const at = items.findIndex(it => it.type === 'option' && it.model.id === value);
            if (at >= 0) i = at;
        }
        setActive(i);
        el.scrollTop = i >= 0 ? Math.max(0, layout.tops[i] - (el.clientHeight - ROW) / 2) : 0;
        setView({ top: el.scrollTop, height: el.clientHeight });
    }, [items, place, sheet]);

    // A new search starts at the top of what it found.
    const searched = useRef(query);
    useLayoutEffect(() => {
        if (searched.current === query) return;
        searched.current = query;
        setActive(first);
        if (list.current) list.current.scrollTop = 0;
        setView(v => ({ ...v, top: 0 }));
    }, [query]);

    /** Scrolls a row into view, with its group's heading when it is the first in the group. */
    const reveal = (i: number) => {
        const el = list.current;
        if (!el || i < 0) return;
        const top = items[i - 1]?.type === 'head' ? layout.tops[i - 1] : layout.tops[i] - HEAD;
        if (top < el.scrollTop) el.scrollTop = Math.max(0, top);
        else if (layout.tops[i] + ROW > el.scrollTop + el.clientHeight) el.scrollTop = layout.tops[i] + ROW - el.clientHeight;
    };
    const move = (by: number) => {
        if (!steps.length) return;
        const at = steps.indexOf(active);
        const i = steps[at < 0 ? 0 : Math.min(steps.length - 1, Math.max(0, at + by))];
        setActive(i);
        reveal(i);
    };
    const pick = (i: number) => {
        if (i === SITE) return onPick(null);
        const it = items[i];
        if (it?.type === 'option') onPick(it.model.id);
    };
    const onKeyDown = (e: KeyboardEvent) => {
        const keys: Record<string, () => void> = {
            ArrowDown: () => move(1),
            ArrowUp: () => move(-1),
            PageDown: () => move(8),
            PageUp: () => move(-8),
            Enter: () => pick(active),
            Escape: () => onClose(true),
            Tab: () => onClose(true)
        };
        const run = keys[e.key];
        if (!run) {
            // Typing goes to the search, wherever focus was (a sheet on a touch screen starts without it).
            if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && document.activeElement !== input.current) input.current?.focus({ preventScroll: true });
            return;
        }
        // Kept from dialogs and the editor, which have their own Escape and arrows.
        e.preventDefault();
        e.stopPropagation();
        run();
    };
    // The keys work wherever focus is while the menu is open, ahead of the page's own shortcuts.
    const keyHandler = useRef(onKeyDown);
    keyHandler.current = onKeyDown;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => keyHandler.current(e);
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    // The rows in view, plus a few either side.
    let start = 0;
    while (start < items.length && layout.tops[start] + heightOf(items[start]) <= view.top) start++;
    let end = start;
    while (end < items.length && layout.tops[end] < view.top + (view.height || 480)) end++;
    const from = Math.max(0, start - OVERSCAN);
    const to = Math.min(items.length, end + OVERSCAN);

    // The heading of the group scrolled under the top edge stays in view; the next one pushes it out.
    let stuck = -1;
    let next = -1;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type !== 'head') continue;
        if (layout.tops[i] < view.top) stuck = i;
        else {
            next = i;
            break;
        }
    }
    const pinned = stuck >= 0 ? (items[stuck] as Extract<Item, { type: 'head' }>) : null;
    const push = next >= 0 ? Math.min(0, layout.tops[next] - view.top - HEAD) : 0;

    const total = models?.length ?? 0;
    const shown = new Set(items.flatMap(it => (it.type === 'option' ? [it.model.id] : []))).size;
    const priced = !!models?.some(m => priceOf(m));
    const optionId = (i: number) => (i === SITE ? `${id}-site` : `${id}-${i}`);

    return (
        <>
            {sheet ? <div class="model-scrim" aria-hidden="true" /> : null}
            <div
                ref={pop}
                class={`model-pop${sheet ? ' sheet' : ''}`}
                role="dialog"
                aria-label={label}
                style={sheet ? undefined : place ? { left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight } : { visibility: 'hidden' }}
            >
                {sheet ? (
                    <div class="model-sheet-head">
                        <span>{label}</span>
                        <button type="button" class="icon-btn" aria-label="Close" onClick={() => onClose(true)}>
                            <Icon name="x" size={16} />
                        </button>
                    </div>
                ) : null}
                <div class="model-search">
                    <Icon name="search" size={15} />
                    <input
                        ref={input}
                        type="text"
                        role="combobox"
                        aria-expanded="true"
                        aria-controls={id}
                        aria-autocomplete="list"
                        aria-activedescendant={active === SITE || (active >= from && active < to) ? optionId(active) : undefined}
                        aria-label={`Search ${label.toLowerCase()}s`}
                        placeholder={total ? `Search ${total} models` : 'Search models'}
                        value={query}
                        autocomplete="off"
                        spellcheck={false}
                        onInput={e => setQuery(e.currentTarget.value)}
                    />
                    {query ? (
                        <button type="button" class="icon-btn" aria-label="Clear the search" onMouseDown={e => e.preventDefault()} onClick={() => (setQuery(''), input.current?.focus())}>
                            <Icon name="x" size={14} />
                        </button>
                    ) : sheet ? null : (
                        <kbd>esc</kbd>
                    )}
                </div>
                <div class="model-options" id={id} role="listbox" aria-label={label} aria-busy={!models && !props.error}>
                    {showSite ? (
                        <div class="model-site">
                            <Row id={optionId(SITE)} labels={labels} site={site} selected={value === null} active={active === SITE} onHover={() => active !== SITE && setActive(SITE)} onPick={() => pick(SITE)} />
                        </div>
                    ) : null}
                    <div class="model-body">
                        {pinned ? (
                            <div class="model-group pinned" aria-hidden="true" style={{ transform: `translateY(${push}px)` }}>
                                {pinned.label}
                                {pinned.note ? <span>{pinned.note}</span> : null}
                            </div>
                        ) : null}
                        <div ref={list} class="model-list" onScroll={e => setView(v => ({ ...v, top: e.currentTarget.scrollTop }))}>
                            {!models ? (
                                props.error ? (
                                    <div class="model-empty">
                                        <span>{props.error}</span>
                                        <Button size="sm" onClick={props.retry}>
                                            Try again
                                        </Button>
                                    </div>
                                ) : (
                                    <div class="model-loading">
                                        {[62, 48, 70, 55, 40].map((w, i) => (
                                            <span key={i} class="model-loading-row">
                                                <span class="skeleton" style={{ width: 22, height: 22, borderRadius: 6 }} />
                                                <span class="skeleton" style={{ width: `${w}%`, height: 9 }} />
                                            </span>
                                        ))}
                                    </div>
                                )
                            ) : !items.length ? (
                                showSite ? null : <div class="model-empty">No models match "{query}".</div>
                            ) : (
                                <div class="model-canvas" role="presentation" style={{ height: layout.total }}>
                                    {items.slice(from, to).map((it, n) => {
                                        const i = from + n;
                                        const top = layout.tops[i];
                                        return it.type === 'head' ? (
                                            <div key={it.key} class="model-group" role="presentation" style={{ top }}>
                                                {it.label}
                                                {it.note ? <span>{it.note}</span> : null}
                                            </div>
                                        ) : (
                                            <Row
                                                key={it.key}
                                                id={optionId(i)}
                                                model={it.model}
                                                labels={labels}
                                                site={site}
                                                selected={it.model.id === value}
                                                active={i === active}
                                                top={top}
                                                onHover={() => i !== active && setActive(i)}
                                                onPick={() => pick(i)}
                                            />
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
                {models ? (
                    <div class="model-foot">
                        <span>{priced ? 'Prices in credits' : ''}</span>
                        <span>{shown === total ? `${total} models` : `${shown} of ${total}`}</span>
                    </div>
                ) : null}
            </div>
        </>
    );
}

/** One choice: a model with its provider, hints and price, or (no model) the site default. */
function Row(props: { id: string; model?: Model; labels: Map<string, string>; site: Model | null; selected: boolean; active: boolean; top?: number; onHover: () => void; onPick: () => void }) {
    const { model: m, labels, site } = props;
    const price = m ? priceOf(m) : null;
    const provider = m ? labels.get(providerKey(m.id)) : undefined;
    return (
        <div
            id={props.id}
            role="option"
            aria-selected={props.selected}
            class={`model-row${props.active ? ' active' : ''}${props.selected ? ' selected' : ''}`}
            style={props.top == null ? undefined : { top: props.top }}
            onMouseMove={props.onHover}
            onMouseDown={e => e.preventDefault()}
            onClick={props.onPick}
        >
            <Mark label={provider} site={!m} />
            <span class="model-main">
                <span class="model-line">
                    <span class="model-name">{m ? modelName(m) : 'Use site default'}</span>
                    {m?.isDefault ? <span class="model-tag">Default</span> : null}
                    {m && isNew(m) ? <span class="model-tag new">New</span> : null}
                </span>
                <span class="model-meta">
                    {m ? [provider, ...hintsOf(m)].filter(Boolean).join(' · ') : site ? `Now ${modelName(site)}, from ${labels.get(providerKey(site.id)) ?? 'Settings'}` : 'Set it in Settings, AI'}
                </span>
            </span>
            {price ? (
                <span class="model-price" title={price.title}>
                    <span>{price.value}</span>
                    {price.unit ? <span class="model-unit">{price.unit}</span> : null}
                </span>
            ) : null}
            <span class="model-check">{props.selected ? <Icon name="check" size={15} /> : null}</span>
        </div>
    );
}
