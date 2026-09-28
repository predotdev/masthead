import type { StaffRole } from '@masthead/core';
import { getStaff, getStaffByEmail, listStaff } from './content';
import type { Ctx, Env, Principal } from './env';
import { HttpError, cookies, newId, now, randomToken, safeEqual, sha256 } from './util';

export const SESSION_COOKIE = 'mh_session';
const SESSION_DAYS = 30;
export const LOGIN_MINUTES = 60;

const RANK: Record<StaffRole, number> = { contributor: 0, author: 1, editor: 2, admin: 3, owner: 4 };

export function atLeast(p: Principal | undefined, role: StaffRole): Principal {
    if (!p) throw new HttpError(401, 'Sign in to continue.');
    if (RANK[p.role] < RANK[role]) throw new HttpError(403, `This needs the ${role} role or higher.`);
    return p;
}

/** Resolves who is calling: a session cookie, an API key, or the bootstrap token. */
export async function principal(req: Request, env: Env, db: D1Database): Promise<Principal | undefined> {
    const auth = req.headers.get('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (bearer) {
        if (env.BOOTSTRAP_TOKEN && env.BOOTSTRAP_TOKEN.length >= 32 && safeEqual(bearer, env.BOOTSTRAP_TOKEN)) return ownerPrincipal(db, 'bootstrap');
        if (bearer.startsWith('mh_')) {
            const row = await db.prepare('SELECT id, name, role FROM api_keys WHERE key_hash = ?').bind(await sha256(bearer)).first<{ id: string; name: string; role: StaffRole }>();
            if (row) {
                await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now(), row.id).run();
                return { staffId: `key:${row.id}`, email: '', name: row.name, role: row.role, via: 'api-key' };
            }
        }
        return undefined;
    }
    const token = cookies(req)[SESSION_COOKIE];
    if (!token) return undefined;
    const row = await db
        .prepare('SELECT s.staff_id, s.expires_at, st.email, st.name, st.role, st.status FROM sessions s JOIN staff st ON st.id = s.staff_id WHERE s.token_hash = ?')
        .bind(await sha256(token))
        .first<{ staff_id: string; expires_at: string; email: string; name: string; role: StaffRole; status: string }>();
    if (!row || row.expires_at < now() || row.status === 'suspended') return undefined;
    return { staffId: row.staff_id, email: row.email, name: row.name, role: row.role, via: 'session' };
}

async function ownerPrincipal(db: D1Database, via: Principal['via']): Promise<Principal> {
    const owner = (await listStaff(db)).find(s => s.role === 'owner');
    return owner
        ? { staffId: owner.id, email: owner.email, name: owner.name, role: 'owner', via }
        : { staffId: 'bootstrap', email: '', name: 'Owner', role: 'owner', via };
}

/** State-changing admin calls must come from the admin app or a bearer token, never a cross-site form. */
export function checkCsrf(req: Request): void {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers.get('authorization')?.startsWith('Bearer ')) return;
    if (req.headers.get('x-masthead') !== '1') throw new HttpError(403, 'Missing the x-masthead request header.');
}

export async function createSession(db: D1Database, staffId: string): Promise<string> {
    const token = randomToken();
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    await db.batch([
        db.prepare('INSERT INTO sessions (token_hash, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), staffId, now(), expires),
        db.prepare('UPDATE staff SET last_seen_at = ? WHERE id = ?').bind(now(), staffId),
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now())
    ]);
    return token;
}

export function sessionCookie(token: string): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function endSession(req: Request, db: D1Database): Promise<void> {
    const token = cookies(req)[SESSION_COOKIE];
    if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

/** One-time sign-in link for a staff member. Returns null when there is no such active staff member. */
export async function createLoginToken(db: D1Database, email: string): Promise<{ token: string; staff: { id: string; name: string; email: string } } | null> {
    const staff = await getStaffByEmail(db, email);
    if (!staff || staff.status === 'suspended') return null;
    const token = randomToken();
    const expires = new Date(Date.now() + LOGIN_MINUTES * 60_000).toISOString();
    await db.prepare('INSERT INTO login_tokens (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), staff.id, expires).run();
    return { token, staff: { id: staff.id, name: staff.name, email: staff.email } };
}

/** Who a sign-in link belongs to and whether it still works, without using it up. */
export async function peekLoginToken(db: D1Database, token: string): Promise<{ state: 'valid' | 'used' | 'expired' | 'unknown'; email?: string; name?: string }> {
    const row = await db
        .prepare('SELECT lt.expires_at, lt.used_at, st.email, st.name FROM login_tokens lt JOIN staff st ON st.id = lt.staff_id WHERE lt.token_hash = ?')
        .bind(await sha256(token))
        .first<{ expires_at: string; used_at: string | null; email: string; name: string }>();
    if (!row) return { state: 'unknown' };
    const state = row.used_at ? 'used' : row.expires_at < now() ? 'expired' : 'valid';
    return { state, email: row.email, name: row.name };
}

export async function consumeLoginToken(db: D1Database, token: string): Promise<string | null> {
    const hash = await sha256(token);
    const row = await db.prepare('SELECT staff_id, expires_at, used_at FROM login_tokens WHERE token_hash = ?').bind(hash).first<{ staff_id: string; expires_at: string; used_at: string | null }>();
    if (!row || row.used_at || row.expires_at < now()) return null;
    await db.batch([
        db.prepare('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?').bind(now(), hash),
        db.prepare("UPDATE staff SET status = 'active' WHERE id = ? AND status = 'invited'").bind(row.staff_id)
    ]);
    const staff = await getStaff(db, row.staff_id);
    return staff && staff.status !== 'suspended' ? staff.id : null;
}

export async function createApiKey(db: D1Database, name: string, role: StaffRole, createdBy: string): Promise<{ id: string; key: string }> {
    const key = `mh_${randomToken(24)}`;
    const id = newId();
    await db
        .prepare('INSERT INTO api_keys (id, name, key_hash, prefix, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, name, await sha256(key), key.slice(0, 7), role, createdBy, now())
        .run();
    return { id, key };
}

export type AuthedCtx = Ctx & { principal: Principal };
