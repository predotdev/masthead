/**
 * The site's house-style rules (Settings, Style checks), loaded once per visit
 * and shared by the editor, the title and the publish dialog. No editor code in
 * here, so Settings can use it without loading the editor.
 */
import { computed, signal } from '@preact/signals';
import { api } from './api';
import { compileRules } from './editor/style-rules';

/** GET /style: the rules as the server keeps them (style.ts). */
export interface StyleSettings {
    rules: { dashes: boolean; spelling: boolean; phrases: boolean; names: boolean; links: boolean };
    /** The right spelling of each name, one per entry. */
    spellings: string[];
    /** "phrase", or "phrase => replacement" for a one-click fix ("phrase =>" removes it). */
    phrases: string[];
    /** Names never to mention, with the same optional "=> replacement". */
    names: string[];
}

export const styleSettings = signal<StyleSettings | null>(null);

/** The rules ready to run; null until they have loaded. */
export const styleRules = computed(() => (styleSettings.value ? compileRules(styleSettings.value) : null));

let loading: Promise<unknown> | null = null;

/** Loads the rules, once; `fresh` asks again, e.g. after Settings saved new ones. */
export function loadStyle(fresh = false): Promise<unknown> {
    if (loading && !fresh) return loading;
    loading = api<StyleSettings>('/style').then(
        s => (styleSettings.value = s),
        () => (loading = null)
    );
    return loading;
}
