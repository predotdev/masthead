import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { StyleSettings } from '../house-style';

const lines = (text: string) =>
    text
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

/** Tall enough for the list and a line to add to it. */
const rowsFor = (text: string) => Math.min(14, Math.max(3, text.split('\n').length + 1));

/** Settings, Style checks: what the editor underlines as people write. Nothing here blocks publishing. */
export function StyleChecksSettings({ value, onChange }: { value: StyleSettings; onChange: (v: StyleSettings) => void }) {
    // The lists are edited as text; blank lines and all stay as typed until saved.
    const [spellings, setSpellings] = useState(value.spellings.join('\n'));
    const [phrases, setPhrases] = useState(value.phrases.join('\n'));
    const [names, setNames] = useState(value.names.join('\n'));
    const toggle = (rule: keyof StyleSettings['rules']) => (on: boolean) => onChange({ ...value, rules: { ...value.rules, [rule]: on } });
    return (
        <div class="style-rules">
            <Rule on={value.rules.dashes} onToggle={toggle('dashes')} label="No em dashes" hint="Offers a comma, colon or period in their place. A spaced en dash or double hyphen counts as one." />
            <Rule on={value.rules.spelling} onToggle={toggle('spelling')} label="Names spelled one way" hint="One name per line, written the only right way. Other casings and spacings are flagged, e.g. Github for GitHub.">
                <textarea
                    rows={rowsFor(spellings)}
                    value={spellings}
                    spellcheck={false}
                    placeholder="GitHub"
                    aria-label="Names spelled one way"
                    onInput={e => {
                        setSpellings(e.currentTarget.value);
                        onChange({ ...value, spellings: lines(e.currentTarget.value) });
                    }}
                />
            </Rule>
            <Rule on={value.rules.phrases} onToggle={toggle('phrases')} label="Phrases to avoid" hint="One per line. Add => and a replacement for a one-click fix, as in utilize => use. A phrase followed by => alone is removed.">
                <textarea
                    rows={rowsFor(phrases)}
                    value={phrases}
                    spellcheck={false}
                    aria-label="Phrases to avoid"
                    onInput={e => {
                        setPhrases(e.currentTarget.value);
                        onChange({ ...value, phrases: lines(e.currentTarget.value) });
                    }}
                />
            </Rule>
            <Rule on={value.rules.names} onToggle={toggle('names')} label="Names never to mention" hint="Vendors, providers or customers a post must not name, one per line. => works here too, e.g. to name your own product instead.">
                <textarea
                    rows={rowsFor(names)}
                    value={names}
                    spellcheck={false}
                    aria-label="Names never to mention"
                    onInput={e => {
                        setNames(e.currentTarget.value);
                        onChange({ ...value, names: lines(e.currentTarget.value) });
                    }}
                />
            </Rule>
            <Rule on={value.rules.links} onToggle={toggle('links')} label="Posts link to other posts" hint="Flags a post of 150 words or more with no link to another post, and suggests posts on the same subject." />
        </div>
    );
}

function Rule({ on, onToggle, label, hint, children }: { on: boolean; onToggle: (on: boolean) => void; label: string; hint: string; children?: ComponentChildren }) {
    return (
        <div class={`style-rule${on ? '' : ' off'}`}>
            <label class="check">
                <input type="checkbox" checked={on} onChange={e => onToggle(e.currentTarget.checked)} />
                <span class="style-rule-text">
                    <span class="style-rule-label">{label}</span>
                    <span class="field-hint">{hint}</span>
                </span>
            </label>
            {children && on ? <div class="style-rule-list">{children}</div> : null}
        </div>
    );
}
