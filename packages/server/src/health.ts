/**
 * GET <base>api/health, for uptime monitors: whether the database and storage
 * answer, and whether the work that runs by itself keeps up (publishing, the
 * minute cron, newsletter batches, the AI's reading queue, backups).
 *
 * 200 when every check passes or only warns, 503 when one fails; `status`
 * says which (pass, warn, fail). A few small reads and one storage lookup,
 * never cached, and nothing private: times, counts and short reasons.
 */
import { BACKUP_AT, type BackupState } from './backup';
import { SCHEMA_VERSION, schemaVersion } from './db';
import type { Ctx } from './env';
import { BATCH } from './newsletter';
import { SITE_PREFIX } from './publish';
import { json } from './util';

type Status = 'pass' | 'warn' | 'fail';
type Check = { status: Status; note?: string } & Record<string, unknown>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RANK: Record<Status, number> = { pass: 0, warn: 1, fail: 2 };

export async function health(ctx: Ctx): Promise<Response> {
    const t0 = Date.now();
    const settings = readSettings(ctx.db);
    const [database, storage, publish, cron, newsletter, knowledge, backup] = await Promise.all([
        databaseCheck(ctx.db),
        storageCheck(ctx),
        settings.then(publishCheck),
        settings.then(cronCheck),
        newsletterCheck(ctx),
        knowledgeCheck(ctx),
        settings.then(backupCheck)
    ].map(p => p.catch((): Check => ({ status: 'fail', note: 'The database did not answer.' }))));
    const checks = { database, storage, publish, cron, newsletter, knowledge, backup };
    const status = Object.values(checks).reduce<Status>((worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst), 'pass');
    return json({ status, time: new Date().toISOString(), ms: Date.now() - t0, checks }, status === 'fail' ? 503 : 200);
}

async function readSettings(db: D1Database): Promise<Record<string, unknown>> {
    const { results } = await db
        .prepare("SELECT key, value FROM settings WHERE key IN ('site_published_at', 'site_publish_started_at', 'cron_heartbeat', 'backup')")
        .all<{ key: string; value: string }>();
    return Object.fromEntries(results.map(r => [r.key, JSON.parse(r.value)]));
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
const ago = (iso: string) => Date.now() - Date.parse(iso);

async function databaseCheck(db: D1Database): Promise<Check> {
    const t = Date.now();
    const version = await schemaVersion(db);
    if (version < SCHEMA_VERSION) return { status: 'warn', ms: Date.now() - t, schemaVersion: version, note: `Migrations are pending (${version} of ${SCHEMA_VERSION}).` };
    return { status: 'pass', ms: Date.now() - t, schemaVersion: version };
}

async function storageCheck(ctx: Ctx): Promise<Check> {
    const t = Date.now();
    try {
        const home = await ctx.env.BUCKET.head(`${SITE_PREFIX}${ctx.basePath.slice(1)}index.html`);
        if (!home) return { status: 'fail', ms: Date.now() - t, note: 'The front page is not in storage: publish the site.' };
        return { status: 'pass', ms: Date.now() - t };
    } catch {
        return { status: 'fail', ms: Date.now() - t, note: 'Storage did not answer.' };
    }
}

/** The last publish that finished, and one that started and never did (the cron retries those). */
function publishCheck(s: Record<string, unknown>): Check {
    const published = text(s.site_published_at);
    const started = text(s.site_publish_started_at);
    if (started && (!published || published < started) && ago(started) > 15 * MINUTE) {
        return { status: 'fail', lastPublishedAt: published, note: `A publish started at ${started} and has not finished.` };
    }
    if (!published) return { status: 'warn', lastPublishedAt: null, note: 'The site has not been published yet.' };
    return { status: 'pass', lastPublishedAt: published };
}

/** Scheduled posts, newsletter batches and backups all hang on the minute cron. */
function cronCheck(s: Record<string, unknown>): Check {
    const last = text(s.cron_heartbeat);
    if (!last) return { status: 'warn', lastRunAt: null, note: 'The cron has not run yet.' };
    const age = ago(last);
    if (age <= 3 * MINUTE) return { status: 'pass', lastRunAt: last };
    return { status: age > 10 * MINUTE ? 'fail' : 'warn', lastRunAt: last, note: `The cron last ran ${Math.round(age / MINUTE)} minutes ago: scheduled posts and newsletters wait for it.` };
}

/** Newsletters going out. One that no worker has touched for 15 minutes is stuck. */
async function newsletterCheck(ctx: Ctx): Promise<Check> {
    const { results } = await ctx.db
        .prepare("SELECT total, sent, failed, created_at, lease_until FROM sends WHERE status IN ('queued', 'sending')")
        .all<{ total: number; sent: number; failed: number; created_at: string; lease_until: string | null }>();
    const pending = results.reduce((n, s) => n + Math.max(0, s.total - s.sent - s.failed), 0);
    const out = { sending: results.length, pendingBatches: Math.ceil(pending / BATCH) };
    const cutoff = new Date(Date.now() - 15 * MINUTE).toISOString();
    const stuck = results.filter(s => (s.lease_until ?? s.created_at) < cutoff).length;
    if (!stuck) return { status: 'pass', ...out };
    const note = ctx.options.email?.(ctx.env) ? `${stuck} newsletter${stuck === 1 ? ' has' : 's have'} made no progress for 15 minutes.` : 'Newsletters are queued, but no email provider is configured.';
    return { status: 'fail', ...out, note };
}

/** Passages waiting to be read (embedded) by the AI. Without an AI key they wait by design. */
async function knowledgeCheck(ctx: Ctx): Promise<Check> {
    const row = await ctx.db
        .prepare('SELECT COUNT(*) AS n, MIN(id) AS first FROM (SELECT id FROM knowledge WHERE vector IS NULL LIMIT 100000)')
        .first<{ n: number; first: number | null }>();
    const pending = Number(row?.n ?? 0);
    if (!pending || !ctx.options.ai?.(ctx.env)) return { status: 'pass', pending };
    const oldest = await ctx.db.prepare('SELECT updated_at FROM knowledge WHERE id = ?').bind(row?.first ?? 0).first<{ updated_at: string }>();
    const waited = oldest ? ago(oldest.updated_at) : 0;
    if (waited > 3 * HOUR) return { status: 'warn', pending, note: `The oldest of ${pending} passages has waited ${Math.round(waited / HOUR)} hours to be read.` };
    return { status: 'pass', pending };
}

/** One missed night warns; two fail. */
function backupCheck(s: Record<string, unknown>): Check {
    const state = s.backup as BackupState | undefined;
    const last = state?.last;
    const failed = state?.failed ? ` The last attempt failed at ${state.failed.at}.` : '';
    const at = `${String(BACKUP_AT.hour).padStart(2, '0')}:${String(BACKUP_AT.minute).padStart(2, '0')} UTC`;
    if (!last) return { status: 'warn', lastBackupAt: null, note: `No backup yet: the first runs at ${at}.${failed}` };
    const age = ago(last.finishedAt);
    if (age <= 26 * HOUR) return { status: 'pass', lastBackupAt: last.finishedAt };
    return { status: age > 50 * HOUR ? 'fail' : 'warn', lastBackupAt: last.finishedAt, note: `The last backup finished ${Math.round(age / HOUR)} hours ago.${failed}` };
}
