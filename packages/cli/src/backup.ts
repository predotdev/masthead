/**
 * `masthead backup` and `masthead restore`. The server backs itself up every
 * night (Settings, Backups); these make one on demand, download one to a
 * folder (every file read back against its manifest), and load one into an
 * empty database, table by table, comparing row counts at the end.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface Manifest {
    format: string;
    date: string;
    trigger: string;
    startedAt: string;
    finishedAt: string;
    schemaVersion: number;
    tables: { name: string; file: string; rows: number; bytes: number }[];
}

interface Folder {
    date: string;
    complete: boolean;
    files: number;
    bytes: number;
}

type Call = (method: string, path: string, body?: unknown) => Promise<any>;

const slash = (server: string) => (server.endsWith('/') ? server : `${server}/`);
const num = (n: number) => n.toLocaleString('en-US');
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Admin API calls with the bearer token. Busy or unreachable servers are retried; the server's own message explains a refusal. */
function client(server: string, token: string): Call {
    return async (method, path, body) => {
        for (let attempt = 0; ; attempt++) {
            const res = await fetch(`${server}admin/api${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, 'x-masthead': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
                body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
            }).catch(() => null);
            if (res?.ok) return res.json();
            const text = res ? await res.text().catch(() => '') : '';
            if (res && res.status !== 429 && res.status < 500) throw new Error(reason(text) ?? `${method} ${path}: HTTP ${res.status}`);
            if (attempt >= 4) throw new Error(`${method} ${path}: ${res ? `HTTP ${res.status} ${reason(text) ?? ''}` : 'no answer'}`.trim());
            await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        }
    };
}

function reason(text: string): string | null {
    try {
        return (JSON.parse(text) as { error?: string }).error ?? null;
    } catch {
        return text.trim().slice(0, 300) || null;
    }
}

/** A backup file from the server's storage. */
async function download(server: string, token: string, date: string, file: string): Promise<Response> {
    const res = await fetch(`${server}admin/api/backups/${date}/${encodeURIComponent(file)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(reason(await res.text()) ?? `${file}: HTTP ${res.status}`);
    return res;
}

/** The lines of a gzipped JSON-lines file, as text. */
async function* lines(stream: ReadableStream<Uint8Array<ArrayBuffer>>): AsyncGenerator<string> {
    const reader = stream.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
    let rest = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const parts = (rest + value).split('\n');
        rest = parts.pop() ?? '';
        for (const line of parts) if (line) yield line;
    }
    if (rest) yield rest;
}

export async function backup(options: { server: string; token: string; out?: string; date?: string; list?: boolean }): Promise<void> {
    const server = slash(options.server);
    const call = client(server, options.token);

    if (options.list) {
        const res = (await call('GET', '/backups')) as { last: any; failed: any; running: boolean; schedule: { hour: number; minute: number; keepDaily: number; keepMonthly: number }; backups: Folder[] };
        const at = `${String(res.schedule.hour).padStart(2, '0')}:${String(res.schedule.minute).padStart(2, '0')} UTC`;
        console.log(`every night at ${at}; keeps ${res.schedule.keepDaily} daily and ${res.schedule.keepMonthly} monthly copies${res.running ? '; a backup is running now' : ''}`);
        if (res.last) console.log(`last: ${res.last.date} (${res.last.trigger}), ${res.last.tables} tables, ${num(res.last.rows)} rows, ${size(res.last.bytes)}`);
        if (res.failed) console.log(`failed: ${res.failed.at}: ${res.failed.error}`);
        for (const f of res.backups) console.log(`  ${f.date}  ${size(f.bytes).padStart(9)}  ${f.complete ? `${f.files - 1} tables` : 'unfinished'}`);
        if (!res.backups.length) console.log('  no backups yet');
        return;
    }

    let date = options.date;
    if (date && !DATE.test(date)) throw new Error('--date takes a date like 2026-09-28.');
    if (!date) {
        const t0 = performance.now();
        const run = await call('POST', '/backups');
        console.log(`backup ${run.date}: ${run.tables} tables, ${num(run.rows)} rows, ${size(run.bytes)} gzipped (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
        date = run.date as string;
    }
    if (!options.out) return;

    // A copy off Cloudflare, read back line by line: a file that doesn't match its manifest fails here, not on the day it is needed.
    const dir = join(resolve(options.out), date);
    await mkdir(dir, { recursive: true });
    const manifestText = await (await download(server, options.token, date, 'manifest.json')).text();
    const manifest = JSON.parse(manifestText) as Manifest;
    let bad = 0;
    for (const t of manifest.tables) {
        const path = join(dir, t.file);
        await Bun.write(path, await download(server, options.token, date, t.file));
        let rows = 0;
        for await (const _ of lines(Bun.file(path).stream())) rows++;
        if (rows !== t.rows) bad++;
        console.log(`  ${t.name.padEnd(22)} ${num(rows).padStart(10)} rows  ${size(Bun.file(path).size).padStart(9)}${rows === t.rows ? '' : `  MISMATCH: the manifest says ${num(t.rows)}`}`);
    }
    // The manifest goes last, so a folder with one holds every file.
    await Bun.write(join(dir, 'manifest.json'), manifestText);
    if (bad) throw new Error(`${bad} file${bad === 1 ? '' : 's'} did not match the manifest. Download again; if it persists, make a new backup.`);
    console.log(`saved to ${dir}: every file reads back with the rows its manifest lists`);
}

interface Source {
    manifest: Manifest;
    open(file: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>>;
}

async function openSource(server: string, token: string, from: string): Promise<Source> {
    if (DATE.test(from)) {
        const manifest = (await (await download(server, token, from, 'manifest.json')).json()) as Manifest;
        return { manifest, open: async file => (await download(server, token, from, file)).body! };
    }
    const dir = resolve(from);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => {
        throw new Error(`${dir} has no manifest.json: pass a folder saved with backup --out, or a date.`);
    })) as Manifest;
    return { manifest, open: async file => Bun.file(join(dir, file)).stream() };
}

export async function restore(options: { server: string; token: string; from: string }): Promise<void> {
    const server = slash(options.server);
    const call = client(server, options.token);
    const t0 = performance.now();
    const source = await openSource(server, options.token, options.from);
    const { manifest } = source;
    if (manifest.format !== 'masthead.backup/1') throw new Error(`Not a Masthead backup manifest (format ${manifest.format}).`);
    console.log(`restoring the ${manifest.date} backup (${manifest.trigger}, made ${manifest.startedAt}, schema ${manifest.schemaVersion}) into ${server}\n`);

    // The server refuses unless its database is empty, and resumes when this same backup was being restored.
    const begin = (await call('POST', '/restore/begin', { manifest })) as { id: string; resumed: boolean; schemaVersion: number; counts: Record<string, number> };
    if (begin.resumed) console.log('resuming an unfinished restore of this backup\n');
    const id = JSON.stringify(begin.id);
    // Rows each table should end up with: the backup's, less any the server keeps as its own (its cron and backup records).
    const expected = new Map(manifest.tables.map(t => [t.name, t.rows]));
    for (const t of manifest.tables) {
        const label = `  ${t.name.padEnd(22)}`;
        if (t.name === 'schema_migrations') {
            console.log(`${label} skipped: the server keeps its own (schema ${begin.schemaVersion})`);
            continue;
        }
        if (begin.resumed && t.rows > 0 && (begin.counts[t.name] ?? 0) >= t.rows) {
            console.log(`${label} ${num(t.rows).padStart(10)} rows, restored before`);
            continue;
        }
        let batch: string[] = [];
        let bytes = 0;
        let read = 0;
        let inserted = 0;
        let skipped = 0;
        const flush = async () => {
            if (!batch.length) return;
            // Lines go up as they are: each is already a JSON object of the row's columns.
            const r = await call('POST', '/restore/rows', `{"id":${id},"table":${JSON.stringify(t.name)},"rows":[${batch.join(',')}]}`);
            inserted += r.inserted;
            skipped += r.skipped;
            batch = [];
            bytes = 0;
            if (process.stdout.isTTY) process.stdout.write(`\r${label} ${num(read).padStart(10)} rows`);
        };
        for await (const line of lines(await source.open(t.file))) {
            batch.push(line);
            bytes += line.length;
            read++;
            if (batch.length >= 500 || bytes >= 1_500_000) await flush();
        }
        await flush();
        if (process.stdout.isTTY) process.stdout.write('\r');
        if (read !== t.rows) throw new Error(`${t.file} has ${num(read)} rows but the manifest lists ${num(t.rows)}. The backup changed while it was read: run restore again.`);
        expected.set(t.name, read - skipped);
        const notes = [skipped ? `${num(skipped)} left out: this server keeps its own` : '', inserted < read - skipped ? `${num(read - skipped - inserted)} already there` : ''].filter(Boolean);
        console.log(`${label} ${num(read).padStart(10)} rows${notes.length ? ` (${notes.join(', ')})` : ''}`);
    }

    const done = (await call('POST', '/restore/finish', { id: begin.id })) as { counts: Record<string, number>; publish: { written: number; total: number }; removed: number };
    // Nothing may be missing. More is fine: a live server takes signups while it restores, and keeps its own settings.
    console.log(`\n  ${'table'.padEnd(22)} ${'backup'.padStart(10)} ${'now'.padStart(10)}`);
    let mismatched = 0;
    for (const t of manifest.tables) {
        if (t.name === 'schema_migrations') continue;
        const got = done.counts[t.name] ?? 0;
        const want = expected.get(t.name) ?? t.rows;
        if (got < want) mismatched++;
        const note = got < want ? `  MISMATCH: ${num(want - got)} missing` : got > want ? `  ok, ${num(got - want)} more than the backup` : '  ok';
        console.log(`  ${t.name.padEnd(22)} ${num(t.rows).padStart(10)} ${num(got).padStart(10)}${note}`);
    }
    const rows = manifest.tables.filter(t => t.name !== 'schema_migrations').reduce((n, t) => n + t.rows, 0);
    console.log(`\nsite rebuilt: ${num(done.publish.written)} of ${num(done.publish.total)} files written${done.removed ? `, ${num(done.removed)} stray pages removed` : ''}`);
    if (mismatched) throw new Error(`${mismatched} table${mismatched === 1 ? ' is' : 's are'} missing rows from the backup.`);
    console.log(`every row of the backup is in the database (${num(rows)} rows, ${manifest.tables.length - 1} tables) · ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
