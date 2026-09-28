/**
 * Post ideas: the rules every idea follows and the prompt that asks a model
 * for them. The CLI studio and the server's daily refresh both build their
 * request here, so an idea reads the same wherever it was made.
 */
import type { Policy, Signal } from './types';

/** What every idea respects: grounding, privacy, and progress over problems. */
export const IDEA_RULES: string[] = [
    'Every idea must be grounded only in the signals and background given. Never invent numbers, customers, quotes or outcomes; the angle can say what a writer would need to find out.',
    'Never name customers, partners, vendors, individual people, or the projects, apps and companies of users that appear in the signals. Describe them generically ("a restaurant app", "an agency").',
    'Never build an idea on internal pricing, revenue, deal terms, traffic or analytics numbers, sales process, or security details. Skip signals that are only about those.',
    'Pitch progress: new features and launches and what they make possible, how something works, build walkthroughs, measured results, and what tasks or benchmarks teach models (the skills they train or measure, and why that matters). Specific, useful stories a developer or founder would click, in a positive, forward-looking frame.',
    'Never pitch a story about bugs, fixes, incidents, outages, regressions, failed deploys or postmortems. Skip signals that are only about those.',
    'Headlines and angles lead with what is new and what it lets people do. Never lead with a failure, an error or failure rate, or what used to break; when a signal is about a fix, pitch the capability it created, or skip it.',
    'Do not repeat or lightly reword an existing post or idea.'
];

export interface Background {
    title: string;
    text: string;
    url?: string;
}

export interface IdeaPromptInput {
    /** The blog's name, e.g. "Acme". */
    site: string;
    /** The site's house style (Settings, AI). */
    voice?: string | null;
    /** Standing notes the team keeps for the AI. */
    memory?: string[];
    /** The editor's own direction for ideas, e.g. "more on what our benchmarks teach". */
    guidance?: string | null;
    /** New material, newest first. Ideas cite it by number. */
    signals: Signal[];
    /** Standing material ideas may draw on for depth: a product page, say. Not news. */
    background?: Background[];
    /** Existing posts and ideas, one line each, so nothing is pitched twice. */
    existing?: string[];
    /** At most this many ideas. */
    count: number;
}

export function ideaPrompt(input: IdeaPromptInput): { system: string; user: string } {
    const system = [
        `You are the editor of the ${input.site} blog. You suggest posts that come straight out of real work: things that shipped, projects that were built, results that were measured.`,
        ...IDEA_RULES,
        input.voice ? `House style:\n${input.voice}` : '',
        input.memory?.length ? `Things the team wants you to remember:\n${input.memory.map(m => `- ${m}`).join('\n')}` : '',
        input.guidance ? `Direction from the editor:\n${input.guidance}` : ''
    ]
        .filter(Boolean)
        .join('\n\n');
    const user = [
        'Signals, newest first:',
        input.signals.map((s, i) => `[${i + 1}] ${s.at.slice(0, 10)} ${s.source}/${s.kind}: ${s.title}${s.summary ? `\n${s.summary.slice(0, 400)}` : ''}`).join('\n\n'),
        input.background?.length ? `Background (not new; use it for depth):\n\n${input.background.map((b, i) => `[B${i + 1}] ${b.title}\n${b.text}`).join('\n\n')}` : '',
        input.existing?.length ? `Existing posts and ideas:\n${input.existing.map(t => `- ${t}`).join('\n')}` : '',
        `Suggest up to ${input.count} post ideas; fewer strong ones beat more weak ones. Reply with one JSON object: {"ideas": [{"title": "a headline, at most 80 characters", "angle": "two or three sentences: the specific story, what it shows, and what the writer should gather", "series": "a recurring series name if one fits, else omit", "score": 1-10 for how strong and timely the story is, "sources": [signal numbers it rests on${input.background?.length ? ', and "B1" and so on for background it draws on' : ''}]}]}`
    ]
        .filter(Boolean)
        .join('\n\n');
    return { system, user };
}

export interface IdeaReply {
    title: string;
    angle: string;
    series?: string;
    score?: number;
    /** The signals the idea rests on. */
    sources: Signal[];
}

/** The ideas in a model's reply, with their signal numbers (and background "B" numbers) resolved. */
export function readIdeas(text: string, signals: Signal[], background: Background[] = []): IdeaReply[] {
    const cite = (n: unknown): Signal | undefined => {
        const b = /^B(\d+)$/i.exec(String(n).trim());
        const page = b ? background[Number(b[1]) - 1] : undefined;
        if (page) return { ref: `background:${page.url ?? page.title}`, source: 'background', kind: 'page', title: page.title, summary: page.text.slice(0, 600), at: '', url: page.url };
        return b ? undefined : signals[Number(n) - 1];
    };
    const out: IdeaReply[] = [];
    for (const r of parseIdeaJson(text)) {
        if (!r?.title) continue;
        const refs = (Array.isArray(r.sources) ? r.sources : []).map(cite).filter(Boolean) as Signal[];
        out.push({
            title: String(r.title).slice(0, 200),
            angle: String(r.angle ?? ''),
            series: r.series ? String(r.series) : undefined,
            score: Number.isFinite(Number(r.score)) ? Number(r.score) : undefined,
            sources: refs
        });
    }
    return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function parseIdeaJson(text: string): any[] {
    const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
        const parsed = JSON.parse(body);
        return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ideas) ? parsed.ideas : [];
    } catch {
        // A reply cut off mid-list still has its complete ideas: keep those.
        const kept: any[] = [];
        for (const m of body.matchAll(/\{[^{}]*"title"[^{}]*\}/g)) {
            try {
                kept.push(JSON.parse(m[0]));
            } catch {}
        }
        if (!kept.length) throw new Error(`The model's reply was not JSON: ${body.slice(0, 200)}`);
        return kept;
    }
}

/** Newest first from every source in turn, so one busy source can't crowd out the rest. */
export function interleaveSignals(signals: Signal[], max: number): Signal[] {
    const bySource = new Map<string, Signal[]>();
    for (const s of signals) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s]);
    const lanes = [...bySource.values()].map(l => l.sort((a, b) => b.at.localeCompare(a.at)));
    const out: Signal[] = [];
    for (let i = 0; out.length < max && lanes.some(l => i < l.length); i++) for (const lane of lanes) if (i < lane.length && out.length < max) out.push(lane[i]);
    return out;
}

/** True when every policy lets the signal through to a model. */
export function admitSignal(policies: Policy[], signal: Signal): boolean {
    return policies.every(p => !p.admit || p.admit(signal));
}

/** True when a policy blocks the idea, e.g. it names someone on the denylist. */
export function ideaBlocked(policies: Policy[], idea: { title: string; angle: string }): boolean {
    return policies.some(p => p.review?.({ title: idea.title, body: idea.angle, citations: [] }).some(i => i.severity === 'block'));
}
