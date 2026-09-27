/**
 * Any JSON document as a studio source: a public changelog, a status page, an
 * internal API. You supply the mapping, so only the fields you choose become
 * signals.
 *
 *   jsonFeed({
 *     id: 'changelog',
 *     url: 'https://example.com/changelog.json',
 *     map: json => json.entries.map(e => ({ ref: `changelog:${e.id}`, source: 'changelog', kind: 'release', title: e.title, summary: e.body, at: e.date }))
 *   })
 */
import type { Evidence, Signal, Source } from '@masthead/core';

export interface JsonFeedOptions {
    id: string;
    url: string;
    map: (json: any) => Signal[];
    headers?: Record<string, string>;
}

export function jsonFeed(options: JsonFeedOptions): Source {
    const seen = new Map<string, Signal>();
    return {
        id: options.id,
        async *pull(since) {
            const res = await fetch(options.url, { headers: { accept: 'application/json', 'user-agent': 'masthead-studio', ...options.headers } });
            if (!res.ok) throw new Error(`${options.id}: HTTP ${res.status} from ${new URL(options.url).host}`);
            const signals = options.map(await res.json()).filter(s => new Date(s.at) >= since);
            for (const s of signals.sort((a, b) => b.at.localeCompare(a.at))) {
                seen.set(s.ref, s);
                yield s;
            }
        },
        async expand(ref): Promise<Evidence> {
            const s = seen.get(ref);
            if (!s) throw new Error(`Pull first: ${ref} has not been read.`);
            return { ref, title: s.title, body: s.summary, fields: s.metrics };
        }
    };
}
