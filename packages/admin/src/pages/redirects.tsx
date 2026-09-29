import { useMemo, useState } from 'preact/hooks';
import { api, fmtAgo, fmtNum, session } from '../api';
import { Button, Dialog, Empty, ErrorNote, Field, PageHead, Pill, TableSkeleton, errorToast, toast, useLoad } from '../ui';

interface Redirect {
    id: string;
    from: string;
    to: string;
    status: 301 | 302 | 307 | 308;
    kind: 'path' | 'regex';
    hits: number;
    lastHitAt: string | null;
    note: string | null;
}

const STATUS_LABEL: Record<number, string> = { 301: '301 permanent', 302: '302 temporary', 307: '307 temporary (same method)', 308: '308 permanent (same method)' };

/** The address inside the blog a "to" points at, for showing without the prefix. */
const show = (to: string, base: string) => (to.startsWith(base) ? `/${to.slice(base.length)}` : to);

function download(name: string, text: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Redirects() {
    const { data, error, loading, reload } = useLoad(() => api<Redirect[]>('/redirects'), []);
    const [editing, setEditing] = useState<Partial<Redirect> | null>(null);
    const [importing, setImporting] = useState(false);
    const [q, setQ] = useState('');
    const [probe, setProbe] = useState('');
    const [probeAnswer, setProbeAnswer] = useState<string | null>(null);
    const base = session.value?.site.url ? new URL(session.value.site.url).pathname : '/';
    const list = useMemo(() => {
        const needle = q.trim().toLowerCase();
        return (data ?? []).filter(r => !needle || `${r.from} ${r.to} ${r.note ?? ''}`.toLowerCase().includes(needle));
    }, [data, q]);

    async function test(e: Event) {
        e.preventDefault();
        if (!probe.trim()) return;
        try {
            const { result } = await api<{ result: { to: string; status: number } | null }>('/redirects/test', { method: 'POST', body: { url: probe } });
            setProbeAnswer(result ? `${result.status} to ${result.to}` : 'No redirect matches. The page is served as it is, or is a 404.');
        } catch (err) {
            errorToast(err);
        }
    }

    return (
        <div>
            <PageHead title="Redirects" description="Send an old address to a new one. Real pages always win, so a redirect can never hide a post. Changing a published post's address adds one for you.">
                <Button
                    icon="download"
                    onClick={async () => {
                        try {
                            download('redirects.json', await api<string>('/redirects/export'), 'application/json');
                        } catch (err) {
                            errorToast(err);
                        }
                    }}
                >
                    Export
                </Button>
                <Button icon="upload" onClick={() => setImporting(true)}>
                    Import
                </Button>
                <Button tone="primary" icon="plus" onClick={() => setEditing({ status: 301, from: '', to: '' })}>
                    New redirect
                </Button>
            </PageHead>
            <div class="toolbar">
                <input class="search" type="search" placeholder="Search redirects" aria-label="Search redirects" value={q} onInput={e => setQ(e.currentTarget.value)} />
                <form class="row" onSubmit={test} style="gap:8px;flex-wrap:wrap">
                    <input
                        type="text"
                        placeholder="Test an address, like /old-post/"
                        aria-label="Test an address"
                        value={probe}
                        onInput={e => (setProbe(e.currentTarget.value), setProbeAnswer(null))}
                        style="min-width:220px"
                    />
                    <Button type="submit">Test</Button>
                </form>
            </div>
            {probeAnswer ? (
                <p class="hint" role="status" style="margin:-4px 0 12px">
                    {probeAnswer}
                </p>
            ) : null}
            {error ? <ErrorNote text={error} /> : null}
            {loading && !data ? (
                <TableSkeleton rows={6} columns={5} />
            ) : !data?.length ? (
                <Empty
                    icon="redirect"
                    title="No redirects yet"
                    action={
                        <Button tone="primary" icon="plus" onClick={() => setEditing({ status: 301, from: '', to: '' })}>
                            New redirect
                        </Button>
                    }
                >
                    Add one, or import a Ghost redirects.json or a CSV of from,to,status.
                </Empty>
            ) : !list.length ? (
                <Empty icon="search" title="Nothing matches" action={<Button onClick={() => setQ('')}>Clear search</Button>} />
            ) : (
                <div class="table-wrap">
                    <table class="table">
                        <thead>
                            <tr>
                                <th>From</th>
                                <th>To</th>
                                <th>Status</th>
                                <th class="num">Hits</th>
                                <th>Last hit</th>
                            </tr>
                        </thead>
                        <tbody>
                            {list.map(r => (
                                <tr key={r.id} class="row-link" onClick={() => setEditing(r)}>
                                    <td class="title-cell">
                                        <code>{r.from}</code> {r.kind === 'regex' ? <Pill tone="blue">pattern</Pill> : null}
                                        {r.note ? <div class="muted small">{r.note}</div> : null}
                                    </td>
                                    <td class="muted" style="word-break:break-all">
                                        {show(r.to, base)}
                                    </td>
                                    <td>
                                        <Pill tone={r.status === 301 || r.status === 308 ? 'green' : 'amber'}>{r.status}</Pill>
                                    </td>
                                    <td class="num">{fmtNum(r.hits)}</td>
                                    <td class="muted">{r.lastHitAt ? fmtAgo(r.lastHitAt) : '-'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {editing ? (
                <Dialog title={editing.id ? 'Edit redirect' : 'New redirect'} description="Addresses are inside the blog, like /old-post/. Use https://... to leave the blog." onClose={() => setEditing(null)}>
                    <form
                        class="stack"
                        onSubmit={async e => {
                            e.preventDefault();
                            try {
                                await api(editing.id ? `/redirects/${editing.id}` : '/redirects', {
                                    method: editing.id ? 'PUT' : 'POST',
                                    body: { from: editing.from, to: editing.to, status: editing.status, note: editing.note }
                                });
                                toast('Saved');
                                setEditing(null);
                                reload();
                            } catch (err) {
                                errorToast(err);
                            }
                        }}
                    >
                        <Field label="From" hint="An exact address, or a pattern: ^/topic/(.*)$ keeps what (.*) matched as $1.">
                            <input required autofocus value={editing.from ?? ''} placeholder="/old-post/" onInput={e => setEditing({ ...editing, from: e.currentTarget.value })} />
                        </Field>
                        <Field label="To" hint="An address inside the blog, /new-post/, a pattern's $1, or a full https:// address.">
                            <input required value={editing.to ? show(editing.to, base) : ''} placeholder="/new-post/" onInput={e => setEditing({ ...editing, to: e.currentTarget.value })} />
                        </Field>
                        <Field label="Type" hint="Permanent (301, 308) tells search engines to move the old address's ranking to the new one.">
                            <select value={String(editing.status ?? 301)} onChange={e => setEditing({ ...editing, status: Number(e.currentTarget.value) as Redirect['status'] })}>
                                {[301, 302, 307, 308].map(s => (
                                    <option key={s} value={s}>
                                        {STATUS_LABEL[s]}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Note" hint="Optional. Only shown here.">
                            <input value={editing.note ?? ''} maxLength={200} onInput={e => setEditing({ ...editing, note: e.currentTarget.value })} />
                        </Field>
                        <div class="dialog-actions">
                            {editing.id ? (
                                <Button
                                    tone="danger"
                                    onClick={async () => {
                                        if (!window.confirm('Delete this redirect? The old address will 404 again.')) return;
                                        await api(`/redirects/${editing.id}`, { method: 'DELETE' }).catch(errorToast);
                                        setEditing(null);
                                        reload();
                                    }}
                                >
                                    Delete
                                </Button>
                            ) : null}
                            <div class="grow" />
                            <Button onClick={() => setEditing(null)}>Cancel</Button>
                            <Button tone="primary" type="submit">
                                Save
                            </Button>
                        </div>
                    </form>
                </Dialog>
            ) : null}
            {importing ? <ImportDialog onClose={() => setImporting(false)} onDone={() => (setImporting(false), reload())} /> : null}
        </div>
    );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [skipped, setSkipped] = useState<{ from: string; reason: string }[]>([]);
    return (
        <Dialog title="Import redirects" description="Paste or choose a Ghost redirects.json, or a CSV with from,to,status columns. Patterns work as in Ghost." onClose={onClose}>
            <form
                class="stack"
                onSubmit={async e => {
                    e.preventDefault();
                    setBusy(true);
                    try {
                        const r = await api<{ added: number; skipped: { from: string; reason: string }[] }>('/redirects/import', { method: 'POST', body: { text } });
                        toast(`Added ${r.added}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}`);
                        if (r.skipped.length) setSkipped(r.skipped);
                        else onDone();
                    } catch (err) {
                        errorToast(err);
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                <input
                    type="file"
                    accept=".json,.csv,text/csv,application/json"
                    aria-label="Choose a file"
                    onChange={async e => {
                        const file = e.currentTarget.files?.[0];
                        if (file) setText(await file.text());
                    }}
                />
                <textarea class="code-input" style="min-height:160px" rows={8} placeholder={'[{ "from": "/old/", "to": "/new/", "permanent": true }]'} value={text} onInput={e => setText(e.currentTarget.value)} />
                {skipped.length ? (
                    <div class="hint">
                        <strong>Skipped:</strong>
                        <ul>
                            {skipped.slice(0, 20).map(s => (
                                <li key={s.from}>
                                    <code>{s.from}</code>: {s.reason}
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}
                <div class="dialog-actions">
                    <div class="grow" />
                    <Button onClick={skipped.length ? onDone : onClose}>{skipped.length ? 'Done' : 'Cancel'}</Button>
                    <Button tone="primary" type="submit" busy={busy} disabled={!text.trim()}>
                        Import
                    </Button>
                </div>
            </form>
        </Dialog>
    );
}
