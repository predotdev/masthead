import { useState } from 'preact/hooks';
import { api, session, upload } from '../api';
import { Icon } from '../icons';
import { modelFor } from '../models';
import { Caret, useAiRun } from '../streaming';
import { Button, ErrorNote, Field, errorToast } from '../ui';
import { SerpPreview, suggestions } from './analytics-search';

/** The search and share fields a topic or an author's page carries; the same ones a post has. */
export interface SeoValue {
    metaTitle?: string | null;
    metaDescription?: string | null;
    ogTitle?: string | null;
    ogDescription?: string | null;
    ogImage?: string | null;
    twitterTitle?: string | null;
    twitterDescription?: string | null;
    twitterImage?: string | null;
    canonicalUrl?: string | null;
    noindex?: boolean;
    featureImage?: string | null;
    featureImageAlt?: string | null;
}

interface Props {
    /** A topic has a cover image and Twitter card text; an author's page has the short form. */
    kind: 'topic' | 'author';
    /** The id the AI reads the page's posts by. Absent until the page is saved. */
    id?: string;
    /** The page's name: its title unless a search title is set. */
    name: string;
    /** The page's address, for the preview (built from the slug). */
    address: string;
    /** The description shown to readers, used in search unless a search description is set. */
    description?: string | null;
    value: SeoValue;
    onChange: (patch: Partial<SeoValue>) => void;
}

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 155;

/** Image upload with a preview and a remove button. */
function ImageField({ label, hint, value, onChange }: { label: string; hint?: string; value?: string | null; onChange: (url: string | null) => void }) {
    return (
        <Field label={label} hint={hint}>
            <div class="row seo-image">
                {value ? <img src={value} alt="" class="seo-thumb" /> : null}
                <label class="btn ghost">
                    {value ? 'Replace' : 'Upload'}
                    <input
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={async e => {
                            const f = e.currentTarget.files?.[0];
                            if (f) onChange(await upload(f).catch(err => (errorToast(err), null)));
                            e.currentTarget.value = '';
                        }}
                    />
                </label>
                {value ? (
                    <Button tone="plain" onClick={() => onChange(null)}>
                        Remove
                    </Button>
                ) : null}
            </div>
        </Field>
    );
}

/** Search title and description with a live result preview, hints, AI suggestions, and the share, canonical and noindex settings. */
export function SeoFields({ kind, id, name, address, description, value: v, onChange }: Props) {
    const run = useAiRun<{ titles: string[]; descriptions: string[] }>();
    const [asked, setAsked] = useState(false);
    const writing = run.state === 'working';
    const items = suggestions(run.text, !writing);
    const title = (v.metaTitle ?? '').trim();
    const desc = (v.metaDescription ?? '').trim();
    const shownTitle = title || `${name || 'Untitled'} - ${session.value?.site.title ?? ''}`;
    const shownDesc = desc || (description ?? '').trim();
    const ask = () => {
        setAsked(true);
        run.start('/ai/meta', { [kind === 'topic' ? 'tagId' : 'authorId']: id, model: modelFor('text') });
    };
    const pick = (k: 'title' | 'description', text: string) => onChange(k === 'title' ? { metaTitle: text } : { metaDescription: text });
    const inUse = (k: 'title' | 'description', text: string) => (k === 'title' ? title : desc) === text.trim();
    return (
        <div class="seo-fields stack">
            <span class="field-label">In Google</span>
            <SerpPreview url={address} title={shownTitle} description={shownDesc || null} small />
            <Field label="Search title" hint={title ? `${title.length}/${TITLE_MAX}` : `Blank uses "${shownTitle}"`}>
                <input value={v.metaTitle ?? ''} placeholder={shownTitle} onInput={e => onChange({ metaTitle: e.currentTarget.value || null })} />
            </Field>
            {title.length > TITLE_MAX ? <p class="seo-hint warn">Google cuts titles near {TITLE_MAX} characters, so the end may not show.</p> : null}
            <Field label="Search description" hint={`${desc.length}/${DESCRIPTION_MAX}`}>
                <textarea rows={3} value={v.metaDescription ?? ''} placeholder={description ?? ''} onInput={e => onChange({ metaDescription: e.currentTarget.value || null })} />
            </Field>
            {!shownDesc ? <p class="seo-hint warn">No description yet, so Google picks a passage from the page. A sentence on what this {kind === 'topic' ? 'topic' : 'author'} covers is better.</p> : null}
            {desc.length > DESCRIPTION_MAX ? <p class="seo-hint warn">Google cuts descriptions near 160 characters.</p> : null}
            {id ? (
                <div class="seo-ai" aria-busy={writing}>
                    <div class="row between">
                        <span class="field-label">
                            <Icon name="sparkles" size={13} /> Write with AI
                        </span>
                        <Button size="sm" busy={writing} onClick={ask}>
                            {asked ? 'Suggest again' : 'Generate with AI'}
                        </Button>
                    </div>
                    {!asked ? <p class="muted small">Written from the posts on this page.</p> : null}
                    {(['title', 'description'] as const).map(k =>
                        items.some(i => i.kind === k) ? (
                            <div key={k} class="sc-options">
                                <p class="sc-options-head">{k === 'title' ? 'Titles' : 'Descriptions'}</p>
                                {items
                                    .filter(i => i.kind === k)
                                    .map((item, n) => (
                                        <div class={`sc-option ${item.done && inUse(k, item.text) ? 'used' : ''}`} key={n}>
                                            <span class="sc-option-text">
                                                {item.text}
                                                {item.done ? null : <Caret />}
                                            </span>
                                            {item.done ? (
                                                <span class="sc-option-side">
                                                    <span class={`sc-count ${item.text.length > (k === 'title' ? TITLE_MAX : DESCRIPTION_MAX) ? 'over' : ''}`}>{item.text.length}</span>
                                                    {inUse(k, item.text) ? (
                                                        <span class="sc-used">
                                                            <Icon name="check" size={13} /> In use
                                                        </span>
                                                    ) : (
                                                        <Button size="sm" onClick={() => pick(k, item.text)}>
                                                            Use
                                                        </Button>
                                                    )}
                                                </span>
                                            ) : null}
                                        </div>
                                    ))}
                            </div>
                        ) : null
                    )}
                    {run.state === 'error' ? <ErrorNote text={run.error ?? ''} /> : null}
                </div>
            ) : (
                <p class="muted small">Save first, then the AI can write these from the posts on the page.</p>
            )}
            <details class="seo-more">
                <summary>Sharing, canonical address and indexing</summary>
                <div class="stack">
                    {kind === 'topic' ? (
                        <>
                            <ImageField label="Cover image" hint="Shown when the topic is shared, unless a share image is set below." value={v.featureImage} onChange={url => onChange({ featureImage: url })} />
                            {v.featureImage ? (
                                <Field label="Cover image description" hint="Alt text for screen readers and search.">
                                    <input value={v.featureImageAlt ?? ''} onInput={e => onChange({ featureImageAlt: e.currentTarget.value || null })} />
                                </Field>
                            ) : null}
                        </>
                    ) : null}
                    <Field label="Share title" hint="On Facebook, LinkedIn, Slack. Blank uses the search title.">
                        <input value={v.ogTitle ?? ''} onInput={e => onChange({ ogTitle: e.currentTarget.value || null })} />
                    </Field>
                    <Field label="Share description">
                        <textarea rows={2} value={v.ogDescription ?? ''} onInput={e => onChange({ ogDescription: e.currentTarget.value || null })} />
                    </Field>
                    <ImageField label="Share image" hint="1200 by 630 works best. Blank uses the cover image, or a card drawn from the name." value={v.ogImage} onChange={url => onChange({ ogImage: url })} />
                    {kind === 'topic' ? (
                        <>
                            <Field label="X (Twitter) title" hint="Blank uses the share title.">
                                <input value={v.twitterTitle ?? ''} onInput={e => onChange({ twitterTitle: e.currentTarget.value || null })} />
                            </Field>
                            <Field label="X (Twitter) description">
                                <textarea rows={2} value={v.twitterDescription ?? ''} onInput={e => onChange({ twitterDescription: e.currentTarget.value || null })} />
                            </Field>
                            <ImageField label="X (Twitter) image" value={v.twitterImage} onChange={url => onChange({ twitterImage: url })} />
                            <Field label="Canonical address" hint="Only when another address is the original. Blank uses this page's own.">
                                <input type="url" placeholder="https://" value={v.canonicalUrl ?? ''} onInput={e => onChange({ canonicalUrl: e.currentTarget.value || null })} />
                            </Field>
                        </>
                    ) : null}
                    <label class="check">
                        <input type="checkbox" checked={Boolean(v.noindex)} onChange={e => onChange({ noindex: e.currentTarget.checked })} /> Keep this page out of search results and the sitemap
                    </label>
                </div>
            </details>
        </div>
    );
}
