/**
 * Backups. Every night at 02:30 UTC the minute cron copies every table to R2
 * as gzipped JSON lines, backups/YYYY-MM-DD/<table>.jsonl.gz, and writes
 * manifest.json (row counts, schema version) last: a folder with a manifest
 * is a complete copy. The newest 30 copies and the first copy of each of the
 * last 12 months are kept. Settings shows the last one and "Back up now".
 *
 * D1 Time Travel is the fast way back (any minute of the last 30 days, in
 * place). These copies are the long-term record: `masthead restore` loads one
 * into an empty database through the restore routes below.
 */
import { atLeast } from './auth';
import { getSetting, setSetting } from './content';
import { dataStatements, schemaVersion } from './db';
import type { Ctx, Env, Principal } from './env';
import { rebuildIndex } from './knowledge';
import { SITE_PREFIX, edgeCache, edgeKey, publishSite } from './publish';
import type { Router } from './router';
import { HttpError, body, hex, json, now, randomToken } from './util';

export const BACKUP_PREFIX = 'backups/';
/** When the nightly backup runs, UTC. */
export const BACKUP_AT = { hour: 2, minute: 30 };
export const KEEP_DAILY = 30;
export const KEEP_MONTHLY = 12;
const MANIFEST = 'manifest.json';
const FORMAT = 'masthead.backup/1';
/** Longer than a cron run may last (15 minutes); renewed after every table. */
const LEASE_MS = 20 * 60_000;
/** A failed nightly backup is tried again 15 minutes later, four times a day at most. */
const RETRY_MS = 15 * 60_000;
const MAX_TRIES = 4;
/** About this much JSON per read: pages shrink for large rows (post bodies) and grow for small ones. */
const PAGE_BYTES = 4_000_000;
const MAX_PAGE_ROWS = 20_000;
/** R2 multipart parts: all but the last the same size, at least 5 MiB. */
const PART_BYTES = 8 * 1024 * 1024;
/** Never restored: the target keeps its own migration history. */
const NOT_RESTORED = new Set(['schema_migrations']);
/** Settings about this server rather than the site (its own backups and cron): a restore leaves them alone. */
const LOCAL_SETTINGS = new Set(['backup', 'backup_lease', 'restore', 'cron_heartbeat']);
const ROWID = '_masthead_rowid';

export interface BackupTable {
    name: string;
    file: string;
    rows: number;
    /** Size of the gzipped file. */
    bytes: number;
}

export interface BackupManifest {
    format: typeof FORMAT;
    date: string;
    trigger: 'nightly' | 'manual';
    startedAt: string;
    finishedAt: string;
    /** The last migration the database had. */
    schemaVersion: number;
    tables: BackupTable[];
    /** The CREATE statements, for reference. */
    schema: { type: string; name: string; sql: string }[];
}

/** One finished backup, as Settings and the health check show it. */
export interface BackupRun {
    date: string;
    trigger: BackupManifest['trigger'];
    startedAt: string;
    finishedAt: string;
    ms: number;
    tables: number;
    rows: number;
    bytes: number;
}

export interface BackupState {
    last: BackupRun | null;
    /** The last failure since then. */
    failed: { date: string; at: string; error: string; tries: number } | null;
}

export interface BackupFolder {
    date: string;
    complete: boolean;
    files: number;
    bytes: number;
}

export async function backupState(db: D1Database): Promise<BackupState> {
    const s = await getSetting<Partial<BackupState> | null>(db, 'backup', null);
    return { last: s?.last ?? null, failed: s?.failed ?? null };
}

// ------------------------------------------------------------------ making one

/** Copies every table to R2 now. A 409 while another backup runs. */
export async function runBackup(env: Env, db: D1Database, trigger: BackupRun['trigger']): Promise<BackupRun> {
    // Half-restored rows are not worth keeping, and today's copy may be the one being read.
    if (await restoring(db)) throw new HttpError(409, 'A restore is in progress. Back up once it has finished.');
    let lease = await claim(db);
    if (!lease) throw new HttpError(409, 'A backup is running now. Try again in a few minutes.');
    const t0 = Date.now();
    const startedAt = now();
    const date = startedAt.slice(0, 10);
    const folder = `${BACKUP_PREFIX}${date}/`;
    try {
        // Only a finished copy has a manifest. Today's goes first, so a copy stopped halfway never looks whole.
        await env.BUCKET.delete(`${folder}${MANIFEST}`);
        const { tables, schema } = await describe(db);
        const version = await schemaVersion(db);
        const entries: BackupTable[] = [];
        for (const table of tables) {
            const file = fileName(table.name);
            entries.push({ name: table.name, file, ...(await exportTable(db, env.BUCKET, `${folder}${file}`, table)) });
            lease = await renew(db, lease);
        }
        // Files an earlier copy made today and this one did not (a table dropped since) don't belong to it.
        const mine = new Set([...entries.map(e => e.file), MANIFEST]);
        const leftover = (await listKeys(env.BUCKET, folder)).filter(key => !mine.has(key.slice(folder.length)));
        if (leftover.length) await env.BUCKET.delete(leftover);
        const manifest: BackupManifest = { format: FORMAT, date, trigger, startedAt, finishedAt: now(), schemaVersion: version, tables: entries, schema };
        await env.BUCKET.put(`${folder}${MANIFEST}`, JSON.stringify(manifest, null, 1), { httpMetadata: { contentType: 'application/json' } });
        const run: BackupRun = {
            date,
            trigger,
            startedAt,
            finishedAt: manifest.finishedAt,
            ms: Date.now() - t0,
            tables: entries.length,
            rows: entries.reduce((n, e) => n + e.rows, 0),
            bytes: entries.reduce((n, e) => n + e.bytes, 0)
        };
        await setSetting(db, 'backup', { last: run, failed: null } satisfies BackupState);
        await prune(env.BUCKET).catch(err => console.error('removing old backups failed', err));
        return run;
    } catch (err) {
        const state = await backupState(db).catch((): BackupState => ({ last: null, failed: null }));
        const tries = state.failed?.date === date ? state.failed.tries + 1 : 1;
        const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        await setSetting(db, 'backup', { ...state, failed: { date, at: now(), error, tries } } satisfies BackupState).catch(() => {});
        throw err;
    } finally {
        await release(db, lease).catch(() => {});
    }
}

/**
 * From the minute cron: the night's backup once BACKUP_AT has passed and none
 * has started since. A failed one is tried again every RETRY_MS, MAX_TRIES times.
 */
export async function scheduledBackup(env: Env, db: D1Database, at: Date): Promise<void> {
    const due = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), BACKUP_AT.hour, BACKUP_AT.minute);
    if (at.getTime() < due) return;
    const { last, failed } = await backupState(db);
    if (last && Date.parse(last.startedAt) >= due) return;
    if (failed && Date.parse(failed.at) >= due && (failed.tries >= MAX_TRIES || at.getTime() - Date.parse(failed.at) < RETRY_MS)) return;
    try {
        const run = await runBackup(env, db, 'nightly');
        console.log(`backup ${run.date}: ${run.tables} tables, ${run.rows} rows, ${run.bytes} bytes in ${run.ms} ms`);
    } catch (err) {
        if (!(err instanceof HttpError && err.status === 409)) console.error('backup failed', err);
    }
}

interface TableInfo {
    name: string;
    /** False for WITHOUT ROWID tables, which are read in key order instead. */
    rowid: boolean;
}

const internal = (name: string) => name.startsWith('sqlite_') || name.startsWith('_cf_');
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Every table but SQLite's and D1's own, and the statements that made them. */
async function describe(db: D1Database): Promise<{ tables: TableInfo[]; schema: BackupManifest['schema'] }> {
    const { results } = await db.prepare('PRAGMA table_list').all<{ schema: string; name: string; type: string; wr: number }>();
    const tables = results
        .filter(t => t.schema === 'main' && (t.type === 'table' || t.type === 'virtual') && !internal(t.name))
        .map(t => ({ name: t.name, rowid: !t.wr }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    const { results: schema } = await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type <> 'table', name").all<{ type: string; name: string; sql: string }>();
    return { tables, schema: schema.filter(s => !internal(s.name)) };
}

function fileName(table: string): string {
    return /^\w+$/.test(table) ? `${table}.jsonl.gz` : `table-${hex(new TextEncoder().encode(table))}.jsonl.gz`;
}

/** Streams one table into a gzipped JSON-lines object, a page at a time, so memory stays flat. */
async function exportTable(db: D1Database, bucket: R2Bucket, key: string, table: TableInfo): Promise<{ rows: number; bytes: number }> {
    const name = quote(table.name);
    let rows = 0;
    let limit = 50;
    let after: number | null = null;
    const bytes = await gzipTo(bucket, key, async write => {
        for (;;) {
            const query = !table.rowid
                ? db.prepare(`SELECT * FROM ${name} LIMIT ? OFFSET ?`).bind(limit, rows)
                : after === null
                  ? db.prepare(`SELECT rowid AS ${ROWID}, * FROM ${name} ORDER BY rowid LIMIT ?`).bind(limit)
                  : db.prepare(`SELECT rowid AS ${ROWID}, * FROM ${name} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(after, limit);
            const { results } = await query.all<Record<string, unknown>>();
            let text = '';
            for (const row of results) {
                if (table.rowid) {
                    after = Number(row[ROWID]);
                    delete row[ROWID];
                }
                text += `${JSON.stringify(row, blobs)}\n`;
            }
            if (text) await write(text);
            rows += results.length;
            if (results.length < limit) return;
            limit = Math.max(10, Math.min(MAX_PAGE_ROWS, Math.floor((PAGE_BYTES * results.length) / text.length)));
        }
    });
    return { rows, bytes };
}

/** BLOB values (D1 returns them as arrays of bytes) travel as base64. */
function blobs(_key: string, value: unknown): unknown {
    if (Array.isArray(value)) return { $blob: base64(Uint8Array.from(value as number[])) };
    if (value instanceof ArrayBuffer) return { $blob: base64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) return { $blob: base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    return value;
}

function base64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/** A value from a backup line, as D1 takes it. */
function fromLine(value: unknown): unknown {
    if (value && typeof value === 'object' && typeof (value as { $blob?: unknown }).$blob === 'string') {
        return Uint8Array.from(atob((value as { $blob: string }).$blob), c => c.charCodeAt(0));
    }
    if (value !== null && typeof value === 'object') throw new HttpError(400, 'A column value is an object: this is not a backup line.');
    return value ?? null;
}

/**
 * Gzips what `produce` writes into one R2 object: a single put when it is small,
 * a multipart upload once it outgrows a part, so a table of any size fits in memory.
 */
async function gzipTo(bucket: R2Bucket, key: string, produce: (write: (text: string) => Promise<void>) => Promise<void>): Promise<number> {
    const gzip = new CompressionStream('gzip');
    const writer = gzip.writable.getWriter();
    const encoder = new TextEncoder();
    const httpMetadata = { contentType: 'application/gzip' };
    let upload = null as R2MultipartUpload | null;
    const parts: R2UploadedPart[] = [];
    const queue: Uint8Array[] = [];
    let queued = 0;
    let total = 0;
    const take = (n: number): Uint8Array => {
        const out = new Uint8Array(n);
        for (let at = 0; at < n; ) {
            const head = queue[0];
            const k = Math.min(head.length, n - at);
            out.set(head.subarray(0, k), at);
            at += k;
            if (k === head.length) queue.shift();
            else queue[0] = head.subarray(k);
        }
        queued -= n;
        return out;
    };
    const reading = (async () => {
        const reader = gzip.readable.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            queue.push(value);
            queued += value.length;
            total += value.length;
            while (queued >= PART_BYTES) {
                upload ??= await bucket.createMultipartUpload(key, { httpMetadata });
                parts.push(await upload.uploadPart(parts.length + 1, take(PART_BYTES)));
            }
        }
    })();
    // A failed upload stops the writer too, so produce() never waits on a reader that is gone.
    reading.catch(err => writer.abort(err).catch(() => {}));
    try {
        await produce(text => writer.write(encoder.encode(text)));
        await writer.close();
        await reading;
        const rest = take(queued);
        if (!upload) await bucket.put(key, rest, { httpMetadata });
        else {
            if (rest.length) parts.push(await upload.uploadPart(parts.length + 1, rest));
            await upload.complete(parts);
        }
        return total;
    } catch (err) {
        await writer.abort(err).catch(() => {});
        await reading.catch(() => {});
        await upload?.abort().catch(() => {});
        throw err;
    }
}

// ------------------------------------------------------------------ one at a time

/** Takes the backup lease. Returns its expiry, or null when another backup holds it. */
async function claim(db: D1Database): Promise<string | null> {
    const until = new Date(Date.now() + LEASE_MS).toISOString();
    const res = await db
        .prepare(
            "INSERT INTO settings (key, value) VALUES ('backup_lease', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE json_extract(settings.value, '$') IS NULL OR json_extract(settings.value, '$') < ?"
        )
        .bind(JSON.stringify(until), now())
        .run();
    return res.meta.changes ? until : null;
}

async function renew(db: D1Database, lease: string): Promise<string> {
    const until = new Date(Date.now() + LEASE_MS).toISOString();
    const res = await db.prepare("UPDATE settings SET value = ? WHERE key = 'backup_lease' AND value = ?").bind(JSON.stringify(until), JSON.stringify(lease)).run();
    if (!res.meta.changes) throw new Error('Another backup took over.');
    return until;
}

async function release(db: D1Database, lease: string): Promise<void> {
    await db.prepare("UPDATE settings SET value = 'null' WHERE key = 'backup_lease' AND value = ?").bind(JSON.stringify(lease)).run();
}

// ------------------------------------------------------------------ keeping them

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        keys.push(...page.objects.map(o => o.key));
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
}

/** Every backup folder in storage, newest first. */
export async function listBackups(bucket: R2Bucket): Promise<(BackupFolder & { keys: string[] })[]> {
    const folders = new Map<string, BackupFolder & { keys: string[] }>();
    let cursor: string | undefined;
    do {
        const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor, limit: 1000 });
        for (const o of page.objects) {
            const m = /^backups\/(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(o.key);
            if (!m) continue;
            const f = folders.get(m[1]) ?? { date: m[1], complete: false, files: 0, bytes: 0, keys: [] };
            f.keys.push(o.key);
            f.files++;
            f.bytes += o.size;
            if (m[2] === MANIFEST) f.complete = true;
            folders.set(m[1], f);
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return [...folders.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Keeps the newest KEEP_DAILY copies and the first copy of each of the last
 * KEEP_MONTHLY months. Older copies go, and so do unfinished ones older than
 * the newest copy. Returns the dates removed.
 */
export async function prune(bucket: R2Bucket): Promise<string[]> {
    const folders = await listBackups(bucket);
    const complete = folders.filter(f => f.complete).map(f => f.date);
    if (!complete.length) return [];
    const keep = new Set(complete.slice(0, KEEP_DAILY));
    // Newest first, so the last date seen in a month is its first copy.
    const monthly = new Map<string, string>();
    for (const date of complete) monthly.set(date.slice(0, 7), date);
    for (const month of [...monthly.keys()].slice(0, KEEP_MONTHLY)) keep.add(monthly.get(month)!);
    const drop = folders.filter(f => !keep.has(f.date) && (f.complete || f.date < complete[0]));
    const keys = drop.flatMap(f => f.keys);
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    return drop.map(f => f.date);
}

// ------------------------------------------------------------------ restoring one

interface RestoreLock {
    id: string;
    /** The backup being restored: its date and when it was made. */
    date: string;
    made: string;
    schemaVersion: number;
    startedAt: string;
}

/** A restore in progress (the cron waits meanwhile). A lock older than a day is forgotten. */
export async function restoring(db: D1Database): Promise<RestoreLock | null> {
    const lock = await getSetting<RestoreLock | null>(db, 'restore', null);
    return lock && Date.now() - Date.parse(lock.startedAt) < 86400_000 ? lock : null;
}

async function tableCounts(db: D1Database): Promise<Map<string, number>> {
    const { tables } = await describe(db);
    const res = tables.length ? await db.batch(tables.map(t => db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t.name)}`))) : [];
    return new Map(tables.map((t, i) => [t.name, Number((res[i]?.results?.[0] as { n?: number } | undefined)?.n ?? 0)]));
}

/** Inserts one chunk of a table. `skipped` counts rows left out on purpose (this server's own settings). */
async function insertRows(db: D1Database, table: string, rows: unknown[], lock: RestoreLock): Promise<{ inserted: number; skipped: number }> {
    if (NOT_RESTORED.has(table)) return { inserted: 0, skipped: rows.length };
    const { results } = await db.prepare(`PRAGMA table_info(${quote(table)})`).all<{ name: string }>();
    const columns = new Set(results.map(c => c.name));
    if (!columns.size) throw new HttpError(400, `This database has no ${table} table.`);
    const statements: D1PreparedStatement[] = [];
    let skipped = 0;
    for (const line of rows) {
        if (!line || typeof line !== 'object' || Array.isArray(line)) throw new HttpError(400, 'Each row is an object of column values.');
        const row = { ...(line as Record<string, unknown>) };
        if (table === 'settings' && LOCAL_SETTINGS.has(String(row.key))) {
            skipped++;
            continue;
        }
        // A restore never sends email: a newsletter that was still going out comes back stopped.
        if (table === 'sends' && (row.status === 'queued' || row.status === 'sending')) {
            row.status = 'cancelled';
            row.error = `Stopped by the restore of the ${lock.date} backup. Check who got it before sending again.`;
            row.lease_until = null;
        }
        const keys = Object.keys(row);
        const extra = keys.find(k => !columns.has(k));
        if (extra) throw new HttpError(400, `${table}.${extra} is not a column in this database.`);
        const cols = keys.map(quote).join(', ');
        const marks = keys.map(() => '?').join(', ');
        // Settings may already hold what a fresh server wrote for itself: the backup's value wins. Elsewhere a row
        // that is already there (a chunk sent twice) is skipped, and the counts at the end show anything missing.
        const sql = table === 'settings' ? `INSERT INTO settings (${cols}) VALUES (${marks}) ON CONFLICT(key) DO UPDATE SET value = excluded.value` : `INSERT OR IGNORE INTO ${quote(table)} (${cols}) VALUES (${marks})`;
        statements.push(db.prepare(sql).bind(...keys.map(k => fromLine(row[k]))));
    }
    let inserted = 0;
    for (let i = 0; i < statements.length; i += 50) for (const r of await db.batch(statements.slice(i, i + 50))) inserted += r.meta.changes ?? 0;
    return { inserted, skipped };
}

/** Removes site files the rebuilt site doesn't have (pages published after the backup was made), from storage and the edge cache. */
async function removeStrayPages(bucket: R2Bucket, db: D1Database): Promise<number> {
    const { results } = await db.prepare('SELECT path FROM site_files').all<{ path: string }>();
    const keep = new Set(results.map(r => `${SITE_PREFIX}${r.path}`));
    const stray = (await listKeys(bucket, SITE_PREFIX)).filter(key => !keep.has(key));
    for (let i = 0; i < stray.length; i += 1000) await bucket.delete(stray.slice(i, i + 1000));
    const cache = edgeCache();
    if (cache) await Promise.all(stray.map(key => key.slice(SITE_PREFIX.length)).flatMap(path => [cache.delete(edgeKey(path, true)), cache.delete(edgeKey(path, false))]));
    return stray.length;
}

// ------------------------------------------------------------------ routes

type A = Ctx & { principal?: Principal };

export function backupRoutes(r: Router<A>): void {
    r.get('/backups', async (_req, ctx) => {
        atLeast(ctx.principal, 'admin');
        const [state, lease, folders] = await Promise.all([backupState(ctx.db), getSetting<string | null>(ctx.db, 'backup_lease', null), listBackups(ctx.env.BUCKET)]);
        return json({
            ...state,
            running: !!lease && lease > now(),
            schedule: { ...BACKUP_AT, keepDaily: KEEP_DAILY, keepMonthly: KEEP_MONTHLY },
            backups: folders.map(({ keys: _keys, ...f }) => f)
        });
    });

    r.post('/backups', async (_req, ctx) => (atLeast(ctx.principal, 'admin'), json(await runBackup(ctx.env, ctx.db, 'manual'), 201)));

    /** One file of a backup, for `masthead backup --out` and `masthead restore`. Personal data: the owner only. */
    r.get('/backups/:date/:file', async (_req, ctx, { date, file }) => {
        atLeast(ctx.principal, 'owner');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[\w.-]+$/.test(file)) throw new HttpError(400, 'That is not a backup file.');
        const obj = await ctx.env.BUCKET.get(`${BACKUP_PREFIX}${date}/${file}`);
        if (!obj) throw new HttpError(404, file === MANIFEST ? `There is no complete backup from ${date}.` : `The ${date} backup has no ${file}.`);
        return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'cache-control': 'no-store' } });
    });

    /**
     * Starts a restore of a backup (its manifest in the body) into this database, which must be empty:
     * nothing but settings and the migration history. The same backup can be started again to resume.
     */
    r.post('/restore/begin', async (req, ctx) => {
        atLeast(ctx.principal, 'owner');
        const manifest = (await body(req)).manifest as BackupManifest | undefined;
        if (manifest?.format !== FORMAT || !Array.isArray(manifest.tables)) throw new HttpError(400, 'Send the backup manifest (manifest.json) as "manifest".');
        const version = await schemaVersion(ctx.db);
        if (manifest.schemaVersion > version) {
            throw new HttpError(400, `This backup comes from a newer Masthead (schema ${manifest.schemaVersion}; this server is at ${version}). Deploy that version first.`);
        }
        const counts = await tableCounts(ctx.db);
        const missing = manifest.tables.map(t => t.name).filter(name => !NOT_RESTORED.has(name) && !counts.has(name));
        if (missing.length) throw new HttpError(400, `This database has no table for ${missing.join(', ')}.`);
        let lock = await restoring(ctx.db);
        const resumed = !!lock && lock.date === manifest.date && lock.made === manifest.startedAt;
        if (!lock || !resumed) {
            const used = [...counts].filter(([name, n]) => n > 0 && name !== 'settings' && !NOT_RESTORED.has(name));
            if (used.length) {
                const list = used.map(([name, n]) => `${name} ${n.toLocaleString('en-US')}`).join(', ');
                throw new HttpError(409, `This database is not empty (${list}). Restore only into a new, empty database.`);
            }
            lock = { id: randomToken(18), date: manifest.date, made: manifest.startedAt, schemaVersion: manifest.schemaVersion, startedAt: now() };
            await setSetting(ctx.db, 'restore', lock);
        }
        return json({ id: lock.id, resumed, schemaVersion: version, counts: Object.fromEntries(counts) });
    });

    /** Rows of one table, as lines of the backup file (at most a few MB per call). */
    r.post('/restore/rows', async (req, ctx) => {
        atLeast(ctx.principal, 'owner');
        const input = await body(req);
        const lock = await restoring(ctx.db);
        if (!lock || lock.id !== input.id) throw new HttpError(409, 'No restore is in progress here. Start one with /restore/begin.');
        return json(await insertRows(ctx.db, String(input.table ?? ''), Array.isArray(input.rows) ? input.rows : [], lock));
    });

    /**
     * Ends the restore: rows from an older schema get the data changes of the migrations since, the counts
     * come back to compare with the manifest, and the site and the AI's index are rebuilt from the restored rows.
     */
    r.post('/restore/finish', async (req, ctx) => {
        atLeast(ctx.principal, 'owner');
        const { id } = await body(req);
        const lock = await restoring(ctx.db);
        if (!lock || lock.id !== id) throw new HttpError(409, 'No restore is in progress here.');
        for (const sql of dataStatements(lock.schemaVersion)) await ctx.db.prepare(sql).run();
        const counts = await tableCounts(ctx.db);
        // Every page is written again, since storage may be a new bucket; pages the backup doesn't have are removed.
        await ctx.db.prepare('DELETE FROM site_files').run();
        await setSetting(ctx.db, 'restore', null);
        const publish = await publishSite(ctx.env, ctx.db, ctx.options);
        const removed = await removeStrayPages(ctx.env.BUCKET, ctx.db);
        await rebuildIndex(ctx.env, ctx.db).catch(err => console.error('rebuilding the knowledge index failed', err));
        return json({ counts: Object.fromEntries(counts), publish, removed });
    });
}
