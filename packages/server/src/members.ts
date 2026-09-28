import type { MemberEventRecord, MemberRecord } from '@masthead/core';
import { batched } from './db';
import { HttpError, hmac, isEmail, newId, now, safeEqual } from './util';

export type MemberStatus = 'pending' | 'subscribed' | 'unsubscribed';
export type ChangeSource = 'member' | 'admin' | 'api' | 'import' | 'provider';

export interface Member {
    id: string;
    email: string;
    name: string | null;
    status: MemberStatus;
    statusSource: ChangeSource;
    suppressed: 'bounced' | 'complained' | null;
    labels: string[];
    flags: string[];
    source: string;
    note: string | null;
    externalUuid: string | null;
    emailCount: number;
    openedCount: number;
    createdAt: string;
    updatedAt: string;
    lastEmailedAt: string | null;
    /** The reader's browser analytics id from their signup, so server events join their visit. */
    analyticsId: string | null;
    /** Where their latest signup through the blog's form came from. */
    attribution: Attribution | null;
}

/** Where a signup through the blog's form came from: the post and spot on the page, and how the reader got there. */
export interface Attribution {
    post: string | null;
    /** "post", "home" or "page". */
    placement: string | null;
    /** The referring domain of the visit; empty when there was none. */
    referrer: string | null;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    at: string;
}

function parseAttribution(v: unknown): Attribution | null {
    if (typeof v !== 'string' || !v) return null;
    try {
        return JSON.parse(v) as Attribution;
    } catch {
        return null;
    }
}

function toMember(r: any): Member {
    return {
        id: r.id,
        email: r.email,
        name: r.name,
        status: r.status,
        statusSource: r.status_source,
        suppressed: r.suppressed,
        labels: JSON.parse(r.labels || '[]'),
        flags: JSON.parse(r.flags || '[]'),
        source: r.source,
        note: r.note,
        externalUuid: r.external_uuid,
        emailCount: r.email_count,
        openedCount: r.opened_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastEmailedAt: r.last_emailed_at,
        analyticsId: r.analytics_id ?? null,
        attribution: parseAttribution(r.attribution)
    };
}

export async function getMember(db: D1Database, id: string): Promise<Member | null> {
    const r = await db.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();
    return r ? toMember(r) : null;
}

export async function getMemberByEmail(db: D1Database, email: string): Promise<Member | null> {
    const r = await db.prepare('SELECT * FROM members WHERE email = ?').bind(email.toLowerCase()).first();
    return r ? toMember(r) : null;
}

export async function getMemberByExternalUuid(db: D1Database, uuid: string): Promise<Member | null> {
    const r = await db.prepare('SELECT * FROM members WHERE external_uuid = ?').bind(uuid).first();
    return r ? toMember(r) : null;
}

export interface MemberQuery {
    q?: string;
    status?: string;
    suppressed?: boolean;
    flag?: string;
    label?: string;
    limit?: number;
    offset?: number;
}

function memberWhere(q: MemberQuery): { clause: string; args: unknown[] } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.q) (where.push('(email LIKE ? OR name LIKE ?)'), args.push(`%${q.q}%`, `%${q.q}%`));
    if (q.status) (where.push('status = ?'), args.push(q.status));
    if (q.suppressed !== undefined) where.push(q.suppressed ? 'suppressed IS NOT NULL' : 'suppressed IS NULL');
    // instr on the quoted value is a cheap exact-element prefilter; json_each confirms.
    if (q.flag) (where.push('instr(flags, json_quote(?)) > 0 AND EXISTS (SELECT 1 FROM json_each(members.flags) WHERE value = ?)'), args.push(q.flag, q.flag));
    if (q.label) (where.push('instr(labels, json_quote(?)) > 0 AND EXISTS (SELECT 1 FROM json_each(members.labels) WHERE value = ?)'), args.push(q.label, q.label));
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export async function listMembers(db: D1Database, q: MemberQuery): Promise<{ items: Member[]; total: number }> {
    const { clause, args } = memberWhere(q);
    const [rows, count] = await db.batch([
        db.prepare(`SELECT * FROM members ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...args, Math.min(q.limit ?? 50, 500), q.offset ?? 0),
        db.prepare(`SELECT COUNT(*) AS n FROM members ${clause}`).bind(...args)
    ]);
    return { items: rows.results.map(toMember), total: Number((count.results[0] as any).n) };
}

export async function memberStats(db: D1Database) {
    const row = await db
        .prepare(
            `SELECT COUNT(*) AS total,
               SUM(status = 'subscribed' AND suppressed IS NULL) AS sendable,
               SUM(status = 'subscribed') AS subscribed,
               SUM(status = 'unsubscribed') AS unsubscribed,
               SUM(status = 'pending') AS pending,
               SUM(suppressed IS NOT NULL) AS suppressed,
               SUM(opened_count > 0 AND status = 'subscribed' AND suppressed IS NULL) AS engaged,
               SUM(instr(flags, '"resubscribed-after-opt-out"') > 0) AS flagged
             FROM members`
        )
        .first<Record<string, number>>();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(row ?? {})) out[k] = Number(v ?? 0);
    return out;
}

export async function memberEvents(db: D1Database, memberId: string) {
    const { results } = await db.prepare('SELECT type, source, at, data FROM member_events WHERE member_id = ? ORDER BY at DESC LIMIT 100').bind(memberId).all();
    return results;
}

function event(db: D1Database, memberId: string, type: string, source: string, data?: unknown) {
    return db.prepare('INSERT INTO member_events (member_id, type, source, at, data) VALUES (?, ?, ?, ?, ?)').bind(memberId, type, source, now(), data ? JSON.stringify(data) : null);
}

/** Changes a member's subscription and records who did it (and, for an unsubscribe from a newsletter, which one). */
export async function setStatus(db: D1Database, member: Member, status: MemberStatus, source: ChangeSource, data?: Record<string, unknown>): Promise<Member> {
    if (member.status === status) return member;
    const flags = status === 'unsubscribed' ? member.flags.filter(f => f !== 'resubscribed-after-opt-out') : member.flags;
    await db.batch([
        db.prepare('UPDATE members SET status = ?, status_source = ?, flags = ?, updated_at = ? WHERE id = ?').bind(status, source, JSON.stringify(flags), now(), member.id),
        event(db, member.id, status, source, data)
    ]);
    return { ...member, status, statusSource: source, flags };
}

/**
 * Adds a person from a product integration or the admin. An existing member's
 * subscription is never changed here: someone who unsubscribed stays
 * unsubscribed no matter how often the integration calls.
 */
export async function addMember(
    db: D1Database,
    input: { email: string; name?: string | null; labels?: string[]; note?: string | null },
    source: 'api' | 'admin'
): Promise<{ member: Member; created: boolean }> {
    const email = String(input.email ?? '').trim().toLowerCase();
    if (!isEmail(email)) throw new HttpError(400, 'That email address is not valid.');
    const existing = await getMemberByEmail(db, email);
    const t = now();
    if (existing) {
        const labels = [...new Set([...existing.labels, ...(input.labels ?? [])])];
        await db
            .prepare('UPDATE members SET name = COALESCE(?, name), labels = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?')
            .bind(input.name ?? null, JSON.stringify(labels), input.note ?? null, t, existing.id)
            .run();
        return { member: { ...existing, name: input.name ?? existing.name, labels }, created: false };
    }
    const id = newId();
    await db.batch([
        db
            .prepare(
                `INSERT INTO members (id, email, name, status, status_source, labels, flags, source, note, created_at, updated_at)
                 VALUES (?, ?, ?, 'subscribed', ?, ?, '[]', ?, ?, ?, ?)`
            )
            .bind(id, email, input.name ?? null, source, JSON.stringify(input.labels ?? []), source, input.note ?? null, t, t),
        event(db, id, 'subscribed', source)
    ]);
    return { member: (await getMember(db, id))!, created: true };
}

/**
 * Public signup: new or unsubscribed people wait in 'pending' until they confirm by email.
 * Where the signup came from is kept with it; the latest signup wins.
 */
export async function requestSubscription(db: D1Database, email: string, name?: string | null, attribution?: Attribution | null): Promise<{ member: Member; needsConfirmation: boolean }> {
    const clean = String(email ?? '').trim().toLowerCase();
    if (!isEmail(clean)) throw new HttpError(400, 'That email address is not valid.');
    const existing = await getMemberByEmail(db, clean);
    if (existing?.status === 'subscribed' && !existing.suppressed) return { member: existing, needsConfirmation: false };
    const t = now();
    const origin = attribution ? JSON.stringify(attribution) : null;
    if (existing) {
        await db
            .prepare("UPDATE members SET status = 'pending', status_source = 'member', attribution = COALESCE(?, attribution), updated_at = ? WHERE id = ?")
            .bind(origin, t, existing.id)
            .run();
        return { member: { ...existing, status: 'pending', attribution: attribution ?? existing.attribution }, needsConfirmation: true };
    }
    const id = newId();
    await db
        .prepare(
            `INSERT INTO members (id, email, name, status, status_source, labels, flags, source, attribution, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', 'member', '[]', '[]', 'signup', ?, ?, ?)`
        )
        .bind(id, clean, name ?? null, origin, t, t)
        .run();
    return { member: (await getMember(db, id))!, needsConfirmation: true };
}

// ------------------------------------------------------------------ signed links

export async function memberToken(secret: string, purpose: 'unsubscribe' | 'confirm', memberId: string): Promise<string> {
    return hmac(secret, `${purpose}:${memberId}`);
}

export async function checkMemberToken(secret: string, purpose: 'unsubscribe' | 'confirm', memberId: string, token: string): Promise<boolean> {
    return safeEqual(await memberToken(secret, purpose, memberId), token);
}

// ------------------------------------------------------------------ provider events

export async function suppress(db: D1Database, email: string, reason: 'bounced' | 'complained'): Promise<void> {
    const m = await getMemberByEmail(db, email);
    if (!m) return;
    const stmts = [db.prepare('UPDATE members SET suppressed = ?, updated_at = ? WHERE id = ?').bind(reason, now(), m.id), event(db, m.id, reason, 'provider')];
    // A spam complaint is also an unsubscribe.
    if (reason === 'complained' && m.status !== 'unsubscribed') {
        stmts.push(db.prepare("UPDATE members SET status = 'unsubscribed', status_source = 'provider' WHERE id = ?").bind(m.id));
        stmts.push(event(db, m.id, 'unsubscribed', 'provider'));
    }
    await db.batch(stmts);
}

// ------------------------------------------------------------------ import

/**
 * Upserts imported members. An import may set status only for members whose
 * status came from an import; changes made here by the member or an admin win.
 */
export async function importMembers(db: D1Database, records: MemberRecord[], events: MemberEventRecord[]): Promise<{ upserted: number; events: number }> {
    const t = now();
    const stmts: D1PreparedStatement[] = [];
    for (const r of records) {
        const email = r.email.toLowerCase();
        if (!isEmail(email)) continue;
        stmts.push(
            db
                .prepare(
                    `INSERT INTO members (id, email, name, status, status_source, suppressed, labels, flags, source, note, external_id, external_uuid,
                       email_count, opened_count, created_at, updated_at)
                     VALUES (?, ?, ?, ?, 'import', ?, ?, ?, 'import', ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(email) DO UPDATE SET
                       name = COALESCE(members.name, excluded.name),
                       status = CASE WHEN members.status_source = 'import' THEN excluded.status ELSE members.status END,
                       suppressed = COALESCE(members.suppressed, excluded.suppressed),
                       labels = excluded.labels, flags = excluded.flags, note = COALESCE(members.note, excluded.note),
                       external_id = excluded.external_id, external_uuid = excluded.external_uuid,
                       email_count = MAX(members.email_count, excluded.email_count), opened_count = MAX(members.opened_count, excluded.opened_count),
                       updated_at = excluded.updated_at`
                )
                .bind(
                    r.externalId && /^[0-9a-f]{24}$/.test(r.externalId) ? r.externalId : newId(),
                    email,
                    r.name ?? null,
                    r.status,
                    r.suppressed ?? null,
                    JSON.stringify(r.labels ?? []),
                    JSON.stringify(r.flags ?? []),
                    r.note ?? null,
                    r.externalId ?? null,
                    r.externalUuid ?? null,
                    r.emailCount ?? 0,
                    r.openedCount ?? 0,
                    r.createdAt || t,
                    t
                )
        );
    }
    await batched(db, stmts, 200);

    // History: insert events for members we know, skipping ones already imported.
    const evStmts: D1PreparedStatement[] = [];
    for (const e of events) {
        evStmts.push(
            db
                .prepare(
                    `INSERT INTO member_events (member_id, type, source, at, data)
                     SELECT id, ?, ?, ?, '{"imported":true}' FROM members WHERE email = ?
                     AND NOT EXISTS (SELECT 1 FROM member_events me WHERE me.member_id = members.id AND me.type = ? AND me.at = ?)`
                )
                .bind(e.type, e.source, e.at, e.email.toLowerCase(), e.type, e.at)
        );
    }
    await batched(db, evStmts, 200);
    return { upserted: stmts.length, events: evStmts.length };
}

export async function deleteMember(db: D1Database, id: string): Promise<void> {
    await db.batch([
        db.prepare('DELETE FROM member_events WHERE member_id = ?').bind(id),
        db.prepare('DELETE FROM sequence_members WHERE member_id = ?').bind(id),
        db.prepare('DELETE FROM sequence_sends WHERE member_id = ?').bind(id),
        db.prepare('DELETE FROM members WHERE id = ?').bind(id)
    ]);
}

/** Restores the opt-out of members an old integration re-subscribed. */
export async function restoreOptOuts(db: D1Database): Promise<number> {
    const { results } = await db.prepare(`SELECT * FROM members WHERE instr(flags, '"resubscribed-after-opt-out"') > 0`).all();
    for (const r of results) await setStatus(db, toMember(r), 'unsubscribed', 'admin');
    return results.length;
}
