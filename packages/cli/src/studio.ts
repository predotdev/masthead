/**
 * The studio: turns what is happening in your sources (work shipped, projects
 * built, results measured) into post ideas, and sends them to the server's
 * Ideas page, where anyone on the team can draft one with a click.
 *
 * Sources and policies come from the config, so the studio reads only what
 * you list there, and a denylist keeps private names out of everything.
 */
import type { AIProvider, MastheadConfig, Policy, Signal } from '@masthead/core';

export interface IdeaOptions {
    days: number;
    count: number;
    server?: string;
    token?: string;
    dryRun?: boolean;
    model?: string;
}

interface Idea {
    title: string;
    angle: string;
    series?: string;
    score?: number;
    sources: { ref: string; title: string; url?: string; summary: string }[];
}

const PER_SOURCE = 400;
const PROMPT_SIGNALS = 120;

export async function collectSignals(cfg: MastheadConfig, days: number) {
    const since = new Date(Date.now() - days * 86400_000);
    const policies = cfg.policies ?? [];
    const report: { source: string; read: number; kept: number; error?: string }[] = [];
    const lists = await Promise.all(
        (cfg.sources ?? []).map(async source => {
            const kept: Signal[] = [];
            let read = 0;
            try {
                for await (const s of source.pull(since)) {
                    read++;
                    if (policies.every(p => !p.admit || p.admit(s))) kept.push(s);
                    if (read >= PER_SOURCE) break;
                }
                report.push({ source: source.id, read, kept: kept.length });
            } catch (err) {
                report.push({ source: source.id, read, kept: kept.length, error: err instanceof Error ? err.message : String(err) });
            }
            return kept;
        })
    );
    const signals = lists.flat().sort((a, b) => b.at.localeCompare(a.at));
    return { signals, report, since };
}

export function printSignals(signals: Signal[], report: Awaited<ReturnType<typeof collectSignals>>['report']) {
    for (const r of report) console.log(`${r.source.padEnd(28)} read ${String(r.read).padStart(4)}  kept ${String(r.kept).padStart(4)}${r.error ? `  ERROR ${r.error}` : ''}`);
    console.log('');
    for (const s of signals) console.log(`${s.at.slice(0, 10)}  ${`${s.source}/${s.kind}`.padEnd(20)} ${s.title.slice(0, 100)}`);
    console.log(`\n${signals.length} signals`);
}

export async function generateIdeas(cfg: MastheadConfig, ai: AIProvider, opts: IdeaOptions): Promise<void> {
    const { signals, report } = await collectSignals(cfg, opts.days);
    for (const r of report) console.log(`${r.source.padEnd(28)} ${r.kept} signals${r.error ? `  ERROR ${r.error}` : ''}`);
    if (!signals.length) {
        console.log('\nNothing new in the window. Try a larger --days.');
        return;
    }

    const server = opts.server ? opts.server.replace(/\/?$/, '/') : undefined;
    const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${server}admin/api${path}`, {
            method,
            headers: { authorization: `Bearer ${opts.token}`, 'x-masthead': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });
        if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        return res.json();
    };

    // What already exists, so ideas don't repeat it.
    let existing: string[] = [];
    let voice: string | null = null;
    let siteTitle = cfg.site?.title ?? 'the company';
    if (server) {
        const [posts, ideas, settings] = await Promise.all([call('GET', '/posts?status=published&limit=200'), call('GET', '/ideas?status=new'), call('GET', '/settings').catch(() => null)]);
        existing = [...posts.items.map((p: any) => p.title), ...ideas.map((i: any) => `${i.title} (already suggested)`)];
        voice = settings?.ai?.voice ?? null;
        siteTitle = settings?.site?.title ?? siteTitle;
    } else if (cfg.content) {
        existing = (await cfg.content.load()).posts.filter(p => p.status === 'published').map(p => p.title);
    }

    const numbered = interleave(signals, PROMPT_SIGNALS);
    const system = [
        `You are the editor of the ${siteTitle} blog. You suggest posts that come straight out of real work: things that shipped, projects that were built, results that were measured.`,
        'Every idea must be grounded only in the signals given. Never invent numbers, customers, quotes or outcomes; the angle can say what a writer would need to find out.',
        'Never name customers, partners, vendors, individual people, or the projects, apps and companies of users that appear in the signals. Describe them generically ("a restaurant app", "an agency").',
        'Never build an idea on internal pricing, revenue, deal terms, traffic or analytics numbers, sales process, or security details. Skip signals that are only about those.',
        'Prefer specific, useful stories a developer or founder would click: how something works, what it cost, what failed first, a head-to-head result, a build walkthrough.',
        'Do not repeat or lightly reword an existing post.',
        voice ? `House style:\n${voice}` : ''
    ]
        .filter(Boolean)
        .join('\n\n');
    const user = [
        `Signals, newest first:`,
        numbered.map((s, i) => `[${i + 1}] ${s.at.slice(0, 10)} ${s.source}/${s.kind}: ${s.title}${s.summary ? `\n${s.summary.slice(0, 400)}` : ''}`).join('\n\n'),
        existing.length ? `Existing posts and ideas:\n${existing.map(t => `- ${t}`).join('\n')}` : '',
        `Suggest ${opts.count} post ideas. Reply with one JSON object: {"ideas": [{"title": "a headline, at most 80 characters", "angle": "two or three sentences: the specific story, what it shows, and what the writer should gather", "series": "a recurring series name if one fits, else omit", "score": 1-10 for how strong and timely the story is, "sources": [signal numbers it rests on]}]}`
    ]
        .filter(Boolean)
        .join('\n\n');

    const t0 = performance.now();
    const res = await ai.text({ model: opts.model, system, messages: [{ role: 'user', content: user }], json: true, maxTokens: 8000, temperature: 0.7 });
    const raw = parseIdeas(res.text);
    const policies = cfg.policies ?? [];
    const ideas: Idea[] = [];
    let blocked = 0;
    for (const r of raw) {
        if (!r?.title) continue;
        const refs = (Array.isArray(r.sources) ? r.sources : []).map((n: unknown) => numbered[Number(n) - 1]).filter(Boolean) as Signal[];
        const issues = reviewAll(policies, `${r.title}`, `${r.angle ?? ''}`);
        if (issues) {
            blocked++;
            continue;
        }
        ideas.push({
            title: String(r.title).slice(0, 200),
            angle: String(r.angle ?? ''),
            series: r.series ? String(r.series) : undefined,
            score: Number.isFinite(Number(r.score)) ? Number(r.score) : undefined,
            sources: refs.map(s => ({ ref: s.ref, title: s.title, url: s.url, summary: s.summary.slice(0, 600) }))
        });
    }
    ideas.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    console.log(`\n${ideas.length} ideas from ${numbered.length} signals · ${res.model} · ${res.usage.charged ?? '?'} credits · ${Math.round(performance.now() - t0)} ms${blocked ? ` · ${blocked} blocked by policy` : ''}\n`);
    for (const i of ideas) {
        console.log(`${String(i.score ?? '-').padStart(2)}  ${i.title}${i.series ? `  [${i.series}]` : ''}`);
        console.log(`    ${i.angle}`);
        for (const s of i.sources) console.log(`    · ${s.title.slice(0, 90)}${s.url ? `  ${s.url}` : ''}`);
        console.log('');
    }
    if (opts.dryRun || !server) {
        console.log(server ? 'Dry run: nothing was saved.' : 'No --server given: nothing was saved.');
        return;
    }
    const { added } = await call('POST', '/ideas', { ideas });
    console.log(`Saved ${added} ideas to ${server}admin/#/ideas`);
}

/** Newest first from every source in turn, so one busy source can't crowd out the rest. */
function interleave(signals: Signal[], max: number): Signal[] {
    const bySource = new Map<string, Signal[]>();
    for (const s of signals) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s]);
    const lanes = [...bySource.values()];
    const out: Signal[] = [];
    for (let i = 0; out.length < max && lanes.some(l => i < l.length); i++) for (const lane of lanes) if (i < lane.length && out.length < max) out.push(lane[i]);
    return out;
}

function reviewAll(policies: Policy[], title: string, body: string): boolean {
    return policies.some(p => p.review?.({ title, body, citations: [] }).some(i => i.severity === 'block'));
}

function parseIdeas(text: string): any[] {
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
