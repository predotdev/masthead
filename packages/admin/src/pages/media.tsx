import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { ModelPicker } from '../model-picker';
import { myModels, setMyModel, useModels, type ChoiceKind, type Model } from '../models';
import { Answered, StopButton, Working, useAiRun } from '../streaming';
import { Button, Dialog, ErrorNote, Field, errorToast } from '../ui';

/** The model a media dialog uses: this browser's choice (shared with the editor's AI panel), else the site default. */
function useChosen(kind: ChoiceKind): { value: string | null; chosen: Model | undefined; set: (id: string | null) => void } {
    const { models } = useModels(kind);
    const value = myModels.value[kind] ?? null;
    return { value, chosen: value ? models?.find(m => m.id === value) : models?.find(m => m.isDefault), set: id => setMyModel(kind, id) };
}

/** Starting points for the style field, which takes any style in words. Blank sends the description as written. */
const STYLES: { label: string; style: string }[] = [
    { label: 'As written', style: '' },
    { label: 'Photo', style: 'a natural, realistic photograph with soft light' },
    { label: 'Illustration', style: 'a modern editorial illustration' },
    { label: '3D render', style: 'a polished 3D render with soft studio lighting' },
    { label: 'Isometric', style: 'a detailed isometric illustration' },
    { label: 'Flat vector', style: 'a clean flat vector illustration with bold shapes' },
    { label: 'Line art', style: 'minimal black line art on white' },
    { label: 'Watercolor', style: 'a loose watercolor painting' },
    { label: 'Oil painting', style: 'an oil painting with visible brushwork' },
    { label: 'Pixel art', style: 'retro pixel art' },
    { label: 'Anime', style: 'anime, cel shaded' },
    { label: 'Claymation', style: 'a claymation scene with handmade textures' },
    { label: 'Retro poster', style: 'a screen-printed retro poster with limited colors and grain' },
    { label: 'Blueprint', style: 'a technical blueprint drawing, white lines on deep blue' },
    { label: 'Diagram', style: 'a clean, minimal technical diagram with simple shapes and arrows' },
    { label: 'Neon', style: 'glowing neon light on a dark background' },
    { label: 'Product shot', style: 'a crisp product render on a studio background with soft rim light' },
    { label: 'Night sky', style: 'black background with a soft grey glow and fine white star specks, minimal and cinematic' }
];

const RATIOS = ['16:9', '3:2', '1:1', '4:5', '9:16'];

/**
 * Generate an image, or change an existing one by describing the edit. An image arrives whole,
 * so the dialog shows where the work is (and a rough version, from models that send one) with a
 * running clock; Stop cancels it and everything stays editable meanwhile.
 */
export function ImageDialog({ mode, src, title, onClose, onDone }: { mode: 'insert' | 'cover' | 'edit'; src?: string; title: string; onClose: () => void; onDone: (url: string, alt: string) => void }) {
    const model = useChosen('image');
    const [prompt, setPrompt] = useState(mode === 'edit' ? '' : mode === 'cover' ? `Cover art for a post titled "${title}".` : '');
    const [style, setStyle] = useState('');
    const [ratio, setRatio] = useState('16:9');
    const [url, setUrl] = useState<string | null>(null);
    // The shapes the model takes, when the catalog says; an edit needs a model that takes an image.
    const takes = model.chosen?.supports?.aspectRatios;
    const ratios = takes?.length ? (RATIOS.some(r => takes.includes(r)) ? RATIOS.filter(r => takes.includes(r)) : takes.slice(0, 5)) : RATIOS;
    const cantEdit = mode === 'edit' && model.chosen?.supports?.references === false;
    useEffect(() => {
        if (!ratios.includes(ratio)) setRatio(ratios.includes('16:9') ? '16:9' : ratios[0]);
    }, [model.chosen?.id]);
    const job = useAiRun<{ url: string; model: string }>();
    const painting = job.state === 'working';
    useEffect(() => {
        if (job.state === 'done' && job.result?.url) setUrl(job.result.url);
    }, [job.state]);
    const run = () =>
        job.start('/ai/image', { prompt: style.trim() ? `${prompt.trim()}\n\nStyle: ${style.trim()}.` : prompt.trim(), aspectRatio: ratio, model: model.value ?? undefined, reference: mode === 'edit' ? url ?? src : undefined });
    const shown = url ?? src ?? null;
    return (
        <Dialog title={mode === 'edit' ? 'Edit image with AI' : mode === 'cover' ? 'Generate a cover' : 'Generate an image'} onClose={onClose} wide>
            <div class="media-grid">
                <div class="stack">
                    <Field label={mode === 'edit' ? 'Describe the change' : 'Describe the image'}>
                        <textarea
                            rows={4}
                            value={prompt}
                            autoFocus
                            placeholder={mode === 'edit' ? 'Make the background black and add a faint star field; keep the subject.' : 'A terminal window floating in space, one glowing cursor.'}
                            onInput={e => setPrompt(e.currentTarget.value)}
                        />
                    </Field>
                    <Field label="Style" hint="Any style, in your words. Blank: the description as written.">
                        <input value={style} placeholder="1970s sci-fi paperback cover, risograph print, Pixar-like 3D…" onInput={e => setStyle(e.currentTarget.value)} />
                    </Field>
                    <div class="chip-row">
                        {STYLES.map(s => (
                            <button key={s.label} type="button" class={`chip ${style === s.style ? 'on' : ''}`} onClick={() => setStyle(s.style)}>
                                {s.label}
                            </button>
                        ))}
                    </div>
                    <div class="media-options">
                        <Field label="Shape">
                            <select value={ratio} onChange={e => setRatio(e.currentTarget.value)}>
                                {ratios.map(r => (
                                    <option key={r}>{r}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Model">
                            <ModelPicker kind="image" allowDefault value={model.value} onChange={model.set} label="Image model" disabled={painting} />
                        </Field>
                    </div>
                    {cantEdit ? <p class="field-hint media-warn">This model makes new images but can't change one. Pick a model marked Edits images.</p> : null}
                </div>
                <div class="media-preview" aria-busy={painting}>
                    {painting ? (
                        <div class="media-working">
                            {job.preview ? (
                                <img src={job.preview} alt="" />
                            ) : shown ? (
                                <img class="media-dim" src={shown} alt="" />
                            ) : (
                                <div class="media-canvas ai-shimmer" style={{ aspectRatio: ratio.replace(':', ' / ') }} />
                            )}
                            <div class="media-status">
                                <Working label={job.stage === 'reading' ? 'Reading the image' : job.stage === 'saving' ? 'Saving' : 'Painting'} since={job.startedAt} />
                            </div>
                        </div>
                    ) : shown ? (
                        <img src={shown} alt="" />
                    ) : (
                        <div class="media-empty">Your image appears here</div>
                    )}
                </div>
            </div>
            {job.state === 'error' ? <ErrorNote text={job.error ?? ''} /> : null}
            {job.state === 'stopped' ? <p class="ai-note">Stopped. Nothing was saved.</p> : null}
            <div class="dialog-actions">
                {job.state === 'done' ? <Answered run={job} /> : null}
                <Button onClick={onClose}>Cancel</Button>
                {painting ? (
                    <StopButton onClick={job.stop} />
                ) : (
                    <Button disabled={!prompt.trim() || cantEdit} onClick={run}>
                        {url ? (mode === 'edit' ? 'Edit again' : 'Try again') : mode === 'edit' ? 'Apply edit' : 'Generate'}
                    </Button>
                )}
                {url && !painting ? (
                    <Button tone="primary" onClick={() => onDone(url, prompt.trim().slice(0, 120))}>
                        {mode === 'edit' ? 'Use the edited image' : 'Use this image'}
                    </Button>
                ) : null}
            </div>
        </Dialog>
    );
}

/** Generate a short video clip, optionally animating an image. */
export function VideoDialog({ reference, onClose, onDone }: { reference?: string | null; onClose: () => void; onDone: (url: string) => void }) {
    const model = useChosen('video');
    const [prompt, setPrompt] = useState('');
    const [ratio, setRatio] = useState('16:9');
    const [duration, setDuration] = useState(6);
    const [useRef_, setUseRef] = useState(false);
    const [job, setJob] = useState<{ id: string; status: string; url?: string; error?: string } | null>(null);
    const [started, setStarted] = useState(0);
    const [starting, setStarting] = useState(false);
    const timer = useRef<number | null>(null);
    const open = useRef(true);

    useEffect(
        () => () => {
            open.current = false;
            if (timer.current) clearInterval(timer.current);
        },
        []
    );
    const chosen = model.chosen;
    const durations = chosen?.supports?.durations ?? [4, 6, 8, 10];
    const ratios = chosen?.supports?.aspectRatios?.filter(r => ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(r)) ?? ['16:9', '9:16', '1:1'];
    const canAnimate = !chosen?.supports || !!chosen.supports.frameImages?.includes('first_frame');
    // Keep the length and shape valid for the chosen model.
    useEffect(() => {
        if (!durations.includes(duration)) setDuration(durations.find(d => d >= 6) ?? durations[durations.length - 1]);
        if (!ratios.includes(ratio)) setRatio(ratios[0]);
    }, [chosen?.id]);
    const perSecond = chosen?.price?.credits_per_second_output;
    const estimate = perSecond ? Math.round(perSecond * duration * 10) / 10 : null;

    const start = async () => {
        setStarting(true);
        setStarted(Date.now());
        try {
            const res = await api<{ id: string; status: string }>('/ai/video', { body: { prompt, model: model.value ?? undefined, aspectRatio: ratio, duration, reference: useRef_ && canAnimate ? reference : undefined } });
            // Closed while the job was being submitted: nothing is left to show it.
            if (!open.current) return;
            setJob(res);
            // A failed check is retried; five in a row end the wait with the reason.
            let failures = 0;
            timer.current = window.setInterval(async () => {
                try {
                    const s = await api<{ id: string; status: string; url?: string; error?: string }>(`/ai/video/${res.id}`);
                    failures = 0;
                    setJob(s);
                    if (s.status === 'completed' || s.status === 'failed') clearInterval(timer.current!);
                } catch (err: any) {
                    if (++failures < 5) return;
                    clearInterval(timer.current!);
                    setJob(j => (j ? { ...j, status: 'failed', error: err?.message } : j));
                }
            }, 4000);
        } catch (err) {
            errorToast(err);
        } finally {
            setStarting(false);
        }
    };
    // A video can't be cancelled once it starts: closing only stops the wait, so it asks first.
    const rendering = starting || (!!job && !job.url && job.status !== 'failed');
    const close = () => {
        if (rendering && !window.confirm("Stop waiting for this video? It keeps rendering and is still charged, but it won't be added to the post.")) return;
        onClose();
    };
    const animating = useRef_ && canAnimate && !!reference;
    return (
        <Dialog title="Generate a video" onClose={close} wide>
            <div class="media-grid">
                <div class="stack">
                    <Field label="Describe the clip">
                        <textarea rows={4} value={prompt} autoFocus disabled={!!job || starting} placeholder="Slow push-in on a glowing terminal floating in a field of stars." onInput={e => setPrompt(e.currentTarget.value)} />
                    </Field>
                    <div class="grid2">
                        <Field label="Model">
                            <ModelPicker kind="video" allowDefault value={model.value} onChange={model.set} label="Video model" disabled={!!job || starting} />
                        </Field>
                        <Field label="Shape and length" hint={estimate ? `About ${estimate} credits` : undefined}>
                            <div class="row">
                                <select value={ratio} disabled={!!job || starting} onChange={e => setRatio(e.currentTarget.value)}>
                                    {ratios.map(r => (
                                        <option key={r}>{r}</option>
                                    ))}
                                </select>
                                <select value={duration} disabled={!!job || starting} onChange={e => setDuration(Number(e.currentTarget.value))}>
                                    {durations.map(d => (
                                        <option key={d} value={d}>
                                            {d} s
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </Field>
                    </div>
                    {reference && canAnimate ? (
                        <label class="check">
                            <input type="checkbox" checked={useRef_} disabled={!!job || starting} onChange={e => setUseRef(e.currentTarget.checked)} /> Animate the post's cover image
                        </label>
                    ) : null}
                </div>
                <div class="media-preview" aria-busy={rendering}>
                    {job?.url ? (
                        <video src={job.url} controls autoPlay muted loop playsInline />
                    ) : rendering ? (
                        <div class="media-working">
                            {/* Animating the cover: the clip starts from it, so it stands in until the video exists. */}
                            {animating ? <img class="media-dim" src={reference!} alt="" /> : <div class="media-canvas ai-shimmer" style={{ aspectRatio: ratio.replace(':', ' / ') }} />}
                            <div class="media-status">
                                <Working label={starting ? 'Starting' : job?.status === 'queued' ? 'Waiting to start' : 'Rendering'} since={started} />
                            </div>
                        </div>
                    ) : job?.status === 'failed' ? (
                        <div class="media-empty">It failed: {job.error ?? 'no reason given'}</div>
                    ) : (
                        <div class="media-empty">Videos take a minute or two to render.</div>
                    )}
                </div>
            </div>
            <div class="dialog-actions">
                <Button onClick={close}>{job?.url ? 'Close' : rendering ? 'Stop waiting' : 'Cancel'}</Button>
                {!rendering && (!job || job.status === 'failed') ? (
                    <Button tone={job ? undefined : 'primary'} disabled={!prompt.trim()} onClick={() => (setJob(null), start())}>
                        {job ? 'Try again' : 'Generate'}
                    </Button>
                ) : null}
                {job?.url ? (
                    <Button tone="primary" onClick={() => onDone(job.url!)}>
                        Insert the video
                    </Button>
                ) : null}
            </div>
        </Dialog>
    );
}

interface Unfurled {
    type: 'embed' | 'bookmark';
    url: string;
    provider?: string;
    html?: string;
    title?: string;
    description?: string;
    image?: string | null;
    icon?: string | null;
    publisher?: string | null;
}

/** Paste a link: videos and posts embed; anything else becomes a card with its title and image. */
export function EmbedDialog({ onClose, onDone }: { onClose: () => void; onDone: (node: { type: string; attrs: Record<string, unknown> }) => void }) {
    const [url, setUrl] = useState('');
    const [data, setData] = useState<Unfurled | null>(null);
    const [busy, setBusy] = useState(false);
    const look = async () => {
        setBusy(true);
        try {
            setData(await api<Unfurled>(`/unfurl?url=${encodeURIComponent(url.trim())}`));
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog title="Embed a link" onClose={onClose} wide>
            <form
                class="row"
                onSubmit={e => {
                    e.preventDefault();
                    if (url.trim()) look();
                }}
            >
                <input value={url} autoFocus placeholder="https://youtube.com/…, https://x.com/…, or any page" onInput={e => setUrl(e.currentTarget.value)} />
                <Button type="submit" busy={busy}>
                    Preview
                </Button>
            </form>
            {data ? (
                <div class="embed-preview">
                    {data.type === 'embed' ? (
                        <div class="embed-view" dangerouslySetInnerHTML={{ __html: data.html ?? '' }} />
                    ) : (
                        <div class="kg-bookmark-card">
                            <a class="kg-bookmark-container" href={data.url} target="_blank" rel="noreferrer">
                                <div class="kg-bookmark-content">
                                    <div class="kg-bookmark-title">{data.title}</div>
                                    <div class="kg-bookmark-description">{data.description}</div>
                                    <div class="kg-bookmark-metadata">
                                        {data.icon ? <img class="kg-bookmark-icon" src={data.icon} alt="" /> : null}
                                        <span>{data.publisher}</span>
                                    </div>
                                </div>
                                {data.image ? (
                                    <div class="kg-bookmark-thumbnail">
                                        <img src={data.image} alt="" />
                                    </div>
                                ) : null}
                            </a>
                        </div>
                    )}
                </div>
            ) : null}
            <div class="dialog-actions">
                <Button onClick={onClose}>Cancel</Button>
                {data ? (
                    <Button
                        tone="primary"
                        onClick={() =>
                            onDone(
                                data.type === 'embed'
                                    ? { type: 'embed', attrs: { html: data.html, url: data.url, provider: data.provider } }
                                    : { type: 'bookmark', attrs: { url: data.url, title: data.title, description: data.description, image: data.image, icon: data.icon, publisher: data.publisher } }
                            )
                        }
                    >
                        Insert {data.type === 'embed' ? data.provider : 'link card'}
                    </Button>
                ) : null}
            </div>
        </Dialog>
    );
}

export function HtmlDialog({ html, onClose, onDone }: { html: string; onClose: () => void; onDone: (html: string) => void }) {
    const [value, setValue] = useState(html);
    return (
        <Dialog title="Edit HTML" onClose={onClose} wide>
            <textarea class="code-input" rows={16} value={value} spellcheck={false} onInput={e => setValue(e.currentTarget.value)} />
            <div class="dialog-actions">
                <Button onClick={onClose}>Cancel</Button>
                <Button tone="primary" onClick={() => onDone(value)}>
                    Save
                </Button>
            </div>
        </Dialog>
    );
}
