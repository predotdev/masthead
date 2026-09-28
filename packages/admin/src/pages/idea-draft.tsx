import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, type Post } from '../api';
import { CARET, Caret, Credits, StopButton, Working, splitDraft, useAiRun, withCaret } from '../streaming';
import { Button, Dialog, ErrorNote, errorToast, toast } from '../ui';

type Render = (markdown: string) => string;

/** The editor's Markdown rendering, which loads with the editor's code (already fetched in the background). */
function useRender(): Render | null {
    const [render, setRender] = useState<Render | null>(null);
    useEffect(() => {
        import('../editor/assist').then(m => setRender(() => m.renderMarkdown), () => {});
    }, []);
    return render;
}

interface Drafted {
    title: string;
    markdown: string;
    post: { id: string };
    finishReason?: string;
}

/**
 * Writes an idea's draft where you can watch it. The server saves it as a post when the model
 * finishes; a draft stopped part way is saved only if you keep it.
 */
export function IdeaDraft({ idea, onClose }: { idea: { id: string; title: string }; onClose: (changed: boolean) => void }) {
    const run = useAiRun<Drafted>();
    const render = useRender();
    const [saved, setSaved] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const writing = run.state === 'working';
    const write = () => run.start(`/ideas/${idea.id}/draft`, {});
    useEffect(write, []);
    useEffect(() => {
        if (run.state === 'done' && run.result?.post) {
            setSaved(run.result.post.id);
            toast('Draft saved');
        }
    }, [run.state]);

    const shown = splitDraft(run.text);
    const caretInBody = writing && shown.titleDone;
    const html = useMemo(() => (render && shown.body ? (caretInBody ? withCaret(render(shown.body + CARET)) : render(shown.body)) : ''), [render, shown.body, caretInBody]);

    const keep = async () => {
        const d = splitDraft(run.all());
        setSaving(true);
        try {
            const { post } = await api<{ post: Post }>(`/ideas/${idea.id}/draft`, { body: { title: d.title, markdown: d.body } });
            setSaved(post.id);
            toast('Draft saved');
        } catch (err) {
            errorToast(err);
        } finally {
            setSaving(false);
        }
    };

    const stage = run.stage === 'saving' ? 'Saving the draft' : run.stage === 'reading' || !run.stage ? "Reading the idea's sources" : run.text ? 'Writing the draft' : 'Thinking';
    return (
        <Dialog title={`Draft: ${idea.title}`} onClose={() => onClose(!!saved)} wide>
            <div class="ai-draft" aria-busy={writing}>
                {writing && !run.text ? <p class="muted small">The draft appears here as it is written, and is saved when it is done.</p> : null}
                {shown.title ? (
                    <h2 class="ai-draft-title">
                        {shown.title}
                        {writing && !shown.titleDone ? <Caret /> : null}
                    </h2>
                ) : null}
                {html ? (
                    <div class="prose-preview ai-draft-body" dangerouslySetInnerHTML={{ __html: html }} />
                ) : shown.body ? (
                    <div class="ai-draft-body ai-draft-plain">
                        {shown.body}
                        {caretInBody ? <Caret /> : null}
                    </div>
                ) : null}
                {run.state === 'error' ? <ErrorNote text={run.text ? `${run.error} Nothing was saved; you can keep what it wrote.` : run.error ?? ''} /> : null}
                {run.state === 'stopped' && !saved ? <p class="ai-note">{run.text ? 'Stopped. Nothing is saved yet: keep what it wrote as a draft, or try again.' : 'Stopped before it wrote anything.'}</p> : null}
                {run.result?.finishReason === 'length' ? <p class="ai-note">It reached the length limit, so the end may be missing.</p> : null}
                {run.sources.length ? (
                    <div class="ai-sources">
                        {run.sources.slice(0, 6).map(s => (
                            <a key={s.title} href={s.url ?? '#'} target="_blank" rel="noreferrer" title={s.title}>
                                {s.title.length > 40 ? `${s.title.slice(0, 38)}…` : s.title}
                            </a>
                        ))}
                    </div>
                ) : null}
            </div>
            <div class="dialog-actions">
                {writing ? (
                    <>
                        <Working label={stage} since={run.startedAt} />
                        <StopButton onClick={run.stop} />
                    </>
                ) : saved ? (
                    <>
                        <Credits usage={run.usage} />
                        <Button onClick={() => onClose(true)}>Back to ideas</Button>
                        <Button tone="primary" onClick={() => (location.hash = `#/edit/${saved}`)}>
                            Open the draft
                        </Button>
                    </>
                ) : (
                    <>
                        <Button onClick={() => onClose(false)}>Close</Button>
                        <Button onClick={write}>Try again</Button>
                        {run.all().trim() ? (
                            <Button tone="primary" busy={saving} onClick={keep}>
                                Keep as draft
                            </Button>
                        ) : null}
                    </>
                )}
            </div>
        </Dialog>
    );
}
