import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { Button, errorToast, toast } from '../ui';

/** The team's AI memory and the state of the knowledge index. Kept apart from the editor so Settings doesn't load it. */
export function MemoryPanel() {
    const [items, setItems] = useState<{ id: string; text: string; by?: string }[] | null>(null);
    const [text, setText] = useState('');
    const [stats, setStats] = useState<{ passages: number; pending: number; sources: number; refreshedAt: string | null } | null>(null);
    useEffect(() => {
        api<{ id: string; text: string }[]>('/ai/memory').then(setItems, errorToast);
        api('/ai/knowledge').then(setStats, () => {});
    }, []);
    return (
        <div class="memory">
            <p class="muted small">Facts and rules every AI answer follows, for everyone on the team.</p>
            <form
                class="row"
                onSubmit={async e => {
                    e.preventDefault();
                    if (!text.trim()) return;
                    try {
                        setItems(await api('/ai/memory', { body: { text } }));
                        setText('');
                    } catch (err) {
                        errorToast(err);
                    }
                }}
            >
                <input value={text} onInput={e => setText(e.currentTarget.value)} placeholder="e.g. Always write the product name in lowercase" />
                <Button type="submit">Add</Button>
            </form>
            <ul class="memory-list">
                {(items ?? []).map(m => (
                    <li key={m.id}>
                        <span>{m.text}</span>
                        <button class="icon-btn" title="Forget" onClick={async () => setItems(await api(`/ai/memory/${m.id}`, { method: 'DELETE' }))}>
                            ×
                        </button>
                    </li>
                ))}
            </ul>
            {stats ? (
                <p class="muted small">
                    Knowledge: {stats.passages.toLocaleString()} passages from {stats.sources} sources{stats.pending ? `, ${stats.pending} still being read` : ''}.{' '}
                    <button
                        class="link-btn"
                        onClick={async () => {
                            try {
                                const r = await api<{ queued: number }>('/ai/knowledge/refresh', { method: 'POST' });
                                toast(r.queued ? `Reading ${r.queued} new passages` : 'Already up to date');
                                setStats(await api('/ai/knowledge'));
                            } catch (err) {
                                errorToast(err);
                            }
                        }}
                    >
                        Refresh
                    </button>
                </p>
            ) : null}
        </div>
    );
}
