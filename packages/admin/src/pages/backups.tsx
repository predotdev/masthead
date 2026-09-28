import { useState } from 'preact/hooks';
import { api, fmtNum } from '../api';
import { Button, Pill, Skeleton, errorToast, toast, useLoad } from '../ui';

interface BackupRun {
    date: string;
    trigger: 'nightly' | 'manual';
    finishedAt: string;
    ms: number;
    tables: number;
    rows: number;
    bytes: number;
}

interface BackupsData {
    last: BackupRun | null;
    failed: { date: string; at: string; error: string } | null;
    running: boolean;
    schedule: { hour: number; minute: number; keepDaily: number; keepMonthly: number };
    backups: { date: string; complete: boolean; bytes: number }[];
}

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** A backup's date (YYYY-MM-DD, UTC) as a day, the same wherever the reader is. */
const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Settings, Backups: the last nightly copy of the database, the copies kept, and "Back up now". */
export function BackupsPanel() {
    const { data, error, reload } = useLoad(() => api<BackupsData>('/backups'), []);
    const [busy, setBusy] = useState(false);
    const backUp = async () => {
        setBusy(true);
        try {
            const run = await api<BackupRun>('/backups', { method: 'POST' });
            toast(`Backed up ${fmtNum(run.rows)} rows in ${(run.ms / 1000).toFixed(1)} s`);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
            reload();
        }
    };
    const s = data?.schedule;
    const at = s ? `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')} UTC` : '';
    const kept = data?.backups.filter(b => b.complete) ?? [];
    return (
        <section class="panel backups" id="settings-backups">
            <div class="row between">
                <h2>Backups</h2>
                <Button busy={busy || !!data?.running} onClick={backUp}>
                    Back up now
                </Button>
            </div>
            <p class="muted small">
                Every night{at ? ` at ${at}` : ''} the whole database is copied to storage. The newest {s?.keepDaily ?? 30} copies and one a month for a year are kept. To undo a
                mistake from the last 30 days, D1 Time Travel puts the database back to any minute; these copies are the long-term record, restored with <code>masthead restore</code>.
            </p>
            {error ? <div class="note error">{error}</div> : null}
            {data?.failed ? (
                <div class="note error">
                    The backup at {when(data.failed.at)} failed: {data.failed.error}
                </div>
            ) : null}
            {data ? (
                <dl class="facts">
                    <dt>Last backup</dt>
                    <dd>
                        {data.last ? `${when(data.last.finishedAt)} · ${fmtNum(data.last.rows)} rows, ${data.last.tables} tables · ${size(data.last.bytes)}` : 'None yet'}
                        {data.running ? (
                            <Pill tone="blue" dot>
                                Backing up now
                            </Pill>
                        ) : null}
                    </dd>
                    <dt>Copies kept</dt>
                    <dd>{kept.length ? `${kept.length} · ${size(kept.reduce((n, b) => n + b.bytes, 0))} · oldest ${day(kept[kept.length - 1].date)}` : 'None yet'}</dd>
                    <dt>Where</dt>
                    <dd>
                        <code>backups/</code> in this site's storage bucket, one folder a day
                    </dd>
                </dl>
            ) : (
                <Skeleton width="60%" />
            )}
        </section>
    );
}
