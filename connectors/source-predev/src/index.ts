/**
 * Projects you build on pre.dev, as a studio source: every completed spec your
 * API key created, with the prompt and a link to the project.
 *
 *   predevProjects()   // uses PREDEV_API_KEY
 *
 * API reference: https://docs.pre.dev/api-reference
 */
import type { Evidence, Signal, Source } from '@masthead/core';

export interface PredevProjectsOptions {
    /** Defaults to the PREDEV_API_KEY environment variable. Use the key of the account that builds your showcase projects. */
    apiKey?: string;
    /** Defaults to https://api.pre.dev */
    baseUrl?: string;
}

export function predevProjects(options: PredevProjectsOptions = {}): Source {
    const base = (options.baseUrl ?? 'https://api.pre.dev').replace(/\/+$/, '');
    const call = async (path: string) => {
        const key = options.apiKey ?? (globalThis as any).process?.env?.PREDEV_API_KEY;
        if (!key) throw new Error('No pre.dev API key. Set PREDEV_API_KEY.');
        const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
        if (!res.ok) throw new Error(`pre.dev ${res.status} for ${path.split('?')[0]}`);
        return res.json();
    };

    return {
        id: 'predev',
        async *pull(since) {
            for (let skip = 0; skip < 1000; skip += 100) {
                const page = await call(`/list-specs?limit=100&skip=${skip}&status=completed`);
                const specs: any[] = page.specs ?? [];
                for (const s of specs) {
                    if (new Date(s.created) < since) return;
                    const input = String(s.input ?? '').trim();
                    if (!input) continue;
                    yield {
                        ref: `predev:spec:${s._id}`,
                        source: 'predev',
                        kind: 'project',
                        title: firstLine(input),
                        summary: input.slice(0, 600),
                        at: s.created,
                        url: s.predevUrl || undefined,
                        metrics: s.executionTime ? { buildSeconds: Math.round(s.executionTime / 1000) } : undefined
                    } satisfies Signal;
                }
                if (!page.hasMore) return;
            }
        },
        async expand(ref): Promise<Evidence> {
            const id = ref.replace(/^predev:spec:/, '');
            const s = await call(`/spec-status/${encodeURIComponent(id)}`);
            const input = String(s.input ?? '');
            return { ref, title: firstLine(input), body: input, fields: { url: s.predevUrl, status: s.status, created: s.created } };
        }
    };
}

function firstLine(text: string): string {
    const line = text.split('\n').find(l => l.trim()) ?? text;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
