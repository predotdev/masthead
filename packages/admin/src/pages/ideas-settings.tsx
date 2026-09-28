import { useState } from 'preact/hooks';
import { Field } from '../ui';

/** Settings, Ideas: how the server's daily idea refresh runs (see ideas.ts on the server). */
export interface IdeaSettings {
    enabled: boolean;
    hour: number;
    count: number;
    guidance: string | null;
    sources: string[];
    denylist: string[];
    /** Terms set in the DENYLIST variable; only their number is shown. */
    envDenylist?: number;
}

const lines = (text: string) =>
    text
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

export function IdeasSettings({ value, onChange }: { value: IdeaSettings; onChange: (v: IdeaSettings) => void }) {
    // The lists are edited as text; blank lines and all stay as typed until saved.
    const [sources, setSources] = useState(value.sources.join('\n'));
    const [terms, setTerms] = useState(value.denylist.join('\n'));
    const env = value.envDenylist ?? 0;
    return (
        <>
            <label class="check">
                <input type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.currentTarget.checked })} /> Suggest new ideas every day
            </label>
            <div class="grid2">
                <Field label="Time" hint="When the daily refresh runs. It skips days when nothing changed.">
                    <select value={String(value.hour)} onChange={e => onChange({ ...value, hour: Number(e.currentTarget.value) })}>
                        {Array.from({ length: 24 }, (_, h) => (
                            <option key={h} value={String(h)}>
                                {String(h).padStart(2, '0')}:00 UTC
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Ideas per day" hint="At most. Fewer when little changed.">
                    <input type="number" min={1} max={20} value={value.count} onInput={e => onChange({ ...value, count: Number(e.currentTarget.value) || value.count })} />
                </Field>
            </div>
            <Field label="Guidance" hint="What to pitch more or less of, e.g. more on what our benchmarks teach models, less on small interface changes.">
                <textarea rows={3} value={value.guidance ?? ''} onInput={e => onChange({ ...value, guidance: e.currentTarget.value || null })} />
            </Field>
            <Field label="Idea sources" hint="Public pages or feeds, one URL per line, read along with the knowledge sources above. What changes on them becomes ideas, and their text gives ideas background.">
                <textarea
                    rows={3}
                    value={sources}
                    spellcheck={false}
                    placeholder="https://example.com/product"
                    onInput={e => {
                        setSources(e.currentTarget.value);
                        onChange({ ...value, sources: lines(e.currentTarget.value) });
                    }}
                />
            </Field>
            <Field
                label="Never mention"
                hint={`Names ideas must not use, one per line: customers, partners, vendors. Source material that mentions one is skipped.${env ? ` ${env} more ${env === 1 ? 'comes' : 'come'} from the DENYLIST variable.` : ''}`}
            >
                <textarea
                    rows={3}
                    value={terms}
                    spellcheck={false}
                    onInput={e => {
                        setTerms(e.currentTarget.value);
                        onChange({ ...value, denylist: lines(e.currentTarget.value) });
                    }}
                />
            </Field>
        </>
    );
}
