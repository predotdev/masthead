import type { Evidence, Issue, Policy, Signal } from './types';

/**
 * Keeps names you never publish (customers, partners, vendors, internal
 * hosts) out of the studio. Signals that mention one are skipped, evidence
 * has them masked, and drafts that contain one are blocked. Issues name the
 * term by its position in the list, never the term itself.
 */
export function denylist(terms: string[], id = 'denylist'): Policy {
    const list = terms.map(t => t.trim()).filter(t => t && !t.startsWith('#'));
    const source = list.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const find = () => (source ? new RegExp(source, 'gi') : null);
    const termNumber = (hit: string) => list.findIndex(t => t.toLowerCase() === hit.toLowerCase()) + 1;
    const mask = (text: string) => text.replace(find() ?? /$^/, '[redacted]');

    return {
        id,
        // Only the text a model reads can end up in a post; links stay in the admin.
        admit: (s: Signal) => !find()?.test(`${s.title}\n${s.summary}`),
        redact: (e: Evidence): Evidence => ({ ...e, title: mask(e.title), body: mask(e.body) }),
        review: (draft): Issue[] =>
            [...`${draft.title}\n${draft.body}`.matchAll(find() ?? /$^/g)].map(m => ({
                severity: 'block',
                message: `Mentions denylist term #${termNumber(m[0])}.`,
                range: [m.index ?? 0, (m.index ?? 0) + m[0].length] as [number, number]
            }))
    };
}
