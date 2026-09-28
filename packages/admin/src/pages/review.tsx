/**
 * Review before publishing, in the editor: the status in the bar, and the review panel beside the
 * post (who was asked, their answers, and the comments). Reviewers approve or ask for changes there.
 */
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { api, fmtAgo, fmtSince, type Post } from '../api';
import { Icon } from '../icons';
import { Avatar, Button, Skeleton, errorToast, toast, useLoad } from '../ui';
import { CommentsSection, type CommentsApi } from './comments';
import { REVIEW_LABEL, REVIEW_TONE, ROLE_NAME, type Person, type ReviewStatus } from './review-status';

type ReviewerState = 'pending' | 'approved' | 'changes_requested';

interface Reviewer extends Person {
    state: ReviewerState;
    note: string | null;
    decidedAt: string | null;
    /** Approved an earlier version of the text. */
    stale: boolean;
}

interface ReviewData {
    status: ReviewStatus | null;
    requestedBy: { id: string | null; name: string } | null;
    requestedAt: string | null;
    note: string | null;
    reviewers: Reviewer[];
    editedSinceApproval: boolean;
    requireApproval: boolean;
    /** Who could review it (everyone who can open it, but you). */
    people: Person[];
    /** Why you cannot publish it yet, when approval is required. */
    blocked: null | 'none' | ReviewStatus;
    me: string;
}

export interface ReviewApi {
    data: ReviewData | null;
    /** You, when you were asked to review it. */
    mine: Reviewer | null;
    /** Approval stands between you and publishing. */
    blocked: boolean;
    reload: () => void;
    request: (reviewers: string[], note: string | null, restart?: boolean) => Promise<void>;
    decide: (decision: 'approved' | 'changes_requested', note: string) => Promise<void>;
    withdraw: () => Promise<void>;
}

const STATE_LABEL: Record<ReviewerState, string> = { pending: 'Waiting', approved: 'Approved', changes_requested: 'Changes requested' };

/** Set before opening the panel from "Send for review", so it opens on the reviewer picker. */
const pickReviewers = signal(false);

export function useReview(post: Post): ReviewApi {
    const { data, reload } = useLoad(() => api<ReviewData>(`/posts/${post.id}/review`), [post.id, post.status]);
    // Reviewers answer while you write: look again now and then, and when the tab comes back.
    useEffect(() => {
        const tick = () => document.visibilityState === 'visible' && reload();
        const t = setInterval(tick, 30_000);
        document.addEventListener('visibilitychange', tick);
        return () => (clearInterval(t), document.removeEventListener('visibilitychange', tick));
    }, [reload]);
    // A save can make an approval stale: look again once it lands.
    const approvals = data?.reviewers.some(r => r.state === 'approved');
    useEffect(() => {
        if (approvals) reload();
    }, [post.updatedAt]);
    const mine = data?.reviewers.find(r => r.id === data.me) ?? null;
    return {
        data,
        mine,
        blocked: !!data?.blocked,
        reload,
        async request(reviewers, note, restart = false) {
            await api(`/posts/${post.id}/review`, { body: { reviewers, note, restart } });
            await reload();
        },
        async decide(decision, note) {
            await api(`/posts/${post.id}/review/decision`, { body: { decision, note } });
            await reload();
        },
        async withdraw() {
            await api(`/posts/${post.id}/review`, { method: 'DELETE' });
            await reload();
        }
    };
}

/** The review's status in the editor bar; it opens the review panel. */
export function ReviewPill({ review, onClick }: { review: ReviewApi; onClick: () => void }) {
    const d = review.data;
    if (!d?.status) return null;
    const waiting = d.status === 'in_review' && review.mine?.state === 'pending';
    const approved = d.reviewers.filter(r => r.state === 'approved').length;
    const label = waiting ? 'Needs your review' : d.status === 'in_review' && d.reviewers.length > 1 ? `In review, ${approved} of ${d.reviewers.length} approved` : REVIEW_LABEL[d.status];
    return (
        <button type="button" class={`pill ${REVIEW_TONE[d.status]} review-pill${waiting ? ' is-yours' : ''}`} onClick={onClick} title="Open the review">
            {label}
            {d.status === 'approved' && d.editedSinceApproval ? <span class="review-pill-extra">edited since</span> : null}
        </button>
    );
}

/**
 * The review's button in the editor bar. `primary` when it stands in for Publish: for contributors,
 * and while approval is required and missing.
 */
export function ReviewCta({ review, primary, onOpen }: { review: ReviewApi; primary?: boolean; onOpen: () => void }) {
    const d = review.data;
    if (!d) return null;
    const open = (pick = false) => {
        pickReviewers.value = pick;
        onOpen();
    };
    if (!d.status)
        return (
            <Button tone={primary ? 'primary' : 'ghost'} icon={primary ? undefined : 'userCheck'} onClick={() => open(true)}>
                Send for review
            </Button>
        );
    if (!primary) return null;
    if (review.mine?.state === 'pending' && d.status === 'in_review')
        return (
            <Button tone="primary" onClick={() => open()}>
                Review
            </Button>
        );
    if (d.status === 'changes_requested')
        return (
            <Button tone="primary" onClick={() => open()}>
                Send for review again
            </Button>
        );
    if (d.status === 'in_review')
        return (
            <Button tone="primary" disabled data-tooltip="An approval lets you publish">
                Waiting for approval
            </Button>
        );
    return null;
}

/** The panel beside the post: the review (until the post is live), then the comments. */
export function ReviewPanel({ review, comments, live }: { review: ReviewApi; comments: CommentsApi; live: boolean }) {
    return (
        <aside class="settings-panel review-panel" aria-label="Review and comments">
            {live ? null : <ReviewSection review={review} />}
            <CommentsSection comments={comments} />
        </aside>
    );
}

function ReviewSection({ review }: { review: ReviewApi }) {
    const d = review.data;
    const [picking, setPicking] = useState(pickReviewers.value);
    const [busy, setBusy] = useState<string | null>(null);
    useEffect(() => {
        if (pickReviewers.value) setPicking(true);
        pickReviewers.value = false;
    }, [pickReviewers.value]);

    const run = async (what: string, fn: () => Promise<void>, done?: string) => {
        setBusy(what);
        try {
            await fn();
            if (done) toast(done);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(null);
        }
    };

    if (!d)
        return (
            <section class="rv">
                <Skeleton width="40%" height={12} />
                <Skeleton width="80%" />
            </section>
        );
    if (picking) return <ReviewerPicker review={review} onDone={() => setPicking(false)} />;
    if (!d.status)
        return (
            <section class="rv">
                <div class="rv-head">
                    <h3>Review</h3>
                </div>
                <p class="rv-lead">{d.requireApproval ? 'Posts need a reviewer’s approval before they go out. Ask a teammate to read this one.' : 'Ask teammates to read it before it goes out.'}</p>
                <Button size="sm" icon="userCheck" onClick={() => setPicking(true)}>
                    Send for review
                </Button>
            </section>
        );

    const asker = d.requestedBy?.id === d.me ? 'You' : (d.requestedBy?.name ?? 'Someone');
    const mine = review.mine;
    return (
        <section class={`rv is-${d.status}`}>
            <div class="rv-head">
                <h3>Review</h3>
                <span class={`pill ${REVIEW_TONE[d.status]} review-pill`}>{REVIEW_LABEL[d.status]}</span>
            </div>
            <p class="rv-meta">
                {asker} asked <time title={d.requestedAt ? new Date(d.requestedAt).toLocaleString() : ''}>{fmtSince(d.requestedAt)}</time>
                {d.status === 'approved' && !d.editedSinceApproval ? (d.requireApproval ? '. Ready to publish.' : '. Ready to go.') : ''}
            </p>
            {d.note ? <p class="rv-note">{d.note}</p> : null}
            <ul class="rv-people">
                {d.reviewers.map(r => (
                    <li key={r.id} class={`rv-person is-${r.state}`}>
                        <Avatar name={r.name} src={r.profileImage} size={26} />
                        <div class="rv-person-main">
                            <div class="rv-person-line">
                                <span class="rv-name">{r.id === d.me ? 'You' : r.name}</span>
                                <span class={`rv-state is-${r.state}`}>
                                    {r.state === 'approved' ? <Icon name="check" size={12} /> : r.state === 'changes_requested' ? <Icon name="alert" size={12} /> : <Icon name="clock" size={12} />}
                                    {STATE_LABEL[r.state]}
                                </span>
                            </div>
                            {r.note ? <p class="rv-person-note">{r.note}</p> : null}
                            {r.decidedAt ? (
                                <span class="rv-when">
                                    {fmtAgo(r.decidedAt)}
                                    {r.stale ? <span class="rv-stale">, before the latest edits</span> : null}
                                </span>
                            ) : null}
                        </div>
                    </li>
                ))}
            </ul>
            {d.status === 'approved' && d.editedSinceApproval ? (
                <p class="rv-warn">
                    <Icon name="warning" size={14} /> The text changed after it was approved.
                </p>
            ) : null}
            {mine ? <Decision review={review} mine={mine} /> : null}
            {/* Reviewers answer; the rest of the team runs the review. */}
            {mine ? null : (
                <div class="rv-manage">
                    {d.status === 'changes_requested' || (d.status === 'approved' && d.editedSinceApproval) ? (
                        <Button size="sm" tone={d.status === 'changes_requested' ? 'primary' : 'ghost'} busy={busy === 'again'} onClick={() => run('again', () => review.request(d.reviewers.map(r => r.id), d.note, true), 'Sent for review again')}>
                            Send for review again
                        </Button>
                    ) : null}
                    <div class="rv-links">
                        <Button size="sm" tone="plain" onClick={() => setPicking(true)}>
                            Change reviewers
                        </Button>
                        <Button
                            size="sm"
                            tone="plain"
                            busy={busy === 'withdraw'}
                            onClick={() => window.confirm('Withdraw the review? Reviewers’ answers are cleared.') && run('withdraw', review.withdraw, 'Review withdrawn')}
                        >
                            Withdraw
                        </Button>
                    </div>
                </div>
            )}
        </section>
    );
}

/** Your answer as a reviewer: approve, or say what should change. */
function Decision({ review, mine }: { review: ReviewApi; mine: Reviewer }) {
    const [changing, setChanging] = useState(false);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    if (mine.state !== 'pending' && !changing)
        return (
            <p class="rv-yours">
                You {mine.state === 'approved' ? 'approved it' : 'asked for changes'} {fmtSince(mine.decidedAt)}.{' '}
                <button type="button" class="link-btn" onClick={() => setChanging(true)}>
                    Change your answer
                </button>
            </p>
        );
    const answer = async (decision: 'approved' | 'changes_requested') => {
        setBusy(decision);
        try {
            await review.decide(decision, note);
            toast(decision === 'approved' ? 'Approved' : 'Changes requested');
            setNote('');
            setChanging(false);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(null);
        }
    };
    return (
        <div class="rv-decide">
            <p class="rv-decide-title">Your review</p>
            <textarea rows={3} value={note} onInput={e => setNote(e.currentTarget.value)} placeholder="Add a note. Say what to change if it needs changes." aria-label="Note for the writer" />
            <div class="rv-actions">
                {changing ? (
                    <Button size="sm" tone="plain" onClick={() => setChanging(false)}>
                        Cancel
                    </Button>
                ) : null}
                <Button size="sm" busy={busy === 'changes_requested'} disabled={!note.trim() || !!busy} onClick={() => answer('changes_requested')} title={note.trim() ? undefined : 'Write what should change first'}>
                    Request changes
                </Button>
                <Button size="sm" tone="primary" icon="check" busy={busy === 'approved'} disabled={!!busy} onClick={() => answer('approved')}>
                    Approve
                </Button>
            </div>
        </div>
    );
}

function ReviewerPicker({ review, onDone }: { review: ReviewApi; onDone: () => void }) {
    const d = review.data!;
    const [chosen, setChosen] = useState<string[]>(d.reviewers.map(r => r.id).filter(id => id !== d.me));
    const [note, setNote] = useState(d.status ? (d.note ?? '') : '');
    const [busy, setBusy] = useState(false);
    const ongoing = d.status === 'in_review';
    const toggle = (id: string) => setChosen(c => (c.includes(id) ? c.filter(x => x !== id) : [...c, id]));
    const send = async () => {
        setBusy(true);
        try {
            await review.request(chosen, note.trim() || null);
            toast(ongoing ? 'Reviewers updated' : chosen.length === 1 ? `Sent to ${d.people.find(p => p.id === chosen[0])?.name ?? 'the reviewer'}` : `Sent to ${chosen.length} reviewers`);
            onDone();
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };
    return (
        <section class="rv">
            <div class="rv-head">
                <h3>{ongoing ? 'Reviewers' : 'Send for review'}</h3>
            </div>
            <p class="rv-lead">{ongoing ? 'Answers already given are kept.' : 'Who should read it? They get a notification and an email.'}</p>
            {d.people.length ? (
                <ul class="rv-pick" role="group" aria-label="Reviewers">
                    {d.people.map(p => (
                        <li key={p.id}>
                            <label class={`rv-pick-row${chosen.includes(p.id) ? ' on' : ''}`}>
                                <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
                                <Avatar name={p.name} src={p.profileImage} size={24} />
                                <span class="rv-name">{p.name}</span>
                                <span class="rv-role">{ROLE_NAME[p.role]}</span>
                            </label>
                        </li>
                    ))}
                </ul>
            ) : (
                <p class="rv-lead">Nobody else can open this post. Editors, admins and the owner can review any post.</p>
            )}
            <textarea rows={3} value={note} onInput={e => setNote(e.currentTarget.value)} placeholder="Anything they should look at? Optional." aria-label="Note for the reviewers" />
            <div class="rv-actions">
                <Button size="sm" tone="plain" onClick={onDone}>
                    Cancel
                </Button>
                <Button size="sm" tone="primary" busy={busy} disabled={!chosen.length} onClick={send}>
                    {ongoing ? 'Save reviewers' : 'Send for review'}
                </Button>
            </div>
        </section>
    );
}
