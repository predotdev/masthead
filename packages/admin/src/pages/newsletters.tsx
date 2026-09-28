import { useEffect, useState } from 'preact/hooks';
import { api, base, fmtDate, fmtNum, session, type Post } from '../api';
import { Button, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Pill, errorToast, toast, useLoad } from '../ui';

interface Send {
    id: string;
    post_id: string;
    post_title: string;
    subject: string;
    segment: string;
    status: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
    total: number;
    sent: number;
    failed: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    complained: number;
    /** People who opened or clicked, each once. */
    unique_opens: number;
    unique_clicks: number;
    unsubscribed: number;
    test_mode: number;
    error: string | null;
    created_at: string;
    finished_at: string | null;
}

const TONE = { queued: 'amber', sending: 'blue', sent: 'green', failed: 'red', cancelled: 'neutral' } as const;

export function SendDialog({ post, onClose }: { post: Post; onClose: () => void }) {
    const [segment, setSegment] = useState('all');
    const [count, setCount] = useState<number | null>(null);
    const [subject, setSubject] = useState(post.title);
    const [testTo, setTestTo] = useState(session.value?.user.email ?? '');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState<'' | 'test' | 'send'>('');
    const testMode = session.value?.testMode;

    useEffect(() => {
        setCount(null);
        api<{ count: number }>(`/sends/segment?segment=${encodeURIComponent(segment)}`)
            .then(r => setCount(r.count))
            .catch(errorToast);
    }, [segment]);

    const sendTest = async () => {
        setBusy('test');
        try {
            const r = await api<{ sent: number; failed: string[] }>('/sends/test', { body: { postId: post.id, emails: testTo.split(/[\s,]+/).filter(Boolean) } });
            r.failed.length ? errorToast(r.failed[0]) : toast(`Test sent to ${r.sent} address${r.sent === 1 ? '' : 'es'}`);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy('');
        }
    };

    const send = async () => {
        setBusy('send');
        try {
            const s = await api<Send>('/sends', { body: { postId: post.id, segment, subject, confirm: 'send' } });
            toast('Sending started');
            location.hash = `#/newsletters/${s.id}`;
        } catch (err) {
            errorToast(err);
            setBusy('');
        }
    };

    return (
        <Dialog title="Send as newsletter" onClose={onClose} wide>
            <div class="send-grid">
                <div class="stack">
                    {testMode ? <div class="note">Test mode is on: a newsletter goes only to the team members of the segment you pick. Subscribers get nothing.</div> : null}
                    <Field label="Send to">
                        <select value={segment} onChange={e => setSegment(e.currentTarget.value)}>
                            <option value="all">All subscribers</option>
                            <option value="engaged">Subscribers who have opened an email</option>
                        </select>
                    </Field>
                    <p class="big-number">{count === null ? '…' : fmtNum(count)} recipients</p>
                    <Field label="Subject">
                        <input value={subject} onInput={e => setSubject(e.currentTarget.value)} />
                    </Field>
                    <Field label="Send a test to" hint="Separate addresses with commas.">
                        <div class="row">
                            <input value={testTo} onInput={e => setTestTo(e.currentTarget.value)} />
                            <Button busy={busy === 'test'} onClick={sendTest}>
                                Send test
                            </Button>
                        </div>
                    </Field>
                    <Field label='Type "send" to confirm'>
                        <input value={confirm} onInput={e => setConfirm(e.currentTarget.value)} autoComplete="off" />
                    </Field>
                    <Button tone="primary" busy={busy === 'send'} disabled={confirm.trim().toLowerCase() !== 'send' || !count} onClick={send}>
                        Send to {count === null ? '…' : fmtNum(count)} people
                    </Button>
                </div>
                <iframe class="email-preview" title="Email preview" src={`${base}admin/api/sends/preview?postId=${post.id}`} />
            </div>
        </Dialog>
    );
}

export function Newsletters() {
    const { data, error, loading } = useLoad(() => api<Send[]>('/sends'), []);
    return (
        <div>
            <PageHead title="Newsletters" />
            {error ? <ErrorNote text={error} /> : null}
            {loading && !data ? (
                <Loading />
            ) : !data?.length ? (
                <Empty title="Nothing sent yet.">Open a published post and choose Send as newsletter.</Empty>
            ) : (
                <div class="table-wrap">
                    <table class="table">
                        <thead>
                            <tr>
                                <th>Post</th>
                                <th>Status</th>
                                <th class="num">Recipients</th>
                                <th class="num">Delivered</th>
                                <th class="num">Opened</th>
                                <th>Sent</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.map(s => (
                                <tr key={s.id} class="row-link" onClick={() => (location.hash = `#/newsletters/${s.id}`)}>
                                    <td>
                                        <a href={`#/newsletters/${s.id}`} class="title-cell">
                                            {s.subject}
                                        </a>
                                        {s.test_mode ? <span class="muted small"> · test mode</span> : null}
                                    </td>
                                    <td>
                                        <Pill tone={TONE[s.status]}>{s.status}</Pill>
                                    </td>
                                    <td class="num">{fmtNum(s.total)}</td>
                                    <td class="num">{fmtNum(s.delivered)}</td>
                                    <td class="num">{fmtNum(s.unique_opens)}</td>
                                    <td class="muted nowrap">{fmtDate(s.finished_at ?? s.created_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

export function SendDetail({ id }: { id: string }) {
    const { data, error, reload } = useLoad(() => api<Send>(`/sends/${id}`), [id]);
    useEffect(() => {
        if (!data || (data.status !== 'queued' && data.status !== 'sending')) return;
        const t = setInterval(reload, 3000);
        return () => clearInterval(t);
    }, [data?.status]);
    if (error) return <ErrorNote text={error} />;
    if (!data) return <Loading />;
    const pct = data.total ? Math.round(((data.sent + data.failed) / data.total) * 100) : 0;
    return (
        <div>
            <a class="back" href="#/newsletters">
                ← Newsletters
            </a>
            <PageHead title={data.subject}>
                {data.status === 'queued' || data.status === 'sending' ? (
                    <Button
                        tone="danger"
                        onClick={async () => {
                            await api(`/sends/${id}/cancel`, { method: 'POST' }).catch(errorToast);
                            reload();
                        }}
                    >
                        Stop sending
                    </Button>
                ) : null}
            </PageHead>
            <div class="stats">
                <Stat label="Status" value={<Pill tone={TONE[data.status]}>{data.status}</Pill>} />
                <Stat label="Recipients" value={fmtNum(data.total)} />
                <Stat label="Sent" value={`${fmtNum(data.sent)} (${pct}%)`} />
                <Stat label="Delivered" value={fmtNum(data.delivered)} />
                <Stat label="Opened" value={fmtNum(data.unique_opens)} />
                <Stat label="Clicked" value={fmtNum(data.unique_clicks)} />
                <Stat label="Unsubscribed" value={fmtNum(data.unsubscribed)} />
                <Stat label="Bounced" value={fmtNum(data.bounced)} />
                <Stat label="Complaints" value={fmtNum(data.complained)} />
                <Stat label="Failed" value={fmtNum(data.failed)} />
            </div>
            <div class="progress" aria-label={`${pct}% sent`}>
                <div style={{ width: `${pct}%` }} />
            </div>
            {data.test_mode ? <div class="note">Sent in test mode: only team addresses received it.</div> : null}
            {data.error ? <ErrorNote text={data.error} /> : null}
            <p class="muted small">
                Delivered, opened, clicked and bounced counts arrive from the email provider's webhook; opens and clicks count people, once each.{' '}
                <a href={`#/analytics/post/${data.post_id}`}>See how the post did</a>
            </p>
        </div>
    );
}

export function Stat({ label, value }: { label: string; value: preact.ComponentChildren }) {
    return (
        <div class="stat">
            <span class="stat-label">{label}</span>
            <span class="stat-value">{value}</span>
        </div>
    );
}
