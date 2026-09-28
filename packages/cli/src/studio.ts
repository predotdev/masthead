/**
 * The studio: turns what is happening in your sources (work shipped, projects
 * built, results measured) into post ideas, and sends them to the server's
 * Ideas page, where anyone on the team can draft one with a click.
 *
 * Sources and policies come from the config, so the studio reads only what
 * you list there, and a denylist keeps private names out of everything.
 */
import { admitSignal, denylist, ideaBlocked, ideaPrompt, interleaveSignals, readIdeas, type AIProvider, type MastheadConfig, type Signal } from '@masthead/core';

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
                    if (admitSignal(policies, s)) kept.push(s);
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

    // What already exists, so ideas don't repeat it, and the site's voice, memory and idea settings.
    let existing: string[] = [];
    let settings: any = null;
    if (server) {
        const [posts, ideas, s] = await Promise.all([call('GET', '/posts?status=published&limit=200'), call('GET', '/ideas?status=new'), call('GET', '/settings').catch(() => null)]);
        existing = [...posts.items.map((p: any) => p.title), ...ideas.map((i: any) => `${i.title} (already suggested)`)];
        settings = s;
    } else if (cfg.content) {
        existing = (await cfg.content.load()).posts.filter(p => p.status === 'published').map(p => p.title);
    }
    // The server's denylist (Settings, Ideas) applies here too, on top of the config's policies.
    const serverTerms: string[] = Array.isArray(settings?.ideas?.denylist) ? settings.ideas.denylist : [];
    const policies = [...(cfg.policies ?? []), ...(serverTerms.length ? [denylist(serverTerms, 'server-denylist')] : [])];

    const { signals, report } = await collectSignals({ ...cfg, policies }, opts.days);
    for (const r of report) console.log(`${r.source.padEnd(28)} ${r.kept} signals${r.error ? `  ERROR ${r.error}` : ''}`);
    if (!signals.length) {
        console.log('\nNothing new in the window. Try a larger --days.');
        return;
    }

    const numbered = interleaveSignals(signals, PROMPT_SIGNALS);
    const { system, user } = ideaPrompt({
        site: settings?.site?.title ?? cfg.site?.title ?? 'the company',
        voice: settings?.ai?.voice ?? null,
        memory: Array.isArray(settings?.ai?.memory) ? settings.ai.memory.map((m: any) => String(m.text)) : [],
        guidance: settings?.ideas?.guidance ?? null,
        signals: numbered,
        existing,
        count: opts.count
    });

    const t0 = performance.now();
    const res = await ai.text({ model: opts.model, system, messages: [{ role: 'user', content: user }], json: true, maxTokens: 8000, temperature: 0.7 });
    const ideas: Idea[] = [];
    let blocked = 0;
    for (const r of readIdeas(res.text, numbered)) {
        if (ideaBlocked(policies, r)) {
            blocked++;
            continue;
        }
        ideas.push({ ...r, sources: r.sources.map(s => ({ ref: s.ref, title: s.title, url: s.url, summary: s.summary.slice(0, 600) })) });
    }

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
