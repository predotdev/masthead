import { useEffect, useState } from 'preact/hooks';
import { api, fmtDate } from '../api';
import { Button, Dialog, ErrorNote, Field, Loading, PageHead, Pill, errorToast, toast, useLoad } from '../ui';
import { AppearanceEditor, FooterEditor, HeaderMenu } from './site-design';

interface SettingsData {
    site: Record<string, any>;
    newsletter: Record<string, any>;
    ai: { textModel: string | null; imageModel: string | null; voice: string | null };
    keys: { id: string; name: string; prefix: string; role: string; created_at: string; last_used_at: string | null }[];
    environment: { siteUrl: string; appUrl: string; testMode: boolean; emailFrom: string | null; email: boolean; ai: boolean; webhooks: boolean; linkTag: string | null };
}

export function Settings() {
    const { data, error, reload } = useLoad(() => api<SettingsData>('/settings'), []);
    if (error) return <ErrorNote text={error} />;
    if (!data) return <Loading />;
    return <SettingsForm data={data} reload={reload} />;
}

function SettingsForm({ data, reload }: { data: SettingsData; reload: () => void }) {
    const [site, setSite] = useState(data.site);
    const [newsletter, setNewsletter] = useState(data.newsletter);
    const [ai, setAi] = useState(data.ai);
    const [busy, setBusy] = useState(false);
    const [newKey, setNewKey] = useState<string | null>(null);
    const env = data.environment;

    const save = async () => {
        setBusy(true);
        try {
            await api('/settings', { method: 'PUT', body: { site, newsletter, ai } });
            toast('Saved');
            reload();
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };

    const s = (k: string) => ({ value: site[k] ?? '', onInput: (e: any) => setSite({ ...site, [k]: e.currentTarget.value || null }) });
    const n = (k: string) => ({ value: newsletter[k] ?? '', onInput: (e: any) => setNewsletter({ ...newsletter, [k]: e.currentTarget.value || null }) });

    return (
        <div class="settings">
            <PageHead title="Settings">
                <Button
                    onClick={async () => {
                        try {
                            const r = await api<{ written: number; total: number; ms: number }>('/publish', { method: 'POST' });
                            toast(`Site rebuilt: ${r.written} of ${r.total} files changed in ${r.ms} ms`);
                        } catch (err) {
                            errorToast(err);
                        }
                    }}
                >
                    Rebuild site
                </Button>
                <Button tone="primary" busy={busy} onClick={save}>
                    Save
                </Button>
            </PageHead>

            <section class="panel">
                <h2>Environment</h2>
                <dl class="facts">
                    <dt>Public address</dt>
                    <dd>{env.siteUrl}</dd>
                    <dt>This server</dt>
                    <dd>{env.appUrl}</dd>
                    <dt>Newsletter sending</dt>
                    <dd>{env.testMode ? <Pill tone="amber">test mode: only the provider's test inbox receives mail</Pill> : <Pill tone="green">live</Pill>}</dd>
                    <dt>Email</dt>
                    <dd>{env.email ? `${env.emailFrom ?? 'no sender set'}` : 'Not configured'}</dd>
                    <dt>Delivery webhooks</dt>
                    <dd>{env.webhooks ? 'Connected' : 'Not connected: bounces and opens are not recorded'}</dd>
                    <dt>AI</dt>
                    <dd>{env.ai ? 'Connected' : 'Not configured'}</dd>
                    <dt>Link tagging</dt>
                    <dd>{env.linkTag ?? 'Off'}</dd>
                </dl>
            </section>

            <section class="panel">
                <h2>Site</h2>
                <div class="grid2">
                    <Field label="Title">
                        <input {...s('title')} />
                    </Field>
                    <Field label="Description">
                        <input {...s('description')} />
                    </Field>
                    <Field label="Search title for the front page">
                        <input {...s('metaTitle')} />
                    </Field>
                    <Field label="Search description for the front page">
                        <input {...s('metaDescription')} />
                    </Field>
                    <Field label="Logo URL">
                        <input {...s('logo')} />
                    </Field>
                    <Field label="Icon URL">
                        <input {...s('icon')} />
                    </Field>
                    <Field label="Default share image URL">
                        <input {...s('shareImage')} />
                    </Field>
                    <Field label="X handle">
                        <input {...s('twitter')} placeholder="@handle" />
                    </Field>
                </div>
            </section>

            <section class="panel">
                <h2>Header menu</h2>
                <p class="muted small">Links across the top of every page. Turn any item into a dropdown of described links.</p>
                <HeaderMenu items={site.navigation ?? []} onChange={navigation => setSite({ ...site, navigation })} />
            </section>

            <section class="panel">
                <h2>Footer</h2>
                <FooterEditor value={site.footer ?? {}} onChange={footer => setSite({ ...site, footer })} />
            </section>

            <section class="panel">
                <h2>Appearance</h2>
                <AppearanceEditor value={site.appearance ?? {}} onChange={appearance => setSite({ ...site, appearance })} />
            </section>

            <section class="panel">
                <h2>Newsletter</h2>
                <div class="grid2">
                    <Field label="Sender name">
                        <input {...n('senderName')} />
                    </Field>
                    <Field label="Reply-to address">
                        <input type="email" {...n('replyTo')} />
                    </Field>
                    <Field label="Postal address" hint="Shown in every newsletter footer; required for commercial email in the US.">
                        <input {...n('postalAddress')} />
                    </Field>
                </div>
            </section>

            <section class="panel">
                <h2>AI</h2>
                <div class="grid2">
                    <ModelPicker kind="text" label="Writing model" value={ai.textModel} onChange={v => setAi({ ...ai, textModel: v })} />
                    <ModelPicker kind="image" label="Image model" value={ai.imageModel} onChange={v => setAi({ ...ai, imageModel: v })} />
                </div>
                <Field label="House style" hint="Tone, audience and rules every draft follows, e.g. words to avoid or names never to mention.">
                    <textarea rows={6} value={ai.voice ?? ''} onInput={e => setAi({ ...ai, voice: e.currentTarget.value || null })} />
                </Field>
            </section>

            <section class="panel">
                <div class="row between">
                    <h2>API keys</h2>
                    <Button
                        onClick={async () => {
                            const name = window.prompt('What will use this key?', 'Product signups');
                            if (!name) return;
                            try {
                                const r = await api<{ key: string }>('/keys', { body: { name, role: 'admin' } });
                                setNewKey(r.key);
                                reload();
                            } catch (err) {
                                errorToast(err);
                            }
                        }}
                    >
                        New key
                    </Button>
                </div>
                <p class="muted small">For integrations such as adding product signups as members. Send it as Authorization: Bearer &lt;key&gt;.</p>
                <table class="table">
                    <tbody>
                        {data.keys.map(k => (
                            <tr key={k.id}>
                                <td>
                                    <span class="title-cell">{k.name}</span> <code>{k.prefix}…</code>
                                </td>
                                <td class="muted">{k.role}</td>
                                <td class="muted">{k.last_used_at ? `used ${fmtDate(k.last_used_at)}` : 'never used'}</td>
                                <td class="num">
                                    <Button
                                        tone="plain"
                                        onClick={async () => {
                                            if (!window.confirm(`Revoke "${k.name}"? Anything using it stops working.`)) return;
                                            await api(`/keys/${k.id}`, { method: 'DELETE' }).catch(errorToast);
                                            reload();
                                        }}
                                    >
                                        Revoke
                                    </Button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
            {newKey ? (
                <Dialog title="Your new key" onClose={() => setNewKey(null)}>
                    <p>Copy it now. It won't be shown again.</p>
                    <input readOnly value={newKey} onFocus={e => e.currentTarget.select()} />
                    <div class="dialog-actions">
                        <Button
                            tone="primary"
                            onClick={() => navigator.clipboard.writeText(newKey).then(() => toast('Copied'), () => toast('Select the key and copy it', 'error'))}
                        >
                            Copy
                        </Button>
                    </div>
                </Dialog>
            ) : null}
        </div>
    );
}

function ModelPicker({ kind, label, value, onChange }: { kind: 'text' | 'image'; label: string; value: string | null; onChange: (v: string | null) => void }) {
    const [models, setModels] = useState<{ id: string; name: string }[] | null>(null);
    useEffect(() => {
        api<{ id: string; name: string }[]>(`/ai/models?kind=${kind}`)
            .then(setModels)
            .catch(() => setModels([]));
    }, [kind]);
    const listId = `models-${kind}`;
    return (
        <Field label={label} hint={models ? `${models.length} available` : 'Loading models…'}>
            <input list={listId} value={value ?? ''} onInput={e => onChange(e.currentTarget.value || null)} placeholder="Start typing a model name" />
            <datalist id={listId}>
                {(models ?? []).map(m => (
                    <option key={m.id} value={m.id}>
                        {m.name}
                    </option>
                ))}
            </datalist>
        </Field>
    );
}
