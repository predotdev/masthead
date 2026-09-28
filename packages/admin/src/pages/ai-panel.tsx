import { useState } from 'preact/hooks';
import { api, session } from '../api';
import { ModelPicker } from '../model-picker';
import { modelLabel, modelName, myModels, reloadModels, setMyModel, useModels, type ChoiceKind } from '../models';
import { Button, Skeleton, errorToast, toast, useLoad } from '../ui';
import { MemoryPanel } from './memory';

/** GET /ai/settings: the site's AI settings as every writer may see them. */
interface SiteAi {
    textModel: string | null;
    imageModel: string | null;
    videoModel: string | null;
    voice: string | null;
    knowledgeSources: string[];
    knowledge: { passages: number; pending: number; sources: number; refreshedAt: string | null };
}

type Save = (patch: Partial<Omit<SiteAi, 'knowledge'>>, done: string) => Promise<void>;

const CHOICES: { kind: ChoiceKind; label: string; setting: 'textModel' | 'imageModel' | 'videoModel' }[] = [
    { kind: 'text', label: 'Writing', setting: 'textModel' },
    { kind: 'image', label: 'Images', setting: 'imageModel' },
    { kind: 'video', label: 'Video', setting: 'videoModel' }
];

/** The editor bar's way in. It names the model that writes, so which one answers is never a surprise. */
export function AiPanelButton({ open, onClick }: { open: boolean; onClick: () => void }) {
    const { models } = useModels('text');
    const mine = myModels.value.text;
    const writing = models?.find(m => m.id === mine) ?? models?.find(m => m.isDefault);
    return (
        <Button icon="sliders" class="ai-panel-btn" aria-pressed={open} aria-label={writing ? `AI settings, writing with ${modelName(writing)}` : 'AI settings'} title="Models, house style, memory and knowledge" onClick={onClick}>
            AI
            {writing ? <span class="ai-panel-model">{modelName(writing)}</span> : null}
        </Button>
    );
}

/**
 * The AI beside the post: the models this browser writes with, the house style, the team's
 * memory and the knowledge sources. Admins and owners change the site's side of it here too.
 * Everything loads on its own, so nothing here holds up writing.
 */
export function AiPanel() {
    const role = session.value?.user.role;
    const admin = role === 'owner' || role === 'admin';
    const { data, error, setData } = useLoad(() => api<SiteAi>('/ai/settings'), []);
    const save: Save = async (patch, done) => {
        setData(await api<SiteAi>('/ai/settings', { method: 'PUT', body: patch }));
        toast(done);
    };
    return (
        <aside class="settings-panel ai-panel" aria-label="AI settings">
            <section class="ai-section">
                <div class="ai-section-head">
                    <h3>Models</h3>
                    <span class="muted small">Saved in this browser</span>
                </div>
                {CHOICES.map(c => (
                    <ModelChoice key={c.kind} kind={c.kind} label={c.label} site={data ? data[c.setting] : undefined} setting={c.setting} admin={admin} save={save} />
                ))}
            </section>
            {error ? <p class="note error ai-panel-error">{error}</p> : null}
            <HouseStyle voice={data ? (data.voice ?? '') : null} admin={admin} save={save} />
            <section class="ai-section">
                <div class="ai-section-head">
                    <h3>Memory</h3>
                </div>
                <MemoryPanel knowledge={false} />
            </section>
            <Knowledge data={data} admin={admin} save={save} />
        </aside>
    );
}

/** One kind's model for this browser. `site` is the site's default, undefined until it has loaded. */
function ModelChoice({ kind, label, site, setting, admin, save }: { kind: ChoiceKind; label: string; site: string | null | undefined; setting: 'textModel' | 'imageModel' | 'videoModel'; admin: boolean; save: Save }) {
    const mine = myModels.value[kind] ?? null;
    const { models } = useModels(kind);
    const [busy, setBusy] = useState(false);
    const gone = !!mine && !!models && !models.some(m => m.id === mine);
    const makeDefault = async () => {
        if (!mine) return;
        setBusy(true);
        try {
            await save({ [setting]: mine }, `${modelLabel(mine)} is now the default for everyone`);
            // It is the default now, so this browser follows the site again.
            setMyModel(kind, null);
            reloadModels();
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div class="field">
            <span class="field-label">{label}</span>
            <ModelPicker kind={kind} value={mine} allowDefault label={`${label} model`} onChange={id => setMyModel(kind, id)} />
            {gone ? <span class="field-hint">That model is not offered any more, so the site default answers instead.</span> : null}
            {admin && mine && !gone && site !== undefined && mine !== site ? (
                <button type="button" class="link-btn small ai-make-default" disabled={busy} onClick={makeDefault}>
                    {busy ? 'Saving…' : 'Make default for everyone'}
                </button>
            ) : null}
        </div>
    );
}

function HouseStyle({ voice, admin, save }: { voice: string | null; admin: boolean; save: Save }) {
    const [draft, setDraft] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const long = !!voice && (voice.length > 260 || voice.split('\n').length > 4);
    const submit = async (e: Event) => {
        e.preventDefault();
        setBusy(true);
        try {
            await save({ voice: draft?.trim() ? draft : null }, 'House style saved');
            setDraft(null);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };
    return (
        <section class="ai-section">
            <div class="ai-section-head">
                <h3>House style</h3>
                {admin && voice !== null && draft === null ? (
                    <button type="button" class="link-btn small" onClick={() => setDraft(voice)}>
                        {voice ? 'Edit' : 'Add'}
                    </button>
                ) : null}
            </div>
            {voice === null ? (
                <Skeleton height={9} width="80%" />
            ) : draft !== null ? (
                <form class="stack-sm" onSubmit={submit}>
                    <textarea rows={10} value={draft} autoFocus placeholder="Tone, audience and rules every draft follows, e.g. words to avoid or names never to mention." onInput={e => setDraft(e.currentTarget.value)} />
                    <div class="row">
                        <Button tone="primary" size="sm" type="submit" busy={busy}>
                            Save
                        </Button>
                        <Button size="sm" onClick={() => setDraft(null)}>
                            Cancel
                        </Button>
                        <span class="muted small">Applies to everyone.</span>
                    </div>
                </form>
            ) : voice ? (
                <>
                    <div class={`ai-style${open || !long ? ' open' : ''}`}>{voice}</div>
                    {long ? (
                        <button type="button" class="link-btn small ai-more" aria-expanded={open} onClick={() => setOpen(!open)}>
                            {open ? 'Show less' : 'Show all'}
                        </button>
                    ) : null}
                </>
            ) : (
                <p class="muted small">No house style yet.</p>
            )}
            {!admin && voice !== null ? <p class="field-hint">Every draft follows it. Admins can change it.</p> : null}
        </section>
    );
}

function Knowledge({ data, admin, save }: { data: SiteAi | null; admin: boolean; save: Save }) {
    const [url, setUrl] = useState('');
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const sources = data?.knowledgeSources ?? [];
    const k = data?.knowledge;
    const add = async (e: Event) => {
        e.preventDefault();
        const u = url.trim();
        if (!/^https?:\/\/\S+$/.test(u)) return toast('Paste a full address, starting with https://', 'error');
        if (sources.includes(u)) return toast('That source is already on the list', 'error');
        setBusy(true);
        try {
            await save({ knowledgeSources: [...sources, u] }, 'Added. It is being read now.');
            setUrl('');
            setOpen(true);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };
    return (
        <section class="ai-section">
            <div class="ai-section-head">
                <h3>Knowledge</h3>
                {admin ? (
                    <a class="link-btn small" href="#/settings/ai">
                        Edit in Settings
                    </a>
                ) : null}
            </div>
            {k ? (
                <p class="muted small">
                    {sources.length} {sources.length === 1 ? 'source' : 'sources'} and every published post: {k.passages.toLocaleString()} passages{k.pending ? `, ${k.pending.toLocaleString()} still being read` : ''}.
                </p>
            ) : (
                <Skeleton height={9} width="70%" />
            )}
            {sources.length ? (
                <>
                    <button type="button" class="link-btn small ai-more" aria-expanded={open} onClick={() => setOpen(!open)}>
                        {open ? 'Hide the sources' : 'Show the sources'}
                    </button>
                    {open ? (
                        <ul class="ai-source-list">
                            {sources.map(s => (
                                <li key={s}>
                                    <a href={s} target="_blank" rel="noreferrer" title={s}>
                                        {s.replace(/^https?:\/\/(www\.)?/, '')}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </>
            ) : null}
            {admin ? (
                <form class="row ai-add-source" onSubmit={add}>
                    <input type="url" value={url} placeholder="https://example.com/llms.txt" aria-label="Source address" onInput={e => setUrl(e.currentTarget.value)} />
                    <Button type="submit" size="sm" busy={busy} disabled={!url.trim()}>
                        Add
                    </Button>
                </form>
            ) : (
                <p class="field-hint">Docs, an llms.txt or a changelog the AI reads. Admins add them in Settings.</p>
            )}
        </section>
    );
}
