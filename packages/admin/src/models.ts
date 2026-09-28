/**
 * The model catalog as the admin uses it: each kind's list (loaded once per
 * visit and shared by every picker), the models this browser writes with, and
 * how a model reads on screen: its provider, context, price and hints.
 */
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { api, base } from './api';

export type ModelKind = 'text' | 'image' | 'video' | 'embedding';
/** The kinds a writer can pick for themselves; the knowledge model is the site's alone. */
export type ChoiceKind = 'text' | 'image' | 'video';

/** One row of GET /ai/models (ModelInfo in @masthead/core). */
export interface Model {
    id: string;
    name: string;
    kind: ModelKind;
    contextLength?: number;
    price?: Record<string, number>;
    supports?: { durations?: number[]; aspectRatios?: string[]; resolutions?: string[]; frameImages?: string[]; streaming?: boolean; references?: boolean; audio?: boolean };
    released?: string;
    score?: number;
    aliasOf?: { id: string; name: string };
    retires?: string;
    isDefault?: boolean;
}

// ------------------------------------------------------------------ the catalog

const catalogs = signal<Partial<Record<ModelKind, Model[]>>>({});
const loading = new Map<ModelKind, Promise<Model[]>>();

function loadModels(kind: ModelKind): Promise<Model[]> {
    let p = loading.get(kind);
    if (!p) {
        p = api<Model[]>(`/ai/models?kind=${kind}`).then(list => {
            catalogs.value = { ...catalogs.value, [kind]: list };
            return list;
        });
        loading.set(kind, p);
        // A failed load is tried again the next time it is asked for.
        p.catch(() => loading.delete(kind));
    }
    return p;
}

/** Loads the lists again, e.g. after the site's defaults changed, so "Default" moves with them. */
export function reloadModels() {
    loading.clear();
    for (const kind of Object.keys(catalogs.value) as ModelKind[]) loadModels(kind).catch(() => {});
}

/** A kind's list (null until it arrives), why it failed, and a way to try again. */
export function useModels(kind: ModelKind): { models: Model[] | null; error: string | null; retry: () => void } {
    const models = catalogs.value[kind] ?? null;
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (models) return;
        let live = true;
        setError(null);
        loadModels(kind).catch(err => live && setError(err instanceof Error ? err.message : 'The model list did not load.'));
        return () => {
            live = false;
        };
    }, [kind, attempt]);
    return { models, error: models ? null : error, retry: () => setAttempt(n => n + 1) };
}

/** A model's short name from any list loaded so far; its id's last part otherwise. */
export function modelLabel(id: string): string {
    for (const list of Object.values(catalogs.value)) {
        const m = list?.find(x => x.id === id);
        if (m) return shortName(m.name);
    }
    return id.slice(id.lastIndexOf('/') + 1);
}

// ------------------------------------------------------------------ this browser's models

const CHOICE_KEY = `masthead-ai-models:${base}`;

function readChoice(): Partial<Record<ChoiceKind, string>> {
    try {
        const v = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}');
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}

/** The models this browser writes with, by kind. Absent: the site default. */
export const myModels = signal(readChoice());

// Another tab changed them.
window.addEventListener('storage', e => e.key === CHOICE_KEY && (myModels.value = readChoice()));

export function setMyModel(kind: ChoiceKind, id: string | null) {
    const next = { ...myModels.value };
    if (id) next[kind] = id;
    else delete next[kind];
    myModels.value = next;
    try {
        localStorage.setItem(CHOICE_KEY, JSON.stringify(next));
    } catch {
        // Private windows can refuse storage; the choice holds until the page reloads.
    }
}

/** The `model` to send with an AI request: this browser's choice, or none for the site default. */
export const modelFor = (kind: ChoiceKind): string | undefined => myModels.value[kind] || undefined;

// ------------------------------------------------------------------ how a model reads

/** "Anthropic: Claude Sonnet 5" reads as "Claude Sonnet 5" next to its provider. */
function shortName(name: string): string {
    const i = name.indexOf(': ');
    return i > 0 && i < 40 ? name.slice(i + 2) : name;
}

export const modelName = (m: Pick<Model, 'name'>) => shortName(m.name);

/** The provider, from the id's prefix: "anthropic/claude-…" and its "~anthropic/…-latest" alias alike. */
export function providerKey(id: string): string {
    const slash = id.indexOf('/');
    return slash > 0 ? id.slice(0, slash).replace(/^~/, '') : 'other';
}

const labelCache = new WeakMap<Model[], Map<string, string>>();

/** Each provider's display name: the one most of its models' names start with ("Anthropic: …"). */
export function providerLabels(list: Model[]): Map<string, string> {
    let labels = labelCache.get(list);
    if (labels) return labels;
    const votes = new Map<string, Map<string, number>>();
    for (const m of list) {
        const i = m.name.indexOf(': ');
        if (i <= 0 || i >= 40) continue;
        const key = providerKey(m.id);
        const names = votes.get(key) ?? new Map<string, number>();
        names.set(m.name.slice(0, i), (names.get(m.name.slice(0, i)) ?? 0) + 1);
        votes.set(key, names);
    }
    labels = new Map();
    for (const m of list) {
        const key = providerKey(m.id);
        if (labels.has(key)) continue;
        const best = [...(votes.get(key) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
        labels.set(key, best ?? (key === 'other' ? 'Other' : key.replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase())));
    }
    labelCache.set(list, labels);
    return labels;
}

/** 1000000 reads 1M, 131072 reads 128K, 1050000 reads 1.05M. */
function fmtTokens(n: number): string {
    const [M, K] = n % 1000 === 0 ? [1e6, 1e3] : n % 1024 === 0 ? [1048576, 1024] : [1e6, 1e3];
    if (n >= M) return `${+(n / M).toFixed(2)}M`;
    if (n >= K) return `${Math.round(n / K)}K`;
    return String(n);
}

function fmtCredits(n: number): string {
    if (n === 0) return '0';
    if (n >= 100) return Math.round(n).toLocaleString();
    if (n >= 10) return String(+n.toFixed(1));
    if (n >= 0.01) return String(+n.toFixed(2));
    return '<0.01';
}

export interface PriceTag {
    value: string;
    unit: string;
    /** The whole price in words, for a tooltip. */
    title: string;
}

/** The price that matters for choosing, in credits and a unit people read at a glance. */
export function priceOf(m: Model): PriceTag | null {
    const p = m.price ?? {};
    const n = (k: string) => (typeof p[k] === 'number' ? p[k] : undefined);
    const tag = (value: number, unit: string, title: string): PriceTag => (value === 0 ? { value: 'Free', unit: '', title: 'No charge' } : { value: fmtCredits(value), unit, title: `${fmtCredits(value)} credits ${title}` });
    if (m.kind === 'text') {
        const input = n('credits_per_m_input');
        const output = n('credits_per_m_output');
        if (input == null && output == null) return null;
        if (!input && !output) return { value: 'Free', unit: '', title: 'No charge' };
        return { value: `${fmtCredits(input ?? 0)} / ${fmtCredits(output ?? 0)}`, unit: 'per 1M in / out', title: `${fmtCredits(input ?? 0)} credits per million tokens in, ${fmtCredits(output ?? 0)} per million out` };
    }
    if (m.kind === 'image') {
        const each = n('credits_per_image');
        if (each != null) return tag(each, 'per image', 'per image');
        const tokens = n('credits_per_m_output_image_tokens');
        return tokens == null ? null : tag(tokens, 'per 1M tokens', 'per million image tokens');
    }
    if (m.kind === 'video') {
        const second = n('credits_per_second_output');
        if (second != null) return tag(second, 'per second', 'per second of video');
        const tokens = n('credits_per_m_video_tokens');
        return tokens == null ? null : tag(tokens, 'per 1M tokens', 'per million video tokens');
    }
    const input = n('credits_per_m_input');
    return input == null ? null : tag(input, 'per 1M tokens', 'per million tokens');
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** What sets a model apart, in a few words each, as the catalog tells it. */
export function hintsOf(m: Model): string[] {
    const s = m.supports ?? {};
    const out: string[] = [];
    if (m.aliasOf) out.push(`Now ${shortName(m.aliasOf.name)}`);
    if ((m.kind === 'text' || m.kind === 'embedding') && m.contextLength) out.push(`${fmtTokens(m.contextLength)} context`);
    if (m.kind === 'image') {
        if (s.streaming) out.push('Previews');
        if (s.references) out.push('Edits images');
    }
    if (m.kind === 'video') {
        const d = s.durations;
        if (d?.length) out.push(d.length > 1 ? `${d[0]} to ${d[d.length - 1]} s` : `${d[0]} s`);
        const best = [...(s.resolutions ?? [])].sort((a, b) => parseInt(b) - parseInt(a))[0];
        if (best && parseInt(best)) out.push(best);
        if (s.frameImages?.includes('first_frame')) out.push('Animates images');
        if (s.audio) out.push('Sound');
    }
    if (m.retires) out.push(`Retires ${day(m.retires)}`);
    return out;
}

/** Released in the last three weeks. */
export const isNew = (m: Model) => !!m.released && Date.now() - Date.parse(m.released) < 21 * 86400_000;

const released = (m: Model) => (m.released ? Date.parse(m.released) : 0);

export interface ModelGroup {
    key: string;
    label: string;
    models: Model[];
}

const groupCache = new WeakMap<Model[], ModelGroup[]>();

/**
 * The list by provider. Providers with the strongest benchmark scores come first, then the
 * ones with the newest models. Inside a provider: its "latest" aliases, then newest first,
 * each :batch or :free variant right after its model.
 */
export function groupModels(list: Model[]): ModelGroup[] {
    let groups = groupCache.get(list);
    if (groups) return groups;
    const labels = providerLabels(list);
    const by = new Map<string, Model[]>();
    for (const m of list) {
        const key = providerKey(m.id);
        const models = by.get(key);
        if (models) models.push(m);
        else by.set(key, [m]);
    }
    const alias = (m: Model) => Number(m.id.startsWith('~'));
    const variant = (m: Model) => Number(m.id.includes(':'));
    groups = [...by]
        .map(([key, models]) => ({
            key,
            label: labels.get(key) ?? key,
            models: models.sort((a, b) => alias(b) - alias(a) || released(b) - released(a) || variant(a) - variant(b) || a.id.localeCompare(b.id)),
            best: Math.max(-1, ...models.map(m => m.score ?? -1)),
            newest: Math.max(0, ...models.map(released))
        }))
        .sort((a, b) => b.best - a.best || b.newest - a.newest || a.label.localeCompare(b.label))
        .map(({ key, label, models }) => ({ key, label, models }));
    groupCache.set(list, groups);
    return groups;
}

/** The models with the highest benchmark scores; aliases and :batch or :free copies left out. */
export function strongest(list: Model[], n = 5): Model[] {
    return list
        .filter(m => m.score != null && !m.id.startsWith('~') && !m.id.includes(':'))
        .sort((a, b) => b.score! - a.score! || released(b) - released(a))
        .slice(0, n);
}

const hayCache = new WeakMap<Model, string>();

/** Everything a search matches against: names, the id, the provider and the hints. */
export function haystack(m: Model, labels: Map<string, string>): string {
    let text = hayCache.get(m);
    if (text === undefined) {
        text = `${m.name} ${m.id} ${labels.get(providerKey(m.id)) ?? ''} ${hintsOf(m).join(' ')}${m.isDefault ? ' default' : ''}${isNew(m) ? ' new' : ''}`.toLowerCase();
        hayCache.set(m, text);
    }
    return text;
}
