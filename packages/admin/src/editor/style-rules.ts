/**
 * House-style rules as plain functions over a piece of text: em dashes, names
 * spelled one way, phrases to avoid and names never to mention (Settings, Style
 * checks). The editor runs them on each paragraph and on the title as people
 * type. A finding carries its fixes as edits to the same text, best first.
 */
import type { StyleSettings } from '../house-style';

export type RuleId = 'dash' | 'spelling' | 'phrase' | 'name';

/** [from, to) of the checked text becomes `text`. */
export interface Edit {
    from: number;
    to: number;
    text: string;
}

/** How a fix reads in place: a few words either side, with what it takes out and puts in. */
export interface PreviewPart {
    text: string;
    del?: boolean;
    ins?: boolean;
}

export interface Fix {
    label: string;
    edits: Edit[];
    preview?: PreviewPart[];
    /** Part of "Fix all": right wherever the issue turns up. */
    safe?: boolean;
    /** Instead of edits: the AI rewrites this range (the sentence) by the instruction. */
    rewrite?: { from: number; to: number; instruction: string };
}

export interface Finding {
    rule: RuleId;
    from: number;
    to: number;
    /** The flagged text as written. */
    text: string;
    title: string;
    message: string;
    fixes: Fix[];
    /** The finding in terms that survive edits elsewhere in the post, for "Ignore". */
    key: string;
    /** A few words either side, for lists of findings. */
    context: { before: string; after: string };
}

interface ListRule {
    label: string;
    re: RegExp;
    /** null: no one-click fix; "": remove it. */
    replacement: string | null;
}

export interface CompiledRules {
    dashes: boolean;
    spellings: { name: string; re: RegExp }[];
    phrases: ListRule[];
    names: ListRule[];
    links: boolean;
    /** Names that keep their lowercase at the start of a sentence (lowercased, e.g. "pre.dev"). */
    lowercase: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '[\\s\\u00a0\\u2010\\u2011-]*';
const EDGE_BEFORE = '(?<![\\p{L}\\p{N}_])';
const EDGE_AFTER = '(?![\\p{L}\\p{N}_])';

/** "phrase => replacement". No arrow: no replacement; an arrow with nothing after it removes the phrase. */
function entry(line: string): { label: string; replacement: string | null } {
    const at = line.indexOf('=>');
    return at < 0 ? { label: line.trim(), replacement: null } : { label: line.slice(0, at).trim(), replacement: line.slice(at + 2).trim() };
}

/** A phrase as a pattern: any spacing or hyphen between its words, either apostrophe, and (for phrases) the last word's endings. */
function wordsPattern(phrase: string, inflect: boolean): string {
    const words = phrase.split(/[\s\u00a0\u2010\u2011-]+/).filter(Boolean);
    return words
        .map((w, i) => {
            const e = escape(w).replace(/['’]/g, "['’]");
            if (!inflect || i < words.length - 1 || !/^[a-z]{4,}$/i.test(w)) return e;
            // "delve" also catches delves, delved and delving; "game-changer" catches game-changers.
            return /e$/i.test(w) ? `${e.slice(0, -1)}(?:e|es|ed|er|ers|ing)` : `${e}(?:s|es|ed|er|ers|ing)?`;
        })
        .join(SEP);
}

export function compileRules(s: StyleSettings): CompiledRules {
    const list = (lines: string[], inflect: boolean): ListRule[] =>
        lines.flatMap(line => {
            const { label, replacement } = entry(line);
            if (!label) return [];
            try {
                return [{ label, replacement, re: new RegExp(`${EDGE_BEFORE}${wordsPattern(label, inflect)}${EDGE_AFTER}`, 'giu') }];
            } catch {
                return [];
            }
        });
    const spellings = s.spellings.flatMap(name => {
        const parts = name.trim().match(/[\p{L}\p{N}]+/gu);
        if (!parts) return [];
        // Other casings and spacings of the name ("Pre Dev", "PreDev"), but never part of an address or a longer word.
        const re = new RegExp(`(?<![\\p{L}\\p{N}_@/.\\-])${parts.map(escape).join('[\\s._\\-]?')}(?![\\p{L}\\p{N}_@/\\-]|\\.[\\p{L}\\p{N}])`, 'giu');
        return [{ name: name.trim(), re }];
    });
    return {
        dashes: s.rules.dashes,
        spellings: s.rules.spelling ? spellings : [],
        phrases: s.rules.phrases ? list(s.phrases, true) : [],
        names: s.rules.names ? list(s.names, false) : [],
        links: s.rules.links,
        lowercase: spellings.map(x => x.name).filter(n => /^\p{Ll}/u.test(n)).map(n => n.toLowerCase())
    };
}

/** Everything the rules find in the text, in reading order. Overlaps keep the first. */
export function checkText(text: string, rules: CompiledRules): Finding[] {
    const found: Finding[] = [];
    if (rules.dashes) dashes(text, rules, found);
    for (const s of rules.spellings) spelling(text, s, found);
    for (const p of rules.phrases) listed(text, p, 'phrase', rules, found);
    for (const n of rules.names) listed(text, n, 'name', rules, found);
    found.sort((a, b) => a.from - b.from || b.to - a.to);
    const out: Finding[] = [];
    for (const f of found) if (!out.length || f.from >= out[out.length - 1].to) out.push(f);
    return out;
}

/**
 * Edits in the order to make them: last first, so earlier offsets hold. An edit that
 * overlaps one already taken is dropped (the two dashes of a pair share their edits).
 */
export function orderEdits(edits: Edit[]): Edit[] {
    const out: Edit[] = [];
    let limit = Infinity;
    for (const e of [...edits].sort((a, b) => b.from - a.from || b.to - a.to)) {
        if (e.to > limit) continue;
        out.push(e);
        limit = e.from;
    }
    return out;
}

/** The text with the edits made. */
export function applyEdits(text: string, edits: Edit[]): string {
    return orderEdits(edits).reduce((t, e) => t.slice(0, e.from) + e.text + t.slice(e.to), text);
}

// ------------------------------------------------------------------ the rules

// An em dash (or a horizontal bar) with any spaces around it; a spaced en dash or double hyphen reads as one too.
const DASH = /[ \t\u00a0]*[\u2014\u2015][ \t\u00a0]*|[ \t\u00a0]+(?:\u2013|--)[ \t\u00a0]+/g;
// Words that join what follows a dash to what comes before it: a comma, not a colon.
const JOINS = /^(?:and|but|or|so|yet|nor|which|who|whose|while|because|though|although|until|unless|since|when|where|whereas|then)\b/i;

/** Stands in the checked text for an inline node (a line break, an image) or code, so offsets match the document. */
export const LEAF = '\ufffc';

function dashes(text: string, rules: CompiledRules, out: Finding[]) {
    const all = [...text.matchAll(DASH)].map(m => ({ start: m.index!, end: m.index! + m[0].length, raw: m[0] }));
    // Two dashes in one sentence set off an aside ("teams, even big ones, skip it"): they are fixed as a pair.
    const partner = new Map<number, number>();
    for (let i = 0; i + 1 < all.length; i++) {
        if (partner.has(i)) continue;
        const s = sentenceAround(text, all[i].start, all[i].end);
        if (all[i + 1].end <= s.to && !partner.has(i + 1)) (partner.set(i, i + 1), partner.set(i + 1, i));
    }
    all.forEach((m, i) => {
        const { start, end } = m;
        const from = start + (m.raw.length - m.raw.trimStart().length);
        const to = end - (m.raw.length - m.raw.trimEnd().length);
        const before = text.slice(0, start);
        const after = text.slice(end);
        const edit = (t: string): Edit => ({ from: start, to: end, text: t });
        let fixes: Fix[];
        const other = partner.get(i);
        if (other !== undefined) {
            const [open, close] = other > i ? [m, all[other]] : [all[other], m];
            // The closing mark sits against punctuation that follows it ("…, mostly)." not "…, mostly) .").
            const tight = /^[.,;:!?)]/.test(text.slice(close.end));
            // A colon or a period changes only the dash you clicked: for dashes that only look like a pair.
            fixes = [
                { label: 'Commas', edits: [{ from: open.start, to: open.end, text: ', ' }, { from: close.start, to: close.end, text: tight ? '' : ', ' }], safe: true },
                { label: 'Parentheses', edits: [{ from: open.start, to: open.end, text: ' (' }, { from: close.start, to: close.end, text: tight ? ')' : ') ' }] },
                { label: 'Colon', edits: [edit(': ')] },
                { label: 'Period', edits: [edit('. '), ...capitalizeAt(text, end, rules)] }
            ];
        } else if (!before.trim() || before.endsWith(LEAF)) fixes = [{ label: 'Remove', edits: [edit('')] }];
        else if (!after.trim() || after.startsWith(LEAF)) fixes = [{ label: 'Period', edits: [edit(/[.!?…:;,]$/.test(before) ? '' : '.')], safe: true }];
        else {
            // One dash introduces what follows: a colon reads right, unless a joining word
            // comes next ("of 20, and nobody notices", "the API, which").
            const comma: Fix = { label: 'Comma', edits: [edit(', ')] };
            const colon: Fix = { label: 'Colon', edits: [edit(': ')] };
            const period: Fix = { label: 'Period', edits: [edit('. '), ...capitalizeAt(text, end, rules)] };
            fixes = JOINS.test(after) ? [comma, colon, period] : [colon, comma, period];
            fixes[0].safe = true;
        }
        for (const f of fixes) f.preview = preview(text, f.edits);
        const em = /[\u2014\u2015]/.test(m.raw);
        out.push({
            rule: 'dash',
            from,
            to,
            text: text.slice(from, to),
            title: 'Em dash',
            message: em ? 'The house style has no em dashes. Pick what reads best here.' : 'A spaced dash reads as an em dash, and the house style has none.',
            fixes,
            key: keyOf('dash', text, from, to),
            context: around(text, from, to)
        });
    });
}

function spelling(text: string, s: { name: string; re: RegExp }, out: Finding[]) {
    for (const m of text.matchAll(s.re)) {
        if (m[0] === s.name) continue;
        const from = m.index!;
        const to = from + m[0].length;
        const edits = [{ from, to, text: s.name }];
        out.push({
            rule: 'spelling',
            from,
            to,
            text: m[0],
            title: 'Spelling',
            message: /^\p{Ll}/u.test(s.name) ? `Write ${s.name}, lowercase even at the start of a sentence.` : `Write it as ${s.name}.`,
            fixes: [{ label: `Write ${s.name}`, edits, preview: preview(text, edits), safe: true }],
            key: keyOf('spelling', text, from, to),
            context: around(text, from, to)
        });
    }
}

function listed(text: string, r: ListRule, rule: 'phrase' | 'name', rules: CompiledRules, out: Finding[]) {
    for (const m of text.matchAll(r.re)) {
        const from = m.index!;
        const to = from + m[0].length;
        const fixes: Fix[] = [];
        if (r.replacement === '') fixes.push({ label: 'Remove it', edits: removal(text, from, to, rules), safe: true });
        // An inflected match ("utilized" for "utilize => use") would lose its ending: that one is for the AI.
        else if (r.replacement && (rule === 'name' || normal(m[0]) === normal(r.label))) {
            const put = startsSentence(text.slice(0, from)) && !keepsCase(r.replacement, rules) ? r.replacement.replace(/^\p{Ll}/u, c => c.toUpperCase()) : r.replacement;
            fixes.push({ label: `Use “${r.replacement}”`, edits: [{ from, to, text: put }], safe: true });
        }
        const s = sentenceAround(text, from, to);
        fixes.push({
            label: 'Rewrite with AI',
            edits: [],
            rewrite: {
                from: s.from,
                to: s.to,
                instruction: rule === 'phrase' ? `Rewrite this without “${m[0]}”. Keep the meaning, the facts and the links.` : `Rewrite this so it does not name ${m[0]}. Keep the meaning, the facts and the links.`
            }
        });
        for (const f of fixes) if (f.edits.length) f.preview = preview(text, f.edits);
        out.push({
            rule,
            from,
            to,
            text: m[0],
            title: rule === 'phrase' ? 'Phrase to avoid' : 'Never mention',
            message: rule === 'phrase' ? `“${r.label}” is on the list of phrases to avoid.` : `Posts never name ${r.label}.`,
            fixes,
            key: keyOf(rule, text, from, to),
            context: around(text, from, to)
        });
    }
}

// ------------------------------------------------------------------ helpers

const normal = (s: string) => s.toLowerCase().replace(/’/g, "'").replace(/[\s\u00a0\u2010\u2011-]+/g, ' ').trim();

const keyOf = (rule: RuleId, text: string, from: number, to: number) =>
    [rule, text.slice(from, to), text.slice(Math.max(0, from - 16), from), text.slice(to, to + 16)].map(normal).join('|');

/** Up to about 40 characters either side of [from, to), cut at word boundaries. */
function around(text: string, from: number, to: number, room = 40): { before: string; after: string } {
    const head = text.slice(0, from).replaceAll(LEAF, ' ');
    const tail = text.slice(to).replaceAll(LEAF, ' ');
    return {
        before: head.length > room ? `\u2026${head.slice(head.length - room).replace(/^\S*\s/, '')}` : head,
        after: tail.length > room ? tail.slice(0, room).replace(/\s\S*$/, '').replace(/([^.!?\u2026])$/, '$1\u2026') : tail
    };
}

const startsSentence = (before: string) => !before.trim() || before.endsWith(LEAF) || /[.!?]["'”’)\]]*[ \t\u00a0]*$/.test(before);

const keepsCase = (text: string, rules: CompiledRules) => rules.lowercase.some(n => text.toLowerCase().startsWith(n));

/** The sentence holding [from, to): from after the last sentence end before it to the next one after it. */
export function sentenceAround(text: string, from: number, to: number): { from: number; to: number } {
    let start = 0;
    for (const m of text.matchAll(/[.!?]["'”’)\]]*[ \t\u00a0]+/g)) {
        if (m.index! + m[0].length > from) break;
        start = m.index! + m[0].length;
    }
    const tail = /[.!?]["'”’)\]]*(?=[ \t\u00a0]|$)/g;
    tail.lastIndex = to;
    const end = tail.exec(text);
    return { from: start, to: end ? end.index + end[0].length : text.length };
}

/** Capitalizes the word at `at`, unless it is a name that keeps its lowercase or a word with its own casing (iOS, pre.dev). */
function capitalizeAt(text: string, at: number, rules: CompiledRules): Edit[] {
    const word = text.slice(at).match(/^[\p{L}\p{N}][\p{L}\p{N}.'’_-]*/u)?.[0];
    if (!word || !/^\p{Ll}+$/u.test(word.replace(/['’]s$/, '')) || keepsCase(word, rules)) return [];
    return [{ from: at, to: at + 1, text: text[at].toUpperCase() }];
}

/**
 * Takes a word or phrase out and leaves the sentence whole: "It was, honestly, fast"
 * becomes "It was fast"; "Honestly, the API" becomes "The API".
 */
function removal(text: string, from: number, to: number, rules: CompiledRules): Edit[] {
    const before = text.slice(0, from);
    const after = text.slice(to);
    const start = startsSentence(before);
    const commaBefore = before.match(/,[ \t\u00a0]*$/)?.[0];
    const commaAfter = after.match(/^[ \t\u00a0]*,/)?.[0];
    if (commaBefore && (commaAfter || /^[ \t\u00a0]*[.!?]/.test(after))) return [{ from: from - commaBefore.length, to: to + (commaAfter?.length ?? 0), text: '' }];
    if (commaAfter) {
        const end = to + commaAfter.length + (after.slice(commaAfter.length).match(/^[ \t\u00a0]*/)?.[0].length ?? 0);
        return [{ from, to: end, text: '' }, ...(start ? capitalizeAt(text, end, rules) : [])];
    }
    const spaceBefore = before.match(/[ \t\u00a0]+$/)?.[0] ?? '';
    const spaceAfter = after.match(/^[ \t\u00a0]+/)?.[0] ?? '';
    if (start || !spaceBefore) return [{ from, to: to + spaceAfter.length, text: '' }, ...(start ? capitalizeAt(text, to + spaceAfter.length, rules) : [])];
    return [{ from: from - spaceBefore.length, to, text: '' }];
}

/** A few words either side of the change, cut at word boundaries, with what goes and what comes. */
function preview(text: string, edits: Edit[], room = 22): PreviewPart[] {
    const sorted = [...edits].sort((a, b) => a.from - b.from);
    const plain = (t: string) => t.replaceAll(LEAF, ' ');
    const head = plain(text.slice(0, sorted[0].from));
    const tail = plain(text.slice(sorted[sorted.length - 1].to));
    const parts: PreviewPart[] = [{ text: head.length > room ? `\u2026${head.slice(head.length - room).replace(/^\S*\s/, '')}` : head }];
    let at = sorted[0].from;
    for (const e of sorted) {
        if (e.from > at) parts.push({ text: plain(text.slice(at, e.from)) });
        const del = text.slice(e.from, e.to);
        // A change of case shows as the new letters alone; spaces kept on both sides are not part of the change.
        if (del.toLowerCase() === e.text.toLowerCase()) parts.push({ text: e.text, ins: true });
        else {
            const lead = Math.min(del.match(/^\s*/)![0].length, e.text.match(/^\s*/)![0].length);
            const trail = Math.min(del.match(/\s*$/)![0].length, e.text.match(/\s*$/)![0].length);
            parts.push({ text: del.slice(0, lead) });
            parts.push({ text: plain(del.slice(lead, del.length - trail)), del: true });
            parts.push({ text: e.text.slice(lead, e.text.length - trail), ins: true });
            parts.push({ text: del.slice(del.length - trail) });
        }
        at = e.to;
    }
    parts.push({ text: tail.length > room ? `${tail.slice(0, room).replace(/\s\S*$/, '')}\u2026` : tail });
    return parts.filter(p => p.text);
}
