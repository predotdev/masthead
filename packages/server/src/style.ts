/**
 * House-style checks: the rules the editor underlines as people write (see
 * the admin's editor/style-rules.ts). The server only keeps the settings; the
 * checking happens in the browser, as you type.
 */
import { getSetting, setSetting } from './content';

export interface StyleSettings {
    rules: {
        /** Em dashes, and spaced en dashes or double hyphens used as one. */
        dashes: boolean;
        /** Names written only one way, e.g. a lowercase product name. */
        spelling: boolean;
        phrases: boolean;
        /** Names a post must never mention. */
        names: boolean;
        /** A post of some length with no link to another post. */
        links: boolean;
    };
    /** The right spelling of each name, one per entry; other casings and spacings are flagged. */
    spellings: string[];
    /** Phrases to avoid. "phrase => replacement" offers a one-click fix; "phrase =>" removes it. */
    phrases: string[];
    /** Names never to mention, with the same optional "=> replacement". */
    names: string[];
}

/** Generic defaults: the filler every editor strikes. A site adds its own names and spellings. */
export const DEFAULT_STYLE: StyleSettings = {
    rules: { dashes: true, spelling: true, phrases: true, names: true, links: true },
    spellings: [],
    phrases: ["in today's fast-paced world", 'game-changer', 'revolutionize', 'honestly =>', 'delve'],
    names: []
};

export function cleanStyleSettings(input: Partial<StyleSettings>): StyleSettings {
    const lines = (v: unknown, fallback: string[]) =>
        v === undefined
            ? fallback
            : [
                  ...new Set(
                      (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [])
                          .map(s => String(s).trim().slice(0, 200))
                          .filter(Boolean)
                  )
              ].slice(0, 300);
    const rules = { ...DEFAULT_STYLE.rules };
    const given = (input.rules ?? {}) as Partial<StyleSettings['rules']>;
    for (const key of Object.keys(rules) as (keyof StyleSettings['rules'])[]) if (key in given) rules[key] = Boolean(given[key]);
    return {
        rules,
        spellings: lines(input.spellings, DEFAULT_STYLE.spellings),
        phrases: lines(input.phrases, DEFAULT_STYLE.phrases),
        names: lines(input.names, DEFAULT_STYLE.names)
    };
}

export async function styleSettings(db: D1Database): Promise<StyleSettings> {
    return cleanStyleSettings(await getSetting<Partial<StyleSettings>>(db, 'style', {}));
}

export async function saveStyleSettings(db: D1Database, input: Partial<StyleSettings>): Promise<StyleSettings> {
    const current = await styleSettings(db);
    const next = cleanStyleSettings({ ...current, ...input, rules: { ...current.rules, ...(input.rules ?? {}) } });
    await setSetting(db, 'style', next);
    return next;
}
