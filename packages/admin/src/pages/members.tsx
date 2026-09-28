import { useState } from 'preact/hooks';
import { api, base, fmtDate, fmtNum } from '../api';
import { Button, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Pill, TableSkeleton, errorToast, toast, useLoad } from '../ui';
import { Stat } from './newsletters';

interface Member {
    id: string;
    email: string;
    name: string | null;
    status: 'pending' | 'subscribed' | 'unsubscribed';
    statusSource: string;
    suppressed: 'bounced' | 'complained' | null;
    labels: string[];
    flags: string[];
    source: string;
    emailCount: number;
    openedCount: number;
    createdAt: string;
    attribution: { post: string | null; placement: string | null; referrer: string | null; utmSource: string | null; at: string } | null;
}

const FILTERS: [string, string][] = [
    ['', 'Everyone'],
    ['status=subscribed&suppressed=false', 'Subscribed'],
    ['status=unsubscribed', 'Unsubscribed'],
    ['status=pending', 'Awaiting confirmation'],
    ['suppressed=true', 'Bounced or complained'],
    ['flag=resubscribed-after-opt-out', 'Needs review']
];

export function Members() {
    const [filter, setFilter] = useState('');
    const [q, setQ] = useState('');
    const [offset, setOffset] = useState(0);
    const [open, setOpen] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const { data, error, loading, reload } = useLoad(
        () => api<{ items: Member[]; total: number; stats: Record<string, number> }>(`/members?limit=50&offset=${offset}${filter ? `&${filter}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
        [filter, q, offset]
    );
    const s = data?.stats;

    const exportCsv = async () => {
        const res = await fetch(`${base}admin/api/members/export.csv`, { credentials: 'same-origin', headers: { 'x-masthead': '1' } });
        if (!res.ok) return errorToast(new Error('Export failed.'));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(await res.blob());
        a.download = 'members.csv';
        a.click();
    };

    const importCsv = async (file: File) => {
        try {
            const r = await api<{ created: number; existing: number; invalid: number }>('/members/import.csv', { body: await file.text() });
            toast(`Added ${r.created}, already there ${r.existing}, invalid ${r.invalid}`);
            reload();
        } catch (err) {
            errorToast(err);
        }
    };

    return (
        <div>
            <PageHead title="Members" description="Everyone on the list, and whether newsletters reach them.">
                <label class="btn ghost">
                    Import CSV
                    <input type="file" accept=".csv,text/csv" hidden onChange={e => e.currentTarget.files?.[0] && importCsv(e.currentTarget.files[0])} />
                </label>
                <Button onClick={exportCsv}>Export CSV</Button>
                <Button tone="primary" onClick={() => setAdding(true)}>
                    Add member
                </Button>
            </PageHead>
            {s ? (
                <div class="stats">
                    <Stat label="Will receive newsletters" value={fmtNum(s.sendable)} />
                    <Stat label="Unsubscribed" value={fmtNum(s.unsubscribed)} />
                    <Stat label="Bounced or complained" value={fmtNum(s.suppressed)} />
                    <Stat label="Have opened an email" value={fmtNum(s.engaged)} />
                    <Stat label="Everyone" value={fmtNum(s.total)} />
                </div>
            ) : null}
            {s?.flagged ? (
                <div class="note warn">
                    {fmtNum(s.flagged)} {s.flagged === 1 ? 'person' : 'people'} unsubscribed themselves and were later subscribed again by an integration, not by them.{' '}
                    <button class="link-btn" onClick={() => (setFilter('flag=resubscribed-after-opt-out'), setOffset(0))}>
                        Review them
                    </button>{' '}
                    or{' '}
                    <button
                        class="link-btn"
                        onClick={async () => {
                            if (!window.confirm(`Unsubscribe these ${s.flagged} people again, as they originally asked?`)) return;
                            try {
                                const r = await api<{ restored: number }>('/members/restore-opt-outs', { method: 'POST' });
                                toast(`Restored ${r.restored} opt-outs`);
                                reload();
                            } catch (err) {
                                errorToast(err);
                            }
                        }}
                    >
                        restore their opt-out
                    </button>
                    .
                </div>
            ) : null}
            <div class="toolbar">
                <div class="tabs">
                    {FILTERS.map(([v, label]) => (
                        <button key={v} class={`tab ${filter === v ? 'on' : ''}`} onClick={() => (setFilter(v), setOffset(0))}>
                            {label}
                        </button>
                    ))}
                </div>
                <input class="search" type="search" placeholder="Search email or name" value={q} onInput={e => (setQ(e.currentTarget.value), setOffset(0))} />
            </div>
            {error ? <ErrorNote text={error} /> : null}
            {loading && !data ? (
                <TableSkeleton rows={10} columns={6} />
            ) : !data?.items.length ? (
                filter || q ? (
                    <Empty icon="search" title="Nobody matches" action={<Button onClick={() => (setFilter(''), setQ(''), setOffset(0))}>Clear filters</Button>}>
                        Try another filter or search.
                    </Empty>
                ) : (
                    <Empty
                        icon="members"
                        title="No members yet"
                        action={
                            <Button tone="primary" icon="plus" onClick={() => setAdding(true)}>
                                Add member
                            </Button>
                        }
                    >
                        People join from the signup form on the site. You can also add them here or import a CSV.
                    </Empty>
                )
            ) : (
                <>
                    <div class="table-wrap">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>Email</th>
                                    <th>Status</th>
                                    <th>Source</th>
                                    <th class="num">Emails</th>
                                    <th class="num">Opens</th>
                                    <th>Joined</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.items.map(m => (
                                    <tr key={m.id} class="row-link" onClick={() => setOpen(m.id)}>
                                        <td>
                                            <span class="title-cell">{m.email}</span>
                                            {m.name ? <span class="muted small"> · {m.name}</span> : null}
                                        </td>
                                        <td>
                                            <MemberStatus m={m} />
                                        </td>
                                        <td class="muted">{m.source}</td>
                                        <td class="num">{fmtNum(m.emailCount)}</td>
                                        <td class="num">{fmtNum(m.openedCount)}</td>
                                        <td class="muted nowrap">{fmtDate(m.createdAt)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div class="pager">
                        <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
                            Previous
                        </Button>
                        <span class="muted">
                            {fmtNum(offset + 1)}–{fmtNum(Math.min(offset + 50, data.total))} of {fmtNum(data.total)}
                        </span>
                        <Button disabled={offset + 50 >= data.total} onClick={() => setOffset(offset + 50)}>
                            Next
                        </Button>
                    </div>
                </>
            )}
            {open ? <MemberDialog id={open} onClose={() => (setOpen(null), reload())} /> : null}
            {adding ? <AddMember onClose={() => (setAdding(false), reload())} /> : null}
        </div>
    );
}

function MemberStatus({ m }: { m: Member }) {
    if (m.suppressed) return <Pill tone="red">{m.suppressed}</Pill>;
    return (
        <span class="row">
            <Pill tone={m.status === 'subscribed' ? 'green' : m.status === 'pending' ? 'amber' : 'neutral'}>{m.status}</Pill>
            {m.flags.includes('resubscribed-after-opt-out') ? <Pill tone="amber">review</Pill> : null}
        </span>
    );
}

function MemberDialog({ id, onClose }: { id: string; onClose: () => void }) {
    const { data, error, reload } = useLoad(() => api<{ member: Member; events: { type: string; source: string; at: string }[] }>(`/members/${id}`), [id]);
    const setStatus = async (status: Member['status'], confirm = false) => {
        try {
            await api(`/members/${id}`, { method: 'PUT', body: { status, confirm } });
            toast(status === 'subscribed' ? 'Subscribed' : 'Unsubscribed');
            reload();
        } catch (err) {
            errorToast(err);
        }
    };
    return (
        <Dialog title={data?.member.email ?? 'Member'} onClose={onClose} wide>
            {error ? <ErrorNote text={error} /> : !data ? (
                <Loading />
            ) : (
                <div class="stack">
                    <div class="row">
                        <MemberStatus m={data.member} />
                        <span class="muted small">
                            since {fmtDate(data.member.createdAt)} · {data.member.source} · {fmtNum(data.member.emailCount)} email{data.member.emailCount === 1 ? '' : 's'}, {fmtNum(data.member.openedCount)} open{data.member.openedCount === 1 ? '' : 's'}
                        </span>
                    </div>
                    {data.member.attribution ? <SignedUp a={data.member.attribution} /> : null}
                    {data.member.labels.length ? (
                        <div class="chips">
                            {data.member.labels.map(l => (
                                <span class="chip" key={l}>
                                    {l}
                                </span>
                            ))}
                        </div>
                    ) : null}
                    <div class="row">
                        {data.member.status === 'subscribed' ? (
                            <Button onClick={() => setStatus('unsubscribed')}>Unsubscribe</Button>
                        ) : (
                            <Button
                                onClick={() =>
                                    window.confirm('Only subscribe people who asked for it. Did this person ask to be subscribed again?') && setStatus('subscribed', true)
                                }
                            >
                                Subscribe
                            </Button>
                        )}
                        <Button
                            tone="danger"
                            onClick={async () => {
                                if (!window.confirm('Delete this member and their history?')) return;
                                await api(`/members/${id}`, { method: 'DELETE' }).catch(errorToast);
                                onClose();
                            }}
                        >
                            Delete
                        </Button>
                    </div>
                    <div>
                        <p class="field-label">History</p>
                        <ul class="timeline">
                            {data.events.map((e, i) => (
                                <li key={i}>
                                    <span class="nowrap muted small">{new Date(e.at).toLocaleString()}</span> <b>{e.type}</b> <span class="muted">by {e.source}</span>
                                </li>
                            ))}
                            {!data.events.length ? <li class="muted">No changes recorded.</li> : null}
                        </ul>
                    </div>
                </div>
            )}
        </Dialog>
    );
}

/** Where their latest signup through the blog's form happened, and where the visit came from. */
function SignedUp({ a }: { a: NonNullable<Member['attribution']> }) {
    const where = a.post ? `on /${a.post}/` : a.placement === 'home' ? 'on the front page' : 'on the blog';
    const from = a.referrer || a.utmSource;
    return (
        <p class="muted small">
            Signed up {where}
            {from ? `, arriving from ${from},` : ''} on {fmtDate(a.at)}.
        </p>
    );
}

function AddMember({ onClose }: { onClose: () => void }) {
    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    return (
        <Dialog title="Add member" onClose={onClose}>
            <form
                class="stack"
                onSubmit={async e => {
                    e.preventDefault();
                    setBusy(true);
                    try {
                        const r = await api<{ created: boolean }>('/members', { body: { email, name } });
                        toast(r.created ? 'Added' : 'Already a member; details updated');
                        onClose();
                    } catch (err) {
                        errorToast(err);
                        setBusy(false);
                    }
                }}
            >
                <Field label="Email">
                    <input type="email" required value={email} onInput={e => setEmail(e.currentTarget.value)} />
                </Field>
                <Field label="Name">
                    <input value={name} onInput={e => setName(e.currentTarget.value)} />
                </Field>
                <p class="muted small">Only add people who asked to hear from you. Adding someone never changes an existing member's subscription.</p>
                <div class="dialog-actions">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button tone="primary" type="submit" busy={busy}>
                        Add
                    </Button>
                </div>
            </form>
        </Dialog>
    );
}
