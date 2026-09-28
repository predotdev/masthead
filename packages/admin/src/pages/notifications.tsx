/**
 * The notifications menu: review requests and answers, comments on your posts, replies and
 * mentions, newest first, with the unread count on the bell. Review events and mentions are
 * emailed too, unless you turn that off here.
 */
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, fmtAgo } from '../api';
import { Icon, type IconName } from '../icons';
import { Avatar, errorToast } from '../ui';

type Kind = 'review_requested' | 'review_approved' | 'review_changes' | 'mention' | 'comment' | 'reply';

interface Notice {
    id: number;
    kind: Kind;
    postId: string | null;
    postTitle: string | null;
    threadId: string | null;
    actor: { id: string | null; name: string; image: string | null };
    text: string | null;
    createdAt: string;
    read: boolean;
}

interface Notices {
    items: Notice[];
    unread: number;
    email: boolean;
}

const notices = signal<Notices | null>(null);

export async function loadNotices(): Promise<void> {
    try {
        notices.value = await api<Notices>('/notifications?limit=40');
    } catch {
        // The bell just keeps what it had; the next check tries again.
    }
}

/** Checks for new notifications every minute while the tab is in view, and when it comes back. */
export function useNotificationsPoll(on: boolean) {
    useEffect(() => {
        // Signed out: nothing of the last person's stays behind for the next one.
        if (!on) return void (notices.value = null);
        loadNotices();
        const tick = () => document.visibilityState === 'visible' && loadNotices();
        const t = setInterval(tick, 60_000);
        document.addEventListener('visibilitychange', tick);
        return () => (clearInterval(t), document.removeEventListener('visibilitychange', tick));
    }, [on]);
}

const VERB: Record<Kind, string> = {
    review_requested: 'asked you to review',
    review_approved: 'approved',
    review_changes: 'asked for changes on',
    mention: 'mentioned you on',
    comment: 'commented on',
    reply: 'replied on'
};

const KIND_ICON: Record<Kind, IconName> = { review_requested: 'userCheck', review_approved: 'checkCircle', review_changes: 'alert', mention: 'atSign', comment: 'message', reply: 'reply' };

const linkFor = (n: Notice) => (!n.postId || n.postTitle === null ? null : n.kind.startsWith('review') ? `#/edit/${n.postId}/review` : `#/edit/${n.postId}/comments/${n.threadId}`);

async function markRead(body: { ids?: number[]; all?: boolean }) {
    const now = notices.value;
    if (now) {
        const ids = new Set(body.ids ?? []);
        const items = now.items.map(n => (body.all || ids.has(n.id) ? { ...n, read: true } : n));
        notices.value = { ...now, items, unread: body.all ? 0 : Math.max(0, now.unread - now.items.filter(n => !n.read && ids.has(n.id)).length) };
    }
    await api('/notifications/read', { body }).catch(errorToast);
}

/** The bell and its menu. In the sidebar it opens beside it; on phones, under the top bar. */
export function NotificationsButton({ rail, phone }: { rail?: boolean; phone?: boolean }) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const box = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const data = notices.value;
    const unread = data?.unread ?? 0;

    // The menu is fixed to the window so the sidebar never clips it.
    useLayoutEffect(() => {
        if (!open || phone) return;
        const place = () => {
            const r = button.current!.getBoundingClientRect();
            const width = 380;
            setPos(rail ? { top: Math.max(8, r.top - 6), left: r.right + 10 } : { top: r.bottom + 8, left: Math.min(r.left, window.innerWidth - width - 8) });
        };
        place();
        window.addEventListener('resize', place);
        return () => window.removeEventListener('resize', place);
    }, [open, rail, phone]);
    useEffect(() => {
        if (!open) return;
        loadNotices();
        const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            setOpen(false);
            button.current?.focus();
        };
        document.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        window.addEventListener('hashchange', () => setOpen(false), { once: true });
        return () => (document.removeEventListener('mousedown', onDown), window.removeEventListener('keydown', onKey));
    }, [open]);

    const label = unread ? `Notifications, ${unread} unread` : 'Notifications';
    return (
        <div class={`notif${phone ? ' phone' : ''}`} ref={box}>
            <button
                ref={button}
                type="button"
                class={`icon-btn notif-btn${open ? ' on' : ''}`}
                aria-label={label}
                aria-expanded={open}
                aria-haspopup="dialog"
                data-tooltip={open ? undefined : label}
                data-tooltip-side={rail ? 'right' : undefined}
                onClick={() => setOpen(!open)}
            >
                <Icon name="bell" size={phone ? 18 : 16} />
                {unread ? <span class="notif-badge">{unread > 99 ? '99+' : unread}</span> : null}
            </button>
            {open ? (
                <div class="notif-pop" role="dialog" aria-label="Notifications" style={phone || !pos ? undefined : { top: `${pos.top}px`, left: `${pos.left}px` }}>
                    <div class="notif-head">
                        <span class="notif-title">Notifications</span>
                        {unread ? (
                            <button type="button" class="link-btn notif-all" onClick={() => markRead({ all: true })}>
                                Mark all as read
                            </button>
                        ) : null}
                    </div>
                    <div class="notif-list">
                        {!data ? (
                            <p class="notif-empty-text">Loading…</p>
                        ) : data.items.length ? (
                            data.items.map(n => <Item key={n.id} n={n} close={() => setOpen(false)} />)
                        ) : (
                            <div class="notif-empty">
                                <span class="notif-empty-icon" aria-hidden="true">
                                    <Icon name="bell" size={18} />
                                </span>
                                <p class="notif-empty-title">You’re all caught up</p>
                                <p class="notif-empty-text">Review requests, answers, comments on your posts and mentions show up here.</p>
                            </div>
                        )}
                    </div>
                    {data ? (
                        <label class="notif-foot">
                            <input
                                type="checkbox"
                                checked={data.email}
                                onChange={async e => {
                                    const email = e.currentTarget.checked;
                                    notices.value = { ...data, email };
                                    await api('/notifications/settings', { method: 'PUT', body: { email } }).catch(err => (errorToast(err), (notices.value = { ...data })));
                                }}
                            />
                            <span>Also email me review requests, answers and mentions</span>
                        </label>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function Item({ n, close }: { n: Notice; close: () => void }) {
    const href = linkFor(n);
    const body = (
        <>
            <span class="notif-avatar">
                <Avatar name={n.actor.name} src={n.actor.image} size={30} />
                <span class={`notif-kind k-${n.kind}`} aria-hidden="true">
                    <Icon name={KIND_ICON[n.kind]} size={10} />
                </span>
            </span>
            <span class="notif-body">
                <span class="notif-text">
                    <strong>{n.actor.name}</strong> {VERB[n.kind]} <strong>{n.postTitle === null ? 'a deleted post' : n.postTitle.trim() || 'Untitled'}</strong>
                </span>
                {n.text ? <span class="notif-quote">{n.text}</span> : null}
                <time class="notif-when" dateTime={n.createdAt} title={new Date(n.createdAt).toLocaleString()}>
                    {fmtAgo(n.createdAt)}
                </time>
            </span>
            {n.read ? null : <span class="notif-dot" aria-label="Unread" />}
        </>
    );
    const read = () => !n.read && markRead({ ids: [n.id] });
    return href ? (
        <a class={`notif-item${n.read ? '' : ' unread'}`} href={href} onClick={() => (read(), close())}>
            {body}
        </a>
    ) : (
        <div class={`notif-item${n.read ? '' : ' unread'}`} onClick={read}>
            {body}
        </div>
    );
}
