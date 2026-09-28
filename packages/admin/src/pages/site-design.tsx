import type { ComponentChildren } from 'preact';
import { Button, Field } from '../ui';

/** Editors for the header menu, the footer and the look of the site. They edit site settings in place. */

export interface NavItem {
    label: string;
    url: string;
    description?: string | null;
    badge?: string | null;
    icon?: string | null;
    group?: string | null;
    items?: NavItem[];
}

interface Footer {
    tagline?: string | null;
    columns?: { title: string; links: NavItem[] }[];
    legal?: NavItem[];
    copyright?: string | null;
    social?: { network: string; url: string }[];
}

interface Appearance {
    colorScheme?: 'system' | 'light' | 'dark';
    brandUrl?: string | null;
    logoText?: boolean;
    invertLogoInLight?: boolean;
    backdrop?: { image?: string | null; mobileImage?: string | null; sparkles?: boolean } | null;
    headerCta?: { label: string; url: string; signedIn?: { cookie: string; label: string; url: string } | null } | null;
    hero?: { title?: string | null; text?: string | null } | null;
    subscribe?: { title?: string | null; text?: string | null } | null;
}

const ICONS = ['', 'terminal', 'window', 'workflow', 'pointer', 'flask', 'book', 'rss', 'mail'];
const NETWORKS = ['x', 'linkedin', 'youtube', 'instagram', 'discord', 'github', 'facebook', 'threads', 'bluesky', 'mastodon', 'tiktok'];

const move = <T,>(list: T[], i: number, by: number): T[] => {
    const j = i + by;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
};
const put = <T,>(list: T[], i: number, value: T): T[] => list.map((x, j) => (j === i ? value : x));
const text = (v: string) => v || null;

function RowTools({ list, i, onChange }: { list: unknown[]; i: number; onChange: (v: any[]) => void }) {
    return (
        <div class="row-tools">
            <button type="button" class="icon-btn" title="Move up" disabled={i === 0} onClick={() => onChange(move(list, i, -1))}>
                ↑
            </button>
            <button type="button" class="icon-btn" title="Move down" disabled={i === list.length - 1} onClick={() => onChange(move(list, i, 1))}>
                ↓
            </button>
            <button type="button" class="icon-btn" title="Remove" onClick={() => onChange(list.filter((_, j) => j !== i))}>
                ×
            </button>
        </div>
    );
}

/** A list of plain links: label and address. */
export function LinkList({ label, items, onChange, addLabel = 'Add link' }: { label?: string; items: NavItem[]; onChange: (v: NavItem[]) => void; addLabel?: string }) {
    return (
        <div class="stack-sm">
            {label ? <span class="field-label">{label}</span> : null}
            {items.map((it, i) => (
                <div class="link-row" key={i}>
                    <input value={it.label} placeholder="Label" aria-label="Label" onInput={e => onChange(put(items, i, { ...it, label: e.currentTarget.value }))} />
                    <input value={it.url} placeholder="https:// or /path/" aria-label="Address" onInput={e => onChange(put(items, i, { ...it, url: e.currentTarget.value }))} />
                    <RowTools list={items} i={i} onChange={onChange} />
                </div>
            ))}
            <div>
                <Button tone="plain" onClick={() => onChange([...items, { label: '', url: '' }])}>
                    + {addLabel}
                </Button>
            </div>
        </div>
    );
}

/** The header menu. Any item can become a dropdown with described links grouped under headings. */
export function HeaderMenu({ items, onChange }: { items: NavItem[]; onChange: (v: NavItem[]) => void }) {
    return (
        <div class="stack">
            {items.map((it, i) => {
                const sub = it.items ?? [];
                return (
                    <div class="menu-item" key={i}>
                        <div class="link-row">
                            <input value={it.label} placeholder="Label" aria-label="Label" onInput={e => onChange(put(items, i, { ...it, label: e.currentTarget.value }))} />
                            <input
                                value={it.url}
                                placeholder={sub.length ? 'Dropdown (address unused)' : 'https:// or /path/'}
                                aria-label="Address"
                                onInput={e => onChange(put(items, i, { ...it, url: e.currentTarget.value }))}
                            />
                            <RowTools list={items} i={i} onChange={onChange} />
                        </div>
                        {sub.length ? (
                            <div class="sub-items">
                                {sub.map((s, k) => {
                                    const setSub = (v: NavItem) => onChange(put(items, i, { ...it, items: put(sub, k, v) }));
                                    return (
                                        <div class="sub-item" key={k}>
                                            <div class="link-row">
                                                <input value={s.label} placeholder="Label" aria-label="Label" onInput={e => setSub({ ...s, label: e.currentTarget.value })} />
                                                <input value={s.url} placeholder="Address" aria-label="Address" onInput={e => setSub({ ...s, url: e.currentTarget.value })} />
                                                <RowTools list={sub} i={k} onChange={v => onChange(put(items, i, { ...it, items: v }))} />
                                            </div>
                                            <div class="link-row detail">
                                                <input value={s.description ?? ''} placeholder="Description" aria-label="Description" onInput={e => setSub({ ...s, description: text(e.currentTarget.value) })} />
                                                <input value={s.group ?? ''} placeholder="Heading" aria-label="Heading" onInput={e => setSub({ ...s, group: text(e.currentTarget.value) })} />
                                                <select value={s.icon ?? ''} aria-label="Icon" onChange={e => setSub({ ...s, icon: text(e.currentTarget.value) })}>
                                                    {ICONS.map(n => (
                                                        <option key={n} value={n}>
                                                            {n || 'No icon'}
                                                        </option>
                                                    ))}
                                                </select>
                                                <input class="short" value={s.badge ?? ''} placeholder="Badge" aria-label="Badge" onInput={e => setSub({ ...s, badge: text(e.currentTarget.value) })} />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : null}
                        <div>
                            <Button tone="plain" onClick={() => onChange(put(items, i, { ...it, items: [...sub, { label: '', url: '' }] }))}>
                                + {sub.length ? 'Add to dropdown' : 'Make a dropdown'}
                            </Button>
                        </div>
                    </div>
                );
            })}
            <div>
                <Button onClick={() => onChange([...items, { label: '', url: '' }])}>Add menu item</Button>
            </div>
        </div>
    );
}

export function FooterEditor({ value, onChange }: { value: Footer; onChange: (v: Footer) => void }) {
    const columns = value.columns ?? [];
    const social = value.social ?? [];
    return (
        <div class="stack">
            <div class="grid2">
                <Field label="Line under the logo">
                    <input value={value.tagline ?? ''} onInput={e => onChange({ ...value, tagline: text(e.currentTarget.value) })} />
                </Field>
                <Field label="Copyright" hint="{year} becomes the current year.">
                    <input value={value.copyright ?? ''} placeholder="© {year} Your company" onInput={e => onChange({ ...value, copyright: text(e.currentTarget.value) })} />
                </Field>
            </div>
            <span class="field-label">Columns</span>
            <div class="columns-editor">
                {columns.map((c, i) => (
                    <div class="column-card" key={i}>
                        <div class="link-row">
                            <input value={c.title} placeholder="Column title" aria-label="Column title" onInput={e => onChange({ ...value, columns: put(columns, i, { ...c, title: e.currentTarget.value }) })} />
                            <RowTools list={columns} i={i} onChange={v => onChange({ ...value, columns: v })} />
                        </div>
                        <LinkList items={c.links} onChange={links => onChange({ ...value, columns: put(columns, i, { ...c, links }) })} />
                    </div>
                ))}
            </div>
            <div>
                <Button onClick={() => onChange({ ...value, columns: [...columns, { title: '', links: [] }] })}>Add column</Button>
            </div>
            <LinkList label="Legal links" items={value.legal ?? []} onChange={legal => onChange({ ...value, legal })} />
            <div class="stack-sm">
                <span class="field-label">Social</span>
                {social.map((s, i) => (
                    <div class="link-row" key={i}>
                        <select value={s.network} aria-label="Network" onChange={e => onChange({ ...value, social: put(social, i, { ...s, network: e.currentTarget.value }) })}>
                            {NETWORKS.map(n => (
                                <option key={n} value={n}>
                                    {n}
                                </option>
                            ))}
                        </select>
                        <input value={s.url} placeholder="https://" aria-label="Profile address" onInput={e => onChange({ ...value, social: put(social, i, { ...s, url: e.currentTarget.value }) })} />
                        <RowTools list={social} i={i} onChange={v => onChange({ ...value, social: v })} />
                    </div>
                ))}
                <div>
                    <Button tone="plain" onClick={() => onChange({ ...value, social: [...social, { network: 'x', url: '' }] })}>
                        + Add profile
                    </Button>
                </div>
            </div>
        </div>
    );
}

export function AppearanceEditor({ value, onChange }: { value: Appearance; onChange: (v: Appearance) => void }) {
    const cta = value.headerCta ?? { label: '', url: '' };
    const hero = value.hero ?? {};
    const sub = value.subscribe ?? {};
    const setCta = (c: typeof cta) => onChange({ ...value, headerCta: c.label || c.url ? c : null });
    return (
        <div class="stack">
            <div class="grid2">
                <Field label="Color scheme for new readers" hint="Readers can switch; their choice is remembered.">
                    <select value={value.colorScheme ?? 'system'} onChange={e => onChange({ ...value, colorScheme: e.currentTarget.value as Appearance['colorScheme'] })}>
                        <option value="system">Follow the reader's device</option>
                        <option value="dark">Dark</option>
                        <option value="light">Light</option>
                    </select>
                </Field>
                <Field label="Logo links to" hint="Blank: the blog's front page.">
                    <input value={value.brandUrl ?? ''} placeholder="https://" onInput={e => onChange({ ...value, brandUrl: text(e.currentTarget.value) })} />
                </Field>
            </div>
            <label class="check">
                <input type="checkbox" checked={!!value.logoText} onChange={e => onChange({ ...value, logoText: e.currentTarget.checked })} /> Show the site title next to the logo
            </label>
            <label class="check">
                <input type="checkbox" checked={!!value.invertLogoInLight} onChange={e => onChange({ ...value, invertLogoInLight: e.currentTarget.checked })} /> The logo is white: invert it in light mode
            </label>
            <Group title="Night sky backdrop">
                <div class="grid2">
                    <Field label="Image behind the header" hint="Fades into the page. Inverted in light mode.">
                        <input value={value.backdrop?.image ?? ''} placeholder="https://" onInput={e => onChange({ ...value, backdrop: { ...value.backdrop, image: text(e.currentTarget.value) } })} />
                    </Field>
                    <Field label="Image for phones">
                        <input value={value.backdrop?.mobileImage ?? ''} placeholder="https://" onInput={e => onChange({ ...value, backdrop: { ...value.backdrop, mobileImage: text(e.currentTarget.value) } })} />
                    </Field>
                </div>
                <label class="check">
                    <input type="checkbox" checked={!!value.backdrop?.sparkles} onChange={e => onChange({ ...value, backdrop: { ...value.backdrop, sparkles: e.currentTarget.checked } })} /> Twinkling sparkles
                    (desktop; still for readers who prefer less motion)
                </label>
            </Group>
            <Group title="Header button">
                <div class="grid2">
                    <Field label="Label">
                        <input value={cta.label} placeholder="Sign in" onInput={e => setCta({ ...cta, label: e.currentTarget.value })} />
                    </Field>
                    <Field label="Address">
                        <input value={cta.url} placeholder="https://app.example.com/login" onInput={e => setCta({ ...cta, url: e.currentTarget.value })} />
                    </Field>
                    <Field label="Signed-in cookie" hint="When your product's session cookie is present, the button changes.">
                        <input
                            value={cta.signedIn?.cookie ?? ''}
                            placeholder="session cookie name"
                            onInput={e => setCta({ ...cta, signedIn: e.currentTarget.value ? { label: 'Dashboard', url: '', ...cta.signedIn, cookie: e.currentTarget.value } : null })}
                        />
                    </Field>
                    <div class="grid2">
                        <Field label="Signed-in label">
                            <input value={cta.signedIn?.label ?? ''} disabled={!cta.signedIn} onInput={e => cta.signedIn && setCta({ ...cta, signedIn: { ...cta.signedIn, label: e.currentTarget.value } })} />
                        </Field>
                        <Field label="Signed-in address">
                            <input value={cta.signedIn?.url ?? ''} disabled={!cta.signedIn} onInput={e => cta.signedIn && setCta({ ...cta, signedIn: { ...cta.signedIn, url: e.currentTarget.value } })} />
                        </Field>
                    </div>
                </div>
            </Group>
            <Group title="Front page masthead">
                <div class="grid2">
                    <Field label="Title" hint="Shown big after the logo. Blank: no masthead; the newest post leads the page.">
                        <input value={hero.title ?? ''} placeholder="Acme blog" onInput={e => onChange({ ...value, hero: { ...hero, title: text(e.currentTarget.value) } })} />
                    </Field>
                    <Field label="Tagline" hint="Blank: none.">
                        <input value={hero.text ?? ''} onInput={e => onChange({ ...value, hero: { ...hero, text: text(e.currentTarget.value) } })} />
                    </Field>
                </div>
            </Group>
            <Group title="Newsletter signup">
                <div class="grid2">
                    <Field label="Heading">
                        <input value={sub.title ?? ''} placeholder="Get new posts by email" onInput={e => onChange({ ...value, subscribe: { ...sub, title: text(e.currentTarget.value) } })} />
                    </Field>
                    <Field label="Text">
                        <input value={sub.text ?? ''} onInput={e => onChange({ ...value, subscribe: { ...sub, text: text(e.currentTarget.value) } })} />
                    </Field>
                </div>
            </Group>
        </div>
    );
}

function Group({ title, children }: { title: string; children: ComponentChildren }) {
    return (
        <fieldset class="group">
            <legend>{title}</legend>
            {children}
        </fieldset>
    );
}
