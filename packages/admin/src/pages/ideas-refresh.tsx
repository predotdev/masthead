import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api, session } from '../api';
import { Button, errorToast, toast } from '../ui';

/** What the server's last idea refresh did (see ideas.ts on the server). */
export interface IdeaRun {
    at: string;
    trigger: 'schedule' | 'manual';
    read: number;
    fresh: number;
    used: number;
    added: number;
    blocked: number;
    skipped?: string;
    error?: string;
    sources: { url: string; error?: string }[];
}

interface Status {
    enabled: boolean;
    hour: number;
    open: number;
    ai: boolean;
    lastRun: IdeaRun | null;
}

// Shared by the button in the page head and the line under it.
const status = signal<Status | null>(null);
const busy = signal(false);

const load = () =>
    api<Status>('/ideas/status').then(
        s => (status.value = s),
        () => {}
    );

const hourUtc = (h: number) => {
    const today = new Date();
    today.setUTCHours(h, 0, 0, 0);
    const local = today.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${String(h).padStart(2, '0')}:00 UTC (${local} your time)`;
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function describe(run: IdeaRun): string {
    const unread = (run.sources ?? []).filter(s => s.error);
    const note = unread.length ? ` Could not read ${unread[0].url} (${unread[0].error})${unread.length > 1 ? ` and ${unread.length - 1} more` : ''}.` : '';
    if (run.error) return `The last refresh (${when(run.at)}) failed: ${run.error}`;
    if (run.skipped) return `Checked ${when(run.at)}: ${run.skipped}${note}`;
    const from = run.fresh ? `from ${plural(run.fresh, 'new item', 'new items')}` : 'from the last two weeks';
    return `Last refreshed ${when(run.at)}: ${plural(run.added, 'new idea', 'new ideas')} ${from}.${note}`;
}

/** Refreshes ideas now. Editors and up. */
export function RefreshButton({ onDone }: { onDone: () => void }) {
    const role = session.value?.user.role;
    if (role !== 'owner' && role !== 'admin' && role !== 'editor') return null;
    return (
        <Button
            busy={busy.value}
            onClick={async () => {
                busy.value = true;
                try {
                    const run = await api<IdeaRun>('/ideas/refresh', { method: 'POST' });
                    if (run.error) toast(`Refresh failed: ${run.error}`, 'error');
                    else toast(run.added ? `${plural(run.added, 'new idea', 'new ideas')}` : (run.skipped ?? 'No new ideas this time'));
                    onDone();
                } catch (err) {
                    errorToast(err);
                } finally {
                    busy.value = false;
                    load();
                }
            }}
        >
            Refresh now
        </Button>
    );
}

/** When ideas arrive by themselves, and what the last refresh did. */
export function RefreshStatus() {
    useEffect(() => {
        load();
    }, []);
    const s = status.value;
    if (!s) return <p class="muted lead">Story ideas with their sources.</p>;
    const admin = session.value?.user.role === 'owner' || session.value?.user.role === 'admin';
    return (
        <p class="muted lead">
            {!s.ai ? 'Connect AI to get new ideas each day.' : s.enabled ? `New ideas arrive each day around ${hourUtc(s.hour)} from what changed in your sources.` : 'Daily ideas are off.'}{' '}
            {admin ? <a href="#/settings">Change</a> : null}
            {s.lastRun ? (
                <>
                    <br />
                    {describe(s.lastRun)}
                </>
            ) : null}
        </p>
    );
}
