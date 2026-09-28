import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { Button, Dialog, Field, errorToast } from '../ui';

interface ModelRow {
    id: string;
    name: string;
    price?: Record<string, number>;
    supports?: { durations?: number[]; aspectRatios?: string[]; resolutions?: string[]; frameImages?: string[] };
    isDefault?: boolean;
}

function useModels(kind: 'image' | 'video') {
    const [models, setModels] = useState<ModelRow[]>([]);
    useEffect(() => {
        api<ModelRow[]>(`/ai/models?kind=${kind}`).then(setModels, () => setModels([]));
    }, [kind]);
    return models;
}

const STYLES: { id: string; label: string; suffix: string }[] = [
    { id: 'sky', label: 'Night sky', suffix: 'Black background with a soft grey glow and fine white star specks, minimal and cinematic, one clear subject, lots of empty space, no text or letters.' },
    { id: 'diagram', label: 'Diagram', suffix: 'A clean, minimal technical diagram: thin white lines and simple shapes on a black background, no text or letters.' },
    { id: 'product', label: 'Product shot', suffix: 'A crisp product-style render on a dark studio background with soft rim light, no text or letters.' },
    { id: 'photo', label: 'Photo', suffix: 'A natural, realistic photograph with soft light and shallow depth of field.' },
    { id: 'none', label: 'As written', suffix: '' }
];

const RATIOS = ['16:9', '3:2', '1:1', '4:5', '9:16'];

/** Generate an image, or change an existing one by describing the edit. */
export function ImageDialog({ mode, src, title, onClose, onDone }: { mode: 'insert' | 'cover' | 'edit'; src?: string; title: string; onClose: () => void; onDone: (url: string, alt: string) => void }) {
    const models = useModels('image');
    const [prompt, setPrompt] = useState(mode === 'edit' ? '' : mode === 'cover' ? `Cover art for a post titled "${title}".` : '');
    const [style, setStyle] = useState(mode === 'edit' ? 'none' : 'sky');
    const [ratio, setRatio] = useState('16:9');
    const [model, setModel] = useState('');
    const [url, setUrl] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const suffix = STYLES.find(s => s.id === style)?.suffix ?? '';
    const run = async () => {
        setBusy(true);
        try {
            const res = await api<{ url: string; model: string }>('/ai/image', {
                body: { prompt: `${prompt.trim()} ${suffix}`.trim(), aspectRatio: ratio, model: model || undefined, reference: mode === 'edit' ? url ?? src : undefined }
            });
            setUrl(res.url);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };
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
                    <div class="chip-row">
                        {STYLES.map(s => (
                            <button key={s.id} type="button" class={`chip ${style === s.id ? 'on' : ''}`} onClick={() => setStyle(s.id)}>
                                {s.label}
                            </button>
                        ))}
                    </div>
                    <div class="grid2">
                        <Field label="Shape">
                            <select value={ratio} onChange={e => setRatio(e.currentTarget.value)}>
                                {RATIOS.map(r => (
                                    <option key={r}>{r}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Model" hint="Blank: the default from Settings.">
                            <input list="image-models" value={model} onInput={e => setModel(e.currentTarget.value)} placeholder={models.find(m => m.isDefault)?.name ?? 'default'} />
                            <datalist id="image-models">
                                {models.map(m => (
                                    <option key={m.id} value={m.id}>
                                        {m.name}
                                    </option>
                                ))}
                            </datalist>
                        </Field>
                    </div>
                </div>
                <div class="media-preview">{url || src ? <img src={url ?? src} alt="" /> : <div class="media-empty">{busy ? 'Painting…' : 'Your image appears here'}</div>}</div>
            </div>
            <div class="dialog-actions">
                <Button onClick={onClose}>Cancel</Button>
                <Button busy={busy} disabled={!prompt.trim()} onClick={run}>
                    {url ? (mode === 'edit' ? 'Edit again' : 'Try again') : mode === 'edit' ? 'Apply edit' : 'Generate'}
                </Button>
                {url ? (
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
    const models = useModels('video');
    const [prompt, setPrompt] = useState('');
    const [model, setModel] = useState('');
    const [ratio, setRatio] = useState('16:9');
    const [duration, setDuration] = useState(6);
    const [useRef_, setUseRef] = useState(false);
    const [job, setJob] = useState<{ id: string; status: string; url?: string; error?: string } | null>(null);
    const [started, setStarted] = useState(0);
    const [tick, setTick] = useState(0);
    const timer = useRef<number | null>(null);

    useEffect(() => () => (timer.current ? clearInterval(timer.current) : undefined), []);
    const chosen = models.find(m => m.id === model) ?? (model ? undefined : models.find(m => m.isDefault));
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
        try {
            const res = await api<{ id: string; status: string }>('/ai/video', { body: { prompt, model: model || undefined, aspectRatio: ratio, duration, reference: useRef_ && canAnimate ? reference : undefined } });
            setJob(res);
            setStarted(Date.now());
            // A failed check is retried; five in a row end the wait with the reason.
            let failures = 0;
            timer.current = window.setInterval(async () => {
                setTick(t => t + 1);
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
        }
    };
    const seconds = job ? Math.round((Date.now() - started) / 1000) : 0;
    return (
        <Dialog title="Generate a video" onClose={onClose} wide>
            <div class="media-grid">
                <div class="stack">
                    <Field label="Describe the clip">
                        <textarea rows={4} value={prompt} autoFocus disabled={!!job} placeholder="Slow push-in on a glowing terminal floating in a field of stars." onInput={e => setPrompt(e.currentTarget.value)} />
                    </Field>
                    <div class="grid2">
                        <Field label="Model" hint="Blank: the default from Settings.">
                            <input list="video-models" value={model} disabled={!!job} onInput={e => setModel(e.currentTarget.value)} placeholder={models.find(m => m.isDefault)?.name ?? 'default'} />
                            <datalist id="video-models">
                                {models.map(m => (
                                    <option key={m.id} value={m.id}>
                                        {m.name}
                                    </option>
                                ))}
                            </datalist>
                        </Field>
                        <Field label="Shape and length" hint={estimate ? `About ${estimate} credits` : undefined}>
                            <div class="row">
                                <select value={ratio} disabled={!!job} onChange={e => setRatio(e.currentTarget.value)}>
                                    {ratios.map(r => (
                                        <option key={r}>{r}</option>
                                    ))}
                                </select>
                                <select value={duration} disabled={!!job} onChange={e => setDuration(Number(e.currentTarget.value))}>
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
                            <input type="checkbox" checked={useRef_} disabled={!!job} onChange={e => setUseRef(e.currentTarget.checked)} /> Animate the post's cover image
                        </label>
                    ) : null}
                </div>
                <div class="media-preview">
                    {job?.url ? (
                        <video src={job.url} controls autoPlay muted loop playsInline />
                    ) : job ? (
                        <div class="media-empty">
                            {job.status === 'failed' ? `It failed: ${job.error ?? 'no reason given'}` : `Rendering… ${seconds}s`}
                            <span class="tick" data-tick={tick} />
                        </div>
                    ) : (
                        <div class="media-empty">Videos take a minute or two to render.</div>
                    )}
                </div>
            </div>
            <div class="dialog-actions">
                <Button onClick={onClose}>{job?.url ? 'Close' : 'Cancel'}</Button>
                {!job || job.status === 'failed' ? (
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
