import { useEffect, useState } from 'preact/hooks';
import { api, base, session, type Post } from '../api';
import { Button, Dialog, errorToast, toast } from '../ui';

interface Check {
    ok: boolean;
    label: string;
    hint?: string;
    /** A miss that should be fixed before publishing, not just improved. */
    error?: boolean;
}

/** What search engines and AI answer engines look for, checked against the post as it stands. */
export function seoChecks(post: { title: string; slug: string; metaTitle: string | null; metaDescription: string | null; customExcerpt: string | null; featureImage: string | null; featureImageAlt: string | null; tags: string[] }, html: string): Check[] {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
    const words = text ? text.split(' ').length : 0;
    const title = post.metaTitle || post.title;
    const description = post.metaDescription || post.customExcerpt || '';
    const images = [...doc.querySelectorAll('img')];
    const noAlt = images.filter(i => !(i.getAttribute('alt') ?? '').trim()).length;
    const levels = [...doc.querySelectorAll('h2, h3, h4')].map(h => Number(h.tagName[1]));
    const skips = levels.some((l, i) => l - (i ? levels[i - 1] : 2) > 1);
    const links = [...doc.querySelectorAll('a[href]')].map(a => a.getAttribute('href') ?? '');
    const internal = links.filter(h => h.startsWith(base) || (session.value?.site.url && h.startsWith(session.value.site.url))).length;
    const firstPara = (doc.querySelector('p')?.textContent ?? '').trim();
    return [
        { ok: title.length > 0 && title.length <= 60, label: 'Search title', hint: title.length > 60 ? `Search results cut titles after about 60 characters (this one is ${title.length}).` : title ? undefined : 'Add a title.' },
        {
            ok: description.length >= 50 && description.length <= 160,
            label: 'Description',
            hint: !description ? 'Add a search description or an excerpt: it is the snippet under the link, and what AI answers quote.' : description.length > 160 ? `Trim to 160 characters (now ${description.length}).` : description.length < 50 ? 'Say a little more: 50 to 160 characters.' : undefined
        },
        { ok: !!post.featureImage && !!post.featureImageAlt?.trim(), error: !!post.featureImage && !post.featureImageAlt?.trim(), label: 'Cover image', hint: !post.featureImage ? 'Posts with an image get more clicks when shared.' : !post.featureImageAlt?.trim() ? 'Describe the cover image (alt text).' : undefined },
        { ok: noAlt === 0, error: noAlt > 0, label: 'Image descriptions', hint: noAlt ? `${noAlt} of ${images.length} images have no alt text. Search engines and AI models can't see them. Click an image, then Alt.` : undefined },
        { ok: levels.includes(2) && !skips, label: 'Sections', hint: !levels.includes(2) ? 'Break the post into sections with headings: readers skim them and AI answers cite them.' : skips ? 'A heading skips a level (say, H2 then H4).' : undefined },
        { ok: internal > 0, label: 'Links to other posts', hint: internal ? undefined : 'Link to at least one related post.' },
        { ok: words >= 300, label: 'Length', hint: words < 300 ? `${words} words. Posts under 300 words rarely rank.` : undefined },
        { ok: post.tags.length > 0, label: 'Topic', hint: post.tags.length ? undefined : 'Add a tag so the post shows up in its topic.' },
        { ok: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug) && post.slug.length <= 60, label: 'Address', hint: post.slug.length > 60 ? 'Shorter addresses are easier to share.' : undefined },
        {
            ok: !!post.customExcerpt || (firstPara.split(' ').length >= 15 && firstPara.split(' ').length <= 70),
            label: 'Opens with the answer',
            hint: 'AI answer engines quote the first clear paragraph: open with one or two sentences that answer the post’s question.'
        }
    ];
}

/** Images without alt text are named when a post goes out, with a way to write them all. Publishing is still allowed. */
export function PublishAltNote({ post, describeAll }: { post: Post; describeAll: () => Promise<number> }) {
    const count = (html: string) => [...new DOMParser().parseFromString(html || '', 'text/html').querySelectorAll('img')].filter(i => !(i.getAttribute('alt') ?? '').trim()).length;
    const [missing, setMissing] = useState(() => count(post.html ?? ''));
    const [busy, setBusy] = useState(false);
    if (!missing) return null;
    const run = async () => {
        setBusy(true);
        try {
            const left = await describeAll();
            setMissing(left);
            if (left) toast(`${left} could not be described. Add their alt text by hand.`);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div class="note error">
            {missing === 1 ? 'One image has no alt text' : `${missing} images have no alt text`}: search engines and AI models read a post's images only through it.{' '}
            <button type="button" class="link-btn" disabled={busy} onClick={run}>
                {busy ? 'Describing…' : 'Describe with AI'}
            </button>
        </div>
    );
}

/** The checklist, and the card people will see when the post is shared. */
export function SearchPanel(props: { draft: { id?: string; title: string; slug: string; metaTitle: string | null; metaDescription: string | null; ogTitle?: string | null; ogDescription?: string | null; ogImage?: string | null; customExcerpt: string | null; featureImage: string | null; featureImageAlt: string | null; tags: string[] }; getHtml: () => string }) {
    const [, setTick] = useState(0);
    // The body lives in the editor: re-check every few seconds while this panel is open.
    useEffect(() => {
        const t = setInterval(() => setTick(n => n + 1), 3000);
        return () => clearInterval(t);
    }, []);
    const d = props.draft;
    const checks = seoChecks(d, props.getHtml());
    const passed = checks.filter(c => c.ok).length;
    const image = d.ogImage || d.featureImage;
    // Without an image the post is shared with a drawn card: show it, redrawn once the title settles.
    const [cardTitle, setCardTitle] = useState(d.ogTitle || d.title);
    useEffect(() => {
        const t = setTimeout(() => setCardTitle(d.ogTitle || d.title), 900);
        return () => clearTimeout(t);
    }, [d.ogTitle, d.title]);
    const host = (() => {
        try {
            return new URL(session.value?.site.url ?? location.href).host;
        } catch {
            return location.host;
        }
    })();
    return (
        <div class="panel-section">
            <div class="row between">
                <span class="field-label">Search and AI readiness</span>
                <span class={`pill ${passed === checks.length ? 'green' : passed >= checks.length - 2 ? 'amber' : ''}`}>
                    {passed}/{checks.length}
                </span>
            </div>
            <ul class="checks">
                {checks.map(c => (
                    <li key={c.label} class={c.ok ? 'ok' : c.error ? 'error' : 'todo'} title={c.hint}>
                        <span aria-hidden="true">{c.ok ? '✓' : c.error ? '!' : '•'}</span>
                        <span>
                            {c.label}
                            {!c.ok && c.hint ? <span class="check-hint">{c.hint}</span> : null}
                        </span>
                    </li>
                ))}
            </ul>
            <span class="field-label">When shared</span>
            <div class="share-card">
                {image ? (
                    <img src={image} alt="" />
                ) : d.id ? (
                    <img src={`${base}admin/api/posts/${d.id}/card?title=${encodeURIComponent(cardTitle)}`} alt="The share card drawn for this post" />
                ) : (
                    <div class="share-card-noimg">No image</div>
                )}
                <div class="share-card-text">
                    <span class="share-card-host">{host}</span>
                    <strong>{d.ogTitle || d.metaTitle || d.title || 'Untitled'}</strong>
                    <span>{(d.ogDescription || d.metaDescription || d.customExcerpt || '').slice(0, 160)}</span>
                </div>
            </div>
        </div>
    );
}

interface Revision {
    id: number;
    title: string;
    reason: string;
    savedBy: string | null;
    createdAt: string;
    words: number;
}

/** Earlier versions of the post: look at one, bring it back. */
export function HistoryPanel({ post, onRestored }: { post: Post; onRestored: (v: Pick<Post, 'title' | 'bodyFormat' | 'markdown' | 'html'>) => void }) {
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState<Revision[] | null>(null);
    const [viewing, setViewing] = useState<{ rev: Revision; html: string } | null>(null);
    useEffect(() => {
        if (open) api<Revision[]>(`/posts/${post.id}/revisions`).then(setItems, errorToast);
    }, [open, post.updatedAt]);
    return (
        <div class="panel-section">
            <button class="row between link-plain" onClick={() => setOpen(!open)} aria-expanded={open}>
                <span class="field-label">History</span>
                <span class="muted small">{open ? 'Hide' : 'Show'}</span>
            </button>
            {open ? (
                items === null ? (
                    <p class="muted small">Loading…</p>
                ) : items.length === 0 ? (
                    <p class="muted small">Earlier versions appear here as you edit and publish.</p>
                ) : (
                    <ul class="history">
                        {items.map(r => (
                            <li key={r.id}>
                                <button
                                    class="link-plain"
                                    onClick={async () => {
                                        try {
                                            const v = await api<{ rendered: string }>(`/posts/${post.id}/revisions/${r.id}`);
                                            setViewing({ rev: r, html: v.rendered });
                                        } catch (err) {
                                            errorToast(err);
                                        }
                                    }}
                                >
                                    <span>{new Date(r.createdAt).toLocaleString()}</span>
                                    <span class="muted small">
                                        {r.reason === 'published' ? 'Before publishing' : r.reason === 'restored' ? 'Before a restore' : 'Before edits'}
                                        {r.savedBy ? ` · ${r.savedBy}` : ''}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )
            ) : null}
            {viewing ? (
                <Dialog title={`${viewing.rev.title || 'Untitled'}, ${new Date(viewing.rev.createdAt).toLocaleString()}`} onClose={() => setViewing(null)} wide>
                    <div class="prose-preview revision-view" dangerouslySetInnerHTML={{ __html: viewing.html }} />
                    <div class="dialog-actions">
                        <Button onClick={() => setViewing(null)}>Close</Button>
                        <Button
                            tone="primary"
                            onClick={async () => {
                                try {
                                    const version = await api<Pick<Post, 'title' | 'bodyFormat' | 'markdown' | 'html'>>(`/posts/${post.id}/revisions/${viewing.rev.id}/restore`, { method: 'POST' });
                                    setViewing(null);
                                    onRestored(version);
                                    toast(post.status === 'published' ? 'Restored in the editor. Click Update to put it on the site.' : 'Restored');
                                } catch (err) {
                                    errorToast(err);
                                }
                            }}
                        >
                            Restore this version
                        </Button>
                    </div>
                </Dialog>
            ) : null}
        </div>
    );
}
