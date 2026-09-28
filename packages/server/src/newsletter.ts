import type { EmailEvent, EmailMessage, Post } from '@masthead/core';
import { renderBody, tagLinks } from '@masthead/render';
import { getPost, listStaff, newsletterSettings, setPostNewsletter, siteSettings } from './content';
import { batched } from './db';
import { UNSUBSCRIBE_PLACEHOLDER, newsletterEmail, type NewsletterEmail } from './email';
import type { AppOptions, Env, Principal } from './env';
import { memberToken, suppress } from './members';
import { linkTag } from './publish';
import { distinctId } from './analytics';
import { HttpError, isEmail, newId, now, sleep } from './util';

export const BATCH = 100;

export function appUrl(env: Env): string {
    const u = env.APP_URL || env.SITE_URL;
    return u.endsWith('/') ? u : `${u}/`;
}

export function testMode(env: Env): boolean {
    return env.EMAIL_TEST_MODE === 'true';
}

export function testAddress(env: Env): string {
    return env.EMAIL_TEST_ADDRESS || 'delivered@resend.dev';
}

export interface Team {
    domains: string[];
    addresses: string[];
}

/** Test mode's team: EMAIL_TEST_ALLOW entries (addresses or @domains), staff, and the provider's test domain. */
export async function testTeam(env: Env, db: D1Database): Promise<Team> {
    const entries = (env.EMAIL_TEST_ALLOW ?? '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);
    const { results } = await db.prepare('SELECT lower(email) AS email FROM staff').all<{ email: string }>();
    return {
        domains: [...new Set(['@resend.dev', ...entries.filter(e => e.startsWith('@'))])],
        addresses: [...new Set([...entries.filter(e => !e.startsWith('@')), ...results.map(r => r.email)])]
    };
}

export function onTeam(team: Team, address: string): boolean {
    const a = address.trim().toLowerCase();
    return team.addresses.includes(a) || team.domains.some(d => a.endsWith(d));
}

/** Whether test mode lets email reach this address. Always true outside test mode. */
export async function mayEmail(env: Env, db: D1Database, address: string): Promise<boolean> {
    return !testMode(env) || onTeam(await testTeam(env, db), address);
}

/** SQL that keeps only test mode's team, for a members query. */
async function teamOnly(env: Env, db: D1Database): Promise<{ sql: string; args: string[] }> {
    const team = await testTeam(env, db);
    // A domain matches as a suffix, as onTeam does: LIKE's own wildcards (% and _) in it are escaped.
    const parts = [...team.domains.map(() => "lower(email) LIKE ? ESCAPE '\\'"), ...team.addresses.map(() => 'lower(email) = ?')];
    return { sql: parts.length ? `(${parts.join(' OR ')})` : '0', args: [...team.domains.map(d => `%${d.replace(/[\\%_]/g, '\\$&')}`), ...team.addresses] };
}

/** A member's unsubscribe link. From a newsletter it also names the send, so the unsubscribe counts against it. */
export async function unsubscribeUrl(env: Env, memberId: string, sendId?: string): Promise<string> {
    return `${appUrl(env)}api/unsubscribe?m=${memberId}&t=${await memberToken(env.SECRET, 'unsubscribe', memberId)}${sendId ? `&s=${sendId}` : ''}`;
}

async function sender(env: Env, db: D1Database) {
    const n = await newsletterSettings(env, db);
    const site = await siteSettings(env, db);
    const fromAddress = env.EMAIL_FROM || (n.senderEmail ? `${n.senderName || site.title} <${n.senderEmail}>` : null);
    if (!fromAddress) throw new HttpError(500, 'Set EMAIL_FROM to send email.');
    return { from: fromAddress, replyTo: n.replyTo || env.EMAIL_REPLY_TO || undefined, postalAddress: n.postalAddress ?? null };
}

/** The email for one post, with an unsubscribe placeholder to fill per recipient. */
export async function buildEmail(env: Env, db: D1Database, post: Post): Promise<NewsletterEmail> {
    const site = await siteSettings(env, db);
    const staff = await listStaff(db);
    const names = post.authors.map(id => staff.find(s => s.id === id)?.name).filter((n): n is string => !!n);
    const { postalAddress } = await sender(env, db);
    const settings = await newsletterSettings(env, db);
    const body = tagLinks(renderBody(post), site.url, linkTag(env));
    const email = newsletterEmail({
        site,
        post,
        body: settings.utm === false ? body : utmLinks(body, { utm_source: 'email', utm_medium: 'newsletter', utm_campaign: post.slug }),
        markdown: post.markdown ?? '',
        postUrl: settings.utm === false ? `${site.url}${post.slug}/` : `${site.url}${post.slug}/?utm_source=email&utm_medium=newsletter&utm_campaign=${encodeURIComponent(post.slug)}`,
        origin: new URL(appUrl(env)).origin,
        authors: names,
        postalAddress
    });
    return { ...email, slug: post.slug };
}

export type Segment = 'all' | 'engaged' | `label:${string}`;

function segmentWhere(segment: Segment): { sql: string; args: unknown[] } {
    const base = "status = 'subscribed' AND suppressed IS NULL";
    if (segment === 'engaged') return { sql: `${base} AND opened_count > 0`, args: [] };
    if (segment.startsWith('label:'))
        return { sql: `${base} AND instr(labels, json_quote(?)) > 0 AND EXISTS (SELECT 1 FROM json_each(members.labels) WHERE value = ?)`, args: [segment.slice(6), segment.slice(6)] };
    return { sql: base, args: [] };
}

export async function countSegment(db: D1Database, segment: Segment, env?: Env): Promise<number> {
    const w = segmentWhere(segment);
    const team = env && testMode(env) ? await teamOnly(env, db) : null;
    const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM members WHERE ${w.sql}${team ? ` AND ${team.sql}` : ''}`)
        .bind(...w.args, ...(team?.args ?? []))
        .first<{ n: number }>();
    return Number(row?.n ?? 0);
}

/**
 * Queues a newsletter. Recipients are fixed now, one row each, so every
 * member is sent to at most once however often processing retries.
 */
export async function createSend(env: Env, db: D1Database, by: Principal, input: { postId: string; segment?: Segment; subject?: string; force?: boolean }) {
    const post = await getPost(db, input.postId);
    if (!post) throw new HttpError(404, 'Post not found.');
    if (post.status !== 'published') throw new HttpError(400, 'Publish the post before sending it.');
    const segment: Segment = input.segment ?? 'all';
    const previous = await db.prepare("SELECT id FROM sends WHERE post_id = ? AND status IN ('queued','sending','sent') AND test_mode = 0").bind(post.id).first();
    if (previous && !input.force && !testMode(env)) throw new HttpError(409, 'This post was already sent. Pass force to send it again.');
    const id = newId();
    const w = segmentWhere(segment);
    // Test mode: only the team members of the segment become recipients; nobody else is ever sent to.
    const team = testMode(env) ? await teamOnly(env, db) : null;
    await db.batch([
        db
            .prepare("INSERT INTO sends (id, post_id, subject, segment, status, test_mode, created_by, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)")
            .bind(id, post.id, (input.subject || post.title).slice(0, 250), segment, testMode(env) ? 1 : 0, by.staffId, now()),
        db.prepare(`INSERT INTO send_recipients (send_id, member_id, email) SELECT ?, id, email FROM members WHERE ${w.sql}${team ? ` AND ${team.sql}` : ''}`).bind(id, ...w.args, ...(team?.args ?? [])),
        db.prepare('UPDATE sends SET total = (SELECT COUNT(*) FROM send_recipients WHERE send_id = ?) WHERE id = ?').bind(id, id)
    ]);
    return getSend(db, id);
}

export async function sendTest(env: Env, db: D1Database, options: AppOptions, input: { postId: string; emails: string[] }) {
    const transport = options.email?.(env);
    if (!transport) throw new HttpError(500, 'No email provider is configured.');
    const emails = [...new Set((input.emails ?? []).map(e => String(e).trim().toLowerCase()))].filter(isEmail).slice(0, 10);
    if (!emails.length) throw new HttpError(400, 'Add at least one valid email address.');
    if (testMode(env)) {
        const team = await testTeam(env, db);
        const blocked = emails.filter(e => !onTeam(team, e));
        if (blocked.length) throw new HttpError(400, `Test mode: email only goes to the team. Not allowed: ${blocked.join(', ')}`);
    }
    const post = await getPost(db, input.postId);
    if (!post) throw new HttpError(404, 'Post not found.');
    const email = await buildEmail(env, db, post);
    const { from, replyTo } = await sender(env, db);
    const stamp = Date.now();
    const results = await transport.send(
        emails.map(to => ({
            to,
            from,
            replyTo,
            subject: `[Test] ${email.subject}`,
            html: email.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, '#'),
            text: email.text.replaceAll(UNSUBSCRIBE_PLACEHOLDER, '#'),
            idempotencyKey: `test:${post.id}:${to}:${stamp}`
        }))
    );
    return { sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => r.error) };
}

const LEASE_MS = 120_000;

/** Works through queued sends in batches until the time budget runs out. */
export async function processSends(env: Env, db: D1Database, options: AppOptions, budgetMs = 25_000): Promise<{ batches: number; sent: number; failed: number }> {
    const transport = options.email?.(env);
    const stats = { batches: 0, sent: 0, failed: 0 };
    if (!transport) return stats;
    const deadline = Date.now() + budgetMs;
    const templates = new Map<string, NewsletterEmail>();

    let leased: string | null = null;
    try {
        while (Date.now() < deadline) {
            const send = await db.prepare("SELECT * FROM sends WHERE status IN ('queued','sending') ORDER BY created_at LIMIT 1").first<any>();
            if (!send) break;
            // Claim the send for the next batch; if another worker holds it, leave it to them.
            const claim = await db
                .prepare('UPDATE sends SET lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ? OR lease_until = ?)')
                .bind(new Date(Date.now() + LEASE_MS).toISOString(), send.id, now(), leased === send.id ? send.lease_until : '')
                .run();
            if (!claim.meta.changes) break;
            leased = send.id;
            if (send.status === 'queued') await db.prepare("UPDATE sends SET status = 'sending', started_at = ? WHERE id = ? AND status = 'queued'").bind(now(), send.id).run();

            const { results: batch } = await db
                .prepare(
                    "SELECT r.member_id, r.email, m.analytics_id FROM send_recipients r LEFT JOIN members m ON m.id = r.member_id WHERE r.send_id = ? AND r.status = 'pending' ORDER BY r.member_id LIMIT ?"
                )
                .bind(send.id, BATCH)
                .all<{ member_id: string; email: string; analytics_id: string | null }>();
            if (!batch.length) {
                await finishSend(db, send.id);
                continue;
            }

            let email = templates.get(send.id);
            if (!email) {
                const post = await getPost(db, send.post_id);
                if (!post) {
                    await db.prepare("UPDATE sends SET status = 'failed', error = 'The post was deleted.', finished_at = ? WHERE id = ?").bind(now(), send.id).run();
                    continue;
                }
                email = await buildEmail(env, db, post);
                templates.set(send.id, email);
            }
            const { from, replyTo } = await sender(env, db);
            const extraHeaders = (await newsletterSettings(env, db)).emailHeaders ?? {};
            const postSlug = email.slug ?? '';
            // A test-mode send already holds only team addresses; anything else (the team list changed since) goes to the test inbox.
            const team = send.test_mode ? await testTeam(env, db) : null;
            const messages: EmailMessage[] = await Promise.all(
                batch.map(async r => {
                    const unsub = await unsubscribeUrl(env, r.member_id, send.id);
                    return {
                        to: team && !onTeam(team, r.email) ? testAddress(env) : r.email,
                        from,
                        replyTo,
                        subject: send.subject,
                        html: email!.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, unsub),
                        text: email!.text.replaceAll(UNSUBSCRIBE_PLACEHOLDER, unsub),
                        headers: {
                            ...fillHeaders(extraHeaders, { distinct_id: distinctId({ analytics_id: r.analytics_id, email: r.email }), analytics_id: r.analytics_id ?? '', member_id: r.member_id, post_slug: postSlug, send_id: send.id }),
                            'List-Unsubscribe': `<${unsub}>`,
                            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
                        },
                        idempotencyKey: `${send.id}:${r.member_id}`
                    };
                })
            );
            const results = await transport.send(messages);
            const t = now();
            const stmts: D1PreparedStatement[] = [];
            let ok = 0;
            results.forEach((res, i) => {
                const r = batch[i];
                if (res.ok) ok++;
                stmts.push(
                    db
                        .prepare('UPDATE send_recipients SET status = ?, provider_id = ?, error = ?, updated_at = ? WHERE send_id = ? AND member_id = ?')
                        .bind(res.ok ? 'sent' : 'failed', res.providerId ?? null, res.error ?? null, t, send.id, r.member_id)
                );
                if (res.ok) stmts.push(db.prepare('UPDATE members SET email_count = email_count + 1, last_emailed_at = ? WHERE id = ?').bind(t, r.member_id));
            });
            stmts.push(db.prepare('UPDATE sends SET sent = sent + ?, failed = failed + ? WHERE id = ?').bind(ok, results.length - ok, send.id));
            await batched(db, stmts);
            stats.batches++;
            stats.sent += ok;
            stats.failed += results.length - ok;
            if (ok === 0) {
                // The whole batch failed (bad key, provider down): stop rather than burn through the list.
                await db.prepare("UPDATE sends SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").bind(results[0]?.error ?? 'Sending failed.', now(), send.id).run();
                break;
            }
            await sleep(550);
        }
    } finally {
        if (leased) await db.prepare('UPDATE sends SET lease_until = NULL WHERE id = ?').bind(leased).run();
    }
    return stats;
}

async function finishSend(db: D1Database, sendId: string) {
    const send = await db.prepare('SELECT * FROM sends WHERE id = ?').bind(sendId).first<any>();
    if (!send) return;
    await db.prepare("UPDATE sends SET status = 'sent', finished_at = ? WHERE id = ?").bind(now(), sendId).run();
    if (!send.test_mode) await setPostNewsletter(db, send.post_id, { sentAt: now(), recipients: send.total, delivered: send.delivered, opened: send.opened });
}

export async function listSends(db: D1Database) {
    const { results } = await db.prepare('SELECT s.*, p.title AS post_title, p.slug AS post_slug FROM sends s LEFT JOIN posts p ON p.id = s.post_id ORDER BY s.created_at DESC LIMIT 100').all();
    return results;
}

export async function getSend(db: D1Database, id: string) {
    return db.prepare('SELECT s.*, p.title AS post_title, p.slug AS post_slug FROM sends s LEFT JOIN posts p ON p.id = s.post_id WHERE s.id = ?').bind(id).first();
}

export async function cancelSend(db: D1Database, id: string) {
    await db.prepare("UPDATE sends SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued','sending')").bind(now(), id).run();
    return getSend(db, id);
}

const COUNTER: Record<EmailEvent['type'], string> = { delivered: 'delivered', opened: 'opened', clicked: 'clicked', bounced: 'bounced', complained: 'complained' };

/** Delivery events from the provider: counters on the send, suppression for bounces and complaints. */
export async function recordEmailEvents(db: D1Database, events: EmailEvent[]): Promise<number> {
    let n = 0;
    for (const e of events) {
        const r = e.providerId
            ? await db.prepare('SELECT send_id, member_id FROM send_recipients WHERE provider_id = ?').bind(e.providerId).first<{ send_id: string; member_id: string }>()
            : null;
        // Provider webhooks cover every email on the account. Keep only newsletter events,
        // plus bounces and complaints, which protect the list whatever email caused them.
        if (!r && e.type !== 'bounced' && e.type !== 'complained') continue;
        const stmts: D1PreparedStatement[] = [
            db
                .prepare('INSERT INTO email_events (send_id, member_id, type, provider_id, at, url) VALUES (?, ?, ?, ?, ?, ?)')
                .bind(r?.send_id ?? null, r?.member_id ?? null, e.type, e.providerId ?? null, e.at, e.type === 'clicked' ? cleanLink(e.url) : null)
        ];
        if (r) stmts.push(db.prepare(`UPDATE sends SET ${COUNTER[e.type]} = ${COUNTER[e.type]} + 1 WHERE id = ?`).bind(r.send_id));
        // People, not events: a send's first open (or click) by someone counts once however often they come back.
        if (r && (e.type === 'opened' || e.type === 'clicked')) {
            const unique = e.type === 'opened' ? 'unique_opens' : 'unique_clicks';
            stmts.push(
                db
                    .prepare(`UPDATE sends SET ${unique} = ${unique} + 1 WHERE id = ? AND (SELECT COUNT(*) FROM email_events WHERE send_id = ? AND member_id = ? AND type = ?) = 1`)
                    .bind(r.send_id, r.send_id, r.member_id, e.type)
            );
        }
        if (r && e.type === 'opened') stmts.push(db.prepare('UPDATE members SET opened_count = opened_count + 1 WHERE id = ?').bind(r.member_id));
        await db.batch(stmts);
        if (e.type === 'bounced' || e.type === 'complained') {
            const email = r ? (await db.prepare('SELECT email FROM members WHERE id = ?').bind(r.member_id).first<{ email: string }>())?.email : e.email;
            if (email) await suppress(db, email, e.type);
        }
        n++;
    }
    return n;
}

/**
 * A clicked link without the campaign tags added to it, so clicks on one link group together.
 * Unsubscribe links lose their member and token: they are one link, and tokens are not kept.
 */
function cleanLink(url: string | undefined): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        if (u.pathname.endsWith('/api/unsubscribe')) return `${u.origin}${u.pathname}`;
        for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
        return u.toString().slice(0, 1000);
    } catch {
        return url.slice(0, 1000);
    }
}

/** Adds campaign parameters to every web link in an email, keeping any the link already has. */
export function utmLinks(html: string, params: Record<string, string>): string {
    return html.replace(/(<a\b[^>]*?\bhref=")(https?:\/\/[^"]+)(")/gi, (whole, pre: string, href: string, post: string) => {
        let url: URL;
        try {
            url = new URL(href.replace(/&amp;/g, '&'));
        } catch {
            return whole;
        }
        for (const [k, v] of Object.entries(params)) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
        return `${pre}${url.toString().replace(/&/g, '&amp;')}${post}`;
    });
}

/** Header templates with {name} filled in; a header whose value comes out empty is left off. */
function fillHeaders(templates: Record<string, string>, values: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, template] of Object.entries(templates)) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof template !== 'string') continue;
        const value = template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? '').replace(/[\r\n]/g, '').slice(0, 500);
        if (value) out[name] = value;
    }
    return out;
}
