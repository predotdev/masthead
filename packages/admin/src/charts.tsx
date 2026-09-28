/**
 * Small charts for Analytics, drawn as inline SVG: one axis, hairline grid, a
 * crosshair and tooltip on hover or arrow keys, and a table view of every chart.
 * Colors come from the --an-* tokens in style.css, so they follow light and dark.
 */
import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export type Unit = 'day' | 'week' | 'month';

// ------------------------------------------------------------------ numbers and dates

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? '–' : Math.round(n).toLocaleString());

/** 950, 12,480 and 1.2M: short enough for a tile, exact below ten thousand. */
export function compact(n: number | null | undefined): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return '–';
    const a = Math.abs(n);
    if (a < 10_000) return Math.round(n).toLocaleString();
    if (a < 1_000_000) return `${(n / 1000).toFixed(a < 100_000 ? 1 : 0).replace(/\.0$/, '')}K`;
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export const pct = (r: number | null | undefined, digits = 1) => (r === null || r === undefined || !Number.isFinite(r) ? '–' : `${(r * 100).toFixed(digits).replace(/\.0$/, '')}%`);

const UTC = { timeZone: 'UTC' } as const;
const DAY_FMT = new Intl.DateTimeFormat(undefined, { ...UTC, month: 'short', day: 'numeric' });
const DAY_YEAR_FMT = new Intl.DateTimeFormat(undefined, { ...UTC, month: 'short', day: 'numeric', year: 'numeric' });
const LONG_FMT = new Intl.DateTimeFormat(undefined, { ...UTC, weekday: 'short', month: 'short', day: 'numeric' });
const MONTH_FMT = new Intl.DateTimeFormat(undefined, { ...UTC, month: 'short', year: 'numeric' });
const date = (s: string) => new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
const thisYear = new Date().getUTCFullYear();

/** A bucket's label: "Sep 12", "Week of Sep 8" or "Sep 2026"; the long form is for tooltips. */
export function bucketLabel(b: string, unit: Unit, long = false): string {
    const d = date(b);
    if (unit === 'month') return MONTH_FMT.format(d);
    const day = d.getUTCFullYear() === thisYear ? (long && unit === 'day' ? LONG_FMT : DAY_FMT) : DAY_YEAR_FMT;
    return unit === 'week' && long ? `Week of ${day.format(d)}` : day.format(d);
}

export const shortDate = (iso: string) => (date(iso).getUTCFullYear() === thisYear ? DAY_FMT : DAY_YEAR_FMT).format(date(iso));

/** Round ticks from min (zero, unless a line fits its data) to a round maximum, in about four steps; whole steps for counts. */
function niceTicks(max: number, whole: boolean, min = 0): number[] {
    if (!(max > min)) return min > 0 ? niceTicks(max * 1.05 + (whole ? 1 : 0), whole, max * 0.95) : whole ? [0, 1, 2, 3, 4] : [0, 0.25, 0.5, 0.75, 1];
    const raw = (max - min) / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    let step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
    if (whole) step = Math.max(1, Math.ceil(step));
    const ticks = [Math.floor(min / step + 1e-9) * step];
    while (ticks[ticks.length - 1] < max - 1e-9) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
    return ticks;
}

interface AxisLabel {
    x: number;
    text: string;
    anchor: 'start' | 'middle' | 'end';
}

/** Date labels along the bottom, dropping any that would touch the one before. */
function fitLabels(all: AxisLabel[]): AxisLabel[] {
    const kept: AxisLabel[] = [];
    let right = -Infinity;
    for (const l of all) {
        const w = l.text.length * 6.4;
        const left = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2;
        if (left < right + 10) continue;
        kept.push(l);
        right = left + w;
    }
    return kept;
}

function useWidth<T extends Element>(): [RefObject<T>, number] {
    const ref = useRef<T>(null);
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        setWidth(Math.round(el.getBoundingClientRect().width));
        const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return [ref, width];
}

// ------------------------------------------------------------------ chart frame

export interface Series {
    name: string;
    values: (number | null)[];
    /** main: the data; compare: the previous period, in gray; down: drawn below zero (e.g. unsubscribes). */
    tone?: 'main' | 'compare' | 'down';
    /** Bucket dates when they differ from the chart's, e.g. the previous period's. */
    labels?: string[];
}

interface Tip {
    title: string;
    mark?: 'line' | 'bar';
    rows: { tone: Series['tone']; value: string; name: string }[];
}

/** Legend for two or more series, then the plot or its table. */
function Frame(props: {
    label: string;
    series: { name: string; tone?: Series['tone'] }[];
    mark?: 'line' | 'bar';
    table: () => ComponentChildren;
    children: (width: number) => ComponentChildren;
    height: number;
}) {
    const [ref, width] = useWidth<HTMLElement>();
    const [asTable, setAsTable] = useState(false);
    return (
        <figure ref={ref} class="an-chart">
            <div class="an-chart-head">
                {props.series.length > 1 ? (
                    <ul class="an-legend">
                        {props.series.map(s => (
                            <li key={s.name}>
                                <span class={`an-key tone-${s.tone ?? 'main'} mark-${props.mark ?? 'line'}`} aria-hidden="true" />
                                {s.name}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <span />
                )}
                <button type="button" class="an-toggle" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>
                    {asTable ? 'Chart' : 'Table'}
                </button>
            </div>
            {asTable ? (
                <div class="an-table-wrap">{props.table()}</div>
            ) : (
                <div class="an-plot" style={{ height: `${props.height}px` }}>
                    {width ? props.children(width) : null}
                </div>
            )}
        </figure>
    );
}

function Tooltip({ tip, x, width }: { tip: Tip | null; x: number; width: number }) {
    if (!tip) return null;
    const flip = x > width * 0.6;
    return (
        <div class="an-tip" style={{ left: `${flip ? x - 12 : x + 12}px`, transform: flip ? 'translateX(-100%)' : undefined }} aria-hidden="true">
            <div class="an-tip-title">{tip.title}</div>
            {tip.rows.map(r => (
                <div class="an-tip-row" key={r.name}>
                    <span class={`an-key tone-${r.tone ?? 'main'} mark-${tip.mark ?? 'line'}`} />
                    <b>{r.value}</b>
                    <span>{r.name}</span>
                </div>
            ))}
        </div>
    );
}

/** Arrow keys walk the points; the same readout as hover, announced for screen readers. */
function keyHandlers(n: number, active: number | null, setActive: (i: number | null) => void) {
    return {
        tabIndex: 0,
        onKeyDown: (e: KeyboardEvent) => {
            if (!n) return;
            const i = active ?? n - 1;
            const next = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
            if (next === null) return;
            e.preventDefault();
            setActive(Math.max(0, Math.min(n - 1, next)));
        },
        onFocus: () => setActive(n ? n - 1 : null),
        onBlur: () => setActive(null)
    };
}

// ------------------------------------------------------------------ over time, in buckets

export function TrendChart({
    label,
    labels,
    unit,
    series,
    kind = 'area',
    fit = false,
    invert = false,
    format = fmtInt,
    percent = false,
    height = 240,
    empty = 'Nothing recorded in this period.'
}: {
    /** What the chart shows, for its accessible name and table caption. */
    label: string;
    labels: string[];
    unit: Unit;
    series: Series[];
    /** area: a line over a soft fill; bars: one column per bucket (with a "down" series, below zero). */
    kind?: 'area' | 'bars';
    /** A line whose axis starts near its lowest value, for totals such as subscribers; drawn without a fill. */
    fit?: boolean;
    /** Smaller is better and drawn higher, e.g. a search position (1 is the top); implies fit. */
    invert?: boolean;
    format?: (n: number) => string;
    percent?: boolean;
    height?: number;
    empty?: string;
}) {
    const [active, setActive] = useState<number | null>(null);
    const n = labels.length;
    const up = series.filter(s => s.tone !== 'down');
    const down = series.find(s => s.tone === 'down');
    const main = series.find(s => (s.tone ?? 'main') === 'main') ?? series[0];
    const all = series.flatMap(s => s.values).filter((v): v is number => v !== null);
    const nothing = !all.some(v => v > 0);
    const bars = kind === 'bars' || Boolean(down);
    const upValues = up.flatMap(s => s.values.filter((v): v is number => v !== null && v !== undefined));
    const dataMax = Math.max(0, ...upValues);
    const dataMin = upValues.length ? Math.min(...upValues) : 0;
    const fitted = (fit || invert) && !bars && dataMax > 0;
    const ticks = fitted ? niceTicks(dataMax, !percent, Math.max(0, dataMin - (dataMax - dataMin) * 0.15)) : niceTicks(dataMax, !percent);
    const step = ticks[1] - ticks[0];
    const downMax = down ? Math.max(0, ...down.values.map(v => v ?? 0)) : 0;
    const below = down ? Array.from({ length: Math.max(1, Math.ceil(downMax / step - 1e-9)) }, (_, i) => -(i + 1) * step) : [];
    const top = ticks[ticks.length - 1];
    const bottom = below.length ? below[below.length - 1] : ticks[0];
    // Whole percents unless the ticks fall between them (2.5%, 7.5%).
    const axisLabel = (v: number) => (percent ? pct(Math.abs(v), Math.abs(step * 100 - Math.round(step * 100)) > 1e-9 ? 1 : 0) : compact(Math.abs(v)));
    const summary = `${label}. ${main ? `${main.name}: highest ${format(Math.max(0, ...main.values.map(v => v ?? 0)))}` : ''}`;

    const tipFor = (i: number): Tip => ({
        title: bucketLabel(labels[i], unit, true),
        mark: bars ? 'bar' : 'line',
        rows: series.map(s => ({
            tone: s.tone,
            name: s.labels ? `${s.name} (${bucketLabel(s.labels[i] ?? '', unit)})` : s.name,
            value: s.values[i] === null || s.values[i] === undefined ? '–' : format(s.values[i]!)
        }))
    });

    return (
        <Frame
            label={label}
            series={series}
            mark={bars ? 'bar' : 'line'}
            height={height}
            table={() => (
                <table class="table an-table">
                    <caption class="an-sr">{label}</caption>
                    <thead>
                        <tr>
                            <th>{unit === 'month' ? 'Month' : unit === 'week' ? 'Week of' : 'Day'}</th>
                            {series.map(s => (
                                <th key={s.name} class="num">
                                    {s.labels?.[0] ? `${s.name}, from ${bucketLabel(s.labels[0], unit)}` : s.name}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {labels.map((b, i) => (
                            <tr key={b}>
                                <td class="nowrap">{bucketLabel(b, unit, true)}</td>
                                {series.map(s => (
                                    <td key={s.name} class="num">
                                        {s.values[i] === null || s.values[i] === undefined ? '–' : format(s.values[i]!)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        >
            {width => {
                const padL = Math.max(...[...ticks, ...below].map(t => axisLabel(t).length)) * 7 + 12;
                const pad = { l: padL, r: 8, t: 12, b: 28 };
                const pw = Math.max(1, width - pad.l - pad.r);
                const ph = height - pad.t - pad.b;
                const y = (v: number) => pad.t + ((invert ? v - bottom : top - v) / (top - bottom || 1)) * ph;
                const band = pw / Math.max(1, n);
                const x = (i: number) => (bars ? pad.l + band * (i + 0.5) : pad.l + (n > 1 ? (pw * i) / (n - 1) : pw / 2));
                const barW = Math.max(1, Math.min(24, band - 2));
                const longest = Math.max(...labels.map(b => bucketLabel(b, unit).length)) * 6.4;
                const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / (longest + 18)))));
                const xTicks = fitLabels(
                    labels
                        .map((b, i) => ({ i, b }))
                        .filter(({ i }) => i % every === 0)
                        .map(({ i, b }) => ({ x: x(i), text: bucketLabel(b, unit), anchor: !bars && i === 0 ? 'start' : !bars && i === n - 1 ? 'end' : 'middle' }))
                );
                const pick = (clientX: number, rect: DOMRect) => {
                    const px = clientX - rect.left;
                    const i = bars ? Math.floor((px - pad.l) / band) : Math.round(((px - pad.l) / pw) * (n - 1));
                    setActive(Math.max(0, Math.min(n - 1, i)));
                };
                const line = (s: Series) => {
                    let d = '';
                    s.values.forEach((v, i) => {
                        if (v === null || v === undefined) return;
                        d += `${d && s.values[i - 1] !== null && s.values[i - 1] !== undefined ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
                    });
                    return d;
                };
                const column = (i: number, v: number, sign: 1 | -1) => {
                    const h = Math.abs(y(v * sign) - y(0));
                    if (h < 0.5) return '';
                    const r = Math.min(4, barW / 2, h);
                    const x0 = x(i) - barW / 2;
                    const x1 = x0 + barW;
                    const base = y(0);
                    // Rounded at the data end, square at the baseline.
                    return sign > 0
                        ? `M${x0},${base}V${base - h + r}Q${x0},${base - h} ${x0 + r},${base - h}H${x1 - r}Q${x1},${base - h} ${x1},${base - h + r}V${base}Z`
                        : `M${x0},${base}V${base + h - r}Q${x0},${base + h} ${x0 + r},${base + h}H${x1 - r}Q${x1},${base + h} ${x1},${base + h - r}V${base}Z`;
                };
                const keys = keyHandlers(n, active, setActive);
                return (
                    <div class="an-plot-in" onPointerLeave={() => setActive(null)} {...keys} role="group" aria-label={`${summary}. Arrow keys read each point.`}>
                        <svg width={width} height={height} aria-hidden="true" onPointerMove={(e: PointerEvent) => pick(e.clientX, (e.currentTarget as SVGSVGElement).getBoundingClientRect())}>
                            {[...ticks, ...below].map(t => (
                                <g key={t}>
                                    <line class={t === (below.length ? 0 : invert ? top : ticks[0]) ? 'an-base' : 'an-gridline'} x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
                                    <text class="an-axis" x={pad.l - 8} y={y(t)} text-anchor="end" dominant-baseline="middle">
                                        {axisLabel(t)}
                                    </text>
                                </g>
                            ))}
                            {xTicks.map(l => (
                                <text key={l.x} class="an-axis" x={l.x} y={height - 8} text-anchor={l.anchor}>
                                    {l.text}
                                </text>
                            ))}
                            {bars ? (
                                <>
                                    {up.map(s =>
                                        s.values.map((v, i) =>
                                            v ? <path key={`${s.name}${i}`} class={`an-bar tone-${s.tone ?? 'main'} ${active !== null && active !== i ? 'dim' : ''}`} d={column(i, v, 1)} /> : null
                                        )
                                    )}
                                    {down
                                        ? down.values.map((v, i) => (v ? <path key={`d${i}`} class={`an-bar tone-down ${active !== null && active !== i ? 'dim' : ''}`} d={column(i, v, -1)} /> : null))
                                        : null}
                                </>
                            ) : (
                                <>
                                    {series
                                        .filter(s => s.tone === 'compare')
                                        .map(s => (
                                            <path key={s.name} class="an-line tone-compare" d={line(s)} />
                                        ))}
                                    {main && main.tone !== 'compare' ? (
                                        <>
                                            {fitted ? null : <path class="an-area" d={`${line(main)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`} />}
                                            <path class="an-line tone-main" d={line(main)} />
                                        </>
                                    ) : null}
                                </>
                            )}
                            {active !== null && !bars ? (
                                <>
                                    <line class="an-cross" x1={x(active)} x2={x(active)} y1={pad.t} y2={pad.t + ph} />
                                    {series.map(s =>
                                        s.values[active] === null || s.values[active] === undefined ? null : (
                                            <circle key={s.name} class={`an-dot tone-${s.tone ?? 'main'}`} cx={x(active)} cy={y(s.values[active]!)} r={4} />
                                        )
                                    )}
                                </>
                            ) : null}
                        </svg>
                        {nothing ? <p class="an-empty-note">{empty}</p> : null}
                        <Tooltip tip={active === null ? null : tipFor(active)} x={active === null ? 0 : x(active)} width={width} />
                        <span class="an-sr" aria-live="polite">
                            {active === null
                                ? ''
                                : `${tipFor(active).title}: ${tipFor(active)
                                      .rows.map(r => `${r.value} ${r.name}`)
                                      .join(', ')}`}
                        </span>
                    </div>
                );
            }}
        </Frame>
    );
}

// ------------------------------------------------------------------ events at their own times

export interface Point {
    at: string;
    value: number | null;
    /** What happened, e.g. the newsletter's subject. */
    label: string;
}

/** One dot per event (a newsletter) at its date, joined by a line: for rates per send. */
export function PointsChart({
    label,
    name,
    points,
    format = v => pct(v),
    percent = true,
    height = 240,
    empty = 'Nothing sent in this period.'
}: {
    label: string;
    name: string;
    points: Point[];
    format?: (n: number) => string;
    percent?: boolean;
    height?: number;
    empty?: string;
}) {
    const [active, setActive] = useState<number | null>(null);
    const list = points.filter(p => p.value !== null).sort((a, b) => a.at.localeCompare(b.at));
    const n = list.length;
    const ticks = niceTicks(Math.max(0, ...list.map(p => p.value ?? 0)), !percent);
    const top = ticks[ticks.length - 1];
    const times = list.map(p => date(p.at).getTime());
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);
    const axisLabel = (v: number) => (percent ? pct(v, 0) : compact(v));

    return (
        <Frame
            label={label}
            series={[{ name }]}
            height={height}
            table={() => (
                <table class="table an-table">
                    <caption class="an-sr">{label}</caption>
                    <thead>
                        <tr>
                            <th>Sent</th>
                            <th>Newsletter</th>
                            <th class="num">{name}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[...list].reverse().map((p, i) => (
                            <tr key={i}>
                                <td class="nowrap">{shortDate(p.at)}</td>
                                <td>{p.label}</td>
                                <td class="num">{format(p.value!)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        >
            {width => {
                if (!n) return <p class="an-empty-note static">{empty}</p>;
                const padL = Math.max(...ticks.map(t => axisLabel(t).length)) * 7 + 12;
                const pad = { l: padL, r: 16, t: 12, b: 28 };
                const pw = Math.max(1, width - pad.l - pad.r);
                const ph = height - pad.t - pad.b;
                const x = (t: number) => (t1 > t0 ? pad.l + ((t - t0) / (t1 - t0)) * pw : pad.l + pw / 2);
                const y = (v: number) => pad.t + ((top - v) / (top || 1)) * ph;
                const dateText = (t: number) => (t1 - t0 > 300 * 86_400_000 ? MONTH_FMT.format(new Date(t)) : shortDate(new Date(t).toISOString()));
                const longest = Math.max(dateText(t0).length, dateText(t1).length) * 6.4;
                const labelCount = Math.max(2, Math.min(6, Math.floor(pw / (longest + 24))));
                const at = t1 > t0 ? Array.from({ length: labelCount }, (_, i) => t0 + ((t1 - t0) * i) / (labelCount - 1)) : [t0];
                const xTicks = fitLabels(at.map((t, i) => ({ x: x(t), text: dateText(t), anchor: at.length === 1 ? 'middle' : i === 0 ? 'start' : i === at.length - 1 ? 'end' : 'middle' })));
                const d = list.map((p, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(p.value!).toFixed(1)}`).join('');
                const keys = keyHandlers(n, active, setActive);
                const nearest = (clientX: number, rect: DOMRect) => {
                    const px = clientX - rect.left;
                    let best = 0;
                    times.forEach((t, i) => (Math.abs(x(t) - px) < Math.abs(x(times[best]) - px) ? (best = i) : null));
                    setActive(best);
                };
                const tip: Tip | null = active === null ? null : { title: shortDate(list[active].at), rows: [{ tone: 'main', value: format(list[active].value!), name: list[active].label }] };
                return (
                    <div
                        class="an-plot-in"
                        onPointerLeave={() => setActive(null)}
                        {...keys}
                        role="group"
                        aria-label={`${label}. ${n} newsletters, from ${format(Math.min(...list.map(p => p.value!)))} to ${format(Math.max(...list.map(p => p.value!)))}. Arrow keys read each one.`}
                    >
                        <svg width={width} height={height} aria-hidden="true" onPointerMove={(e: PointerEvent) => nearest(e.clientX, (e.currentTarget as SVGSVGElement).getBoundingClientRect())}>
                            {ticks.map(t => (
                                <g key={t}>
                                    <line class={t === 0 ? 'an-base' : 'an-gridline'} x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
                                    <text class="an-axis" x={pad.l - 8} y={y(t)} text-anchor="end" dominant-baseline="middle">
                                        {axisLabel(t)}
                                    </text>
                                </g>
                            ))}
                            {xTicks.map(l => (
                                <text key={l.x} class="an-axis" x={l.x} y={height - 8} text-anchor={l.anchor}>
                                    {l.text}
                                </text>
                            ))}
                            {n > 1 ? <path class="an-line tone-main" d={d} /> : null}
                            {list.map((p, i) => (
                                <circle key={i} class={`an-dot tone-main ${active === i ? 'on' : ''}`} cx={x(times[i])} cy={y(p.value!)} r={active === i ? 5 : 4} />
                            ))}
                            {active !== null ? <line class="an-cross" x1={x(times[active])} x2={x(times[active])} y1={pad.t} y2={y(0)} /> : null}
                        </svg>
                        <Tooltip tip={tip} x={active === null ? 0 : x(times[active])} width={width} />
                        <span class="an-sr" aria-live="polite">
                            {tip ? `${tip.title}: ${tip.rows[0].value}, ${tip.rows[0].name}` : ''}
                        </span>
                    </div>
                );
            }}
        </Frame>
    );
}

// ------------------------------------------------------------------ breakdowns

export interface BarItem {
    key: string;
    label: ComponentChildren;
    value: number;
    /** A second number after the value, e.g. a rate. */
    note?: string;
    href?: string;
    title?: string;
}

/** A ranked list with a bar behind each label, sized against the largest. */
export function BarList({ items, format = fmtInt, total, limit = 8, empty = 'Nothing yet.' }: { items: BarItem[]; format?: (n: number) => string; total?: number; limit?: number; empty?: string }) {
    const [all, setAll] = useState(false);
    useEffect(() => setAll(false), [items.length]);
    if (!items.length) return <p class="muted small an-none">{empty}</p>;
    const max = Math.max(1, ...items.map(i => i.value));
    const shown = all ? items : items.slice(0, limit);
    return (
        <div>
            <ul class="an-list">
                {shown.map(it => (
                    <li key={it.key} class="an-list-row" title={it.title}>
                        <span class="an-list-track">
                            <span class="an-list-bar" style={{ width: `${Math.max(0.5, (it.value / max) * 100)}%` }} aria-hidden="true" />
                            <span class="an-list-label">{it.href ? <a href={it.href}>{it.label}</a> : it.label}</span>
                        </span>
                        <span class="an-list-value">
                            {format(it.value)}
                            {it.note ? <span class="an-list-note">{it.note}</span> : total ? <span class="an-list-note">{pct(it.value / total, 0)}</span> : null}
                        </span>
                    </li>
                ))}
            </ul>
            {items.length > limit ? (
                <button type="button" class="link-btn an-more" onClick={() => setAll(!all)}>
                    {all ? 'Show fewer' : `Show all ${items.length}`}
                </button>
            ) : null}
        </div>
    );
}

/** Parts of a whole in one bar, with a labeled legend: the first three get colors, the rest fold into Other. */
export function Segments({ items, label }: { items: { key: string; label: string; value: number }[]; label: string }) {
    const total = items.reduce((a, b) => a + b.value, 0);
    if (!total) return <p class="muted small an-none">Nothing yet.</p>;
    const top = items.slice(0, 3);
    const rest = items.slice(3).reduce((a, b) => a + b.value, 0);
    const parts = rest ? [...top, { key: 'other', label: 'Other', value: rest }] : top;
    return (
        <div class="an-seg">
            <div class="an-seg-bar" role="img" aria-label={`${label}: ${parts.map(p => `${p.label} ${pct(p.value / total, 0)}`).join(', ')}`}>
                {parts.map((p, i) => (
                    <span key={p.key} class={`an-seg-part an-c${p.key === 'other' ? 'x' : i + 1}`} style={{ flexGrow: p.value }} title={`${p.label}: ${pct(p.value / total)}`} />
                ))}
            </div>
            <ul class="an-seg-legend">
                {parts.map((p, i) => (
                    <li key={p.key}>
                        <span class={`an-swatch an-c${p.key === 'other' ? 'x' : i + 1}`} aria-hidden="true" />
                        <span>{p.label}</span>
                        <b>{pct(p.value / total, 0)}</b>
                        <span class="muted">{compact(p.value)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

// ------------------------------------------------------------------ figures

/**
 * The change against the period before: a percentage for counts, points for rates.
 * Direction is shown by an arrow and words, and colored by whether up is good.
 */
export function Delta({ now, before, rate = false, upIsGood = true, vs }: { now: number | null | undefined; before: number | null | undefined; rate?: boolean; upIsGood?: boolean; vs: string }) {
    if (now === null || now === undefined || before === null || before === undefined) return null;
    let text: string;
    let dir: 'up' | 'down' | 'flat';
    if (rate) {
        const pts = (now - before) * 100;
        dir = Math.abs(pts) < 0.05 ? 'flat' : pts > 0 ? 'up' : 'down';
        text = `${Math.abs(pts).toFixed(1)} pts`;
    } else if (before === 0) {
        // Nothing before: no percentage to give.
        dir = now > 0 ? 'up' : 'flat';
        text = now > 0 ? 'new' : '';
    } else {
        const change = ((now - before) / before) * 100;
        dir = Math.abs(change) < 0.5 ? 'flat' : change > 0 ? 'up' : 'down';
        text = `${Math.abs(change) < 10 ? Math.abs(change).toFixed(1).replace(/\.0$/, '') : Math.round(Math.abs(change)).toLocaleString()}%`;
    }
    const tone = dir === 'flat' ? 'flat' : (dir === 'up') === upIsGood ? 'good' : 'bad';
    return (
        <span class={`an-delta ${tone}`} title={`${dir === 'flat' ? 'No change' : dir === 'up' ? 'Up' : 'Down'} ${text} ${vs}`.trim()}>
            {dir === 'flat' ? (
                'No change'
            ) : (
                <>
                    <span aria-hidden="true">{dir === 'up' ? '▲' : '▼'}</span>
                    <span class="an-sr">{dir === 'up' ? 'Up' : 'Down'}</span> {text}
                </>
            )}
        </span>
    );
}

/** A headline number. Tiles with onSelect pick what the chart below shows. */
export function Kpi({
    label,
    value,
    exact,
    delta,
    note,
    selected,
    onSelect,
    dim
}: {
    label: string;
    value: ComponentChildren;
    /** The full number, when the tile shows a short one. */
    exact?: string;
    delta?: ComponentChildren;
    note?: ComponentChildren;
    selected?: boolean;
    onSelect?: () => void;
    /** Waiting on a source that is not connected or has no data yet. */
    dim?: boolean;
}) {
    const body = (
        <>
            <span class="an-kpi-label">{label}</span>
            <span class="an-kpi-value" title={exact}>
                {value}
            </span>
            <span class="an-kpi-foot">
                {delta}
                {note ? <span class="an-kpi-note">{note}</span> : null}
            </span>
        </>
    );
    return onSelect ? (
        <button type="button" role="tab" aria-selected={Boolean(selected)} class={`an-kpi pick ${selected ? 'on' : ''} ${dim ? 'dim' : ''}`} onClick={onSelect}>
            {body}
        </button>
    ) : (
        <div class={`an-kpi ${dim ? 'dim' : ''}`}>{body}</div>
    );
}
