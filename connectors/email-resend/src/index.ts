/**
 * Resend transport: batches of up to 100 messages per call, an idempotency
 * key per batch so a retried batch is never delivered twice, and signed
 * webhook verification for delivery, bounce and complaint events.
 */
import type { EmailEvent, EmailMessage, EmailTransport, SendResult } from '@masthead/core';

export interface ResendOptions {
    apiKey: string;
    /** The signing secret ("whsec_...") of the webhook you point at Masthead. */
    webhookSecret?: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}

export const RESEND_BATCH_LIMIT = 100;

export function resend(options: ResendOptions): EmailTransport {
    const base = (options.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '');
    const doFetch = options.fetch ?? fetch;

    async function post(path: string, body: unknown, idempotencyKey?: string): Promise<any> {
        for (let attempt = 0; ; attempt++) {
            const res = await doFetch(`${base}${path}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${options.apiKey}`,
                    'content-type': 'application/json',
                    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
                },
                body: JSON.stringify(body)
            });
            const text = await res.text();
            const data = text ? safeJson(text) : null;
            if (res.ok) return data;
            // Rate limited or a transient failure: back off and retry the same idempotent request.
            if ((res.status === 429 || res.status >= 500) && attempt < 4) {
                const wait = Number(res.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt;
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            throw new Error(`Resend ${path} returned ${res.status}: ${data?.message ?? text.slice(0, 200)}`);
        }
    }

    return {
        id: 'resend',

        async send(batch: EmailMessage[]): Promise<SendResult[]> {
            if (!batch.length) return [];
            if (batch.length > RESEND_BATCH_LIMIT) throw new Error(`Resend accepts at most ${RESEND_BATCH_LIMIT} messages per batch.`);
            const payload = batch.map(m => ({
                from: m.from,
                to: [m.to],
                subject: m.subject,
                html: m.html,
                text: m.text,
                ...(m.replyTo ? { reply_to: m.replyTo } : {}),
                ...(m.headers ? { headers: m.headers } : {})
            }));
            const key = batch.length === 1 ? batch[0].idempotencyKey : `batch:${batch[0].idempotencyKey}:${batch.length}`;
            try {
                const data = batch.length === 1 ? { data: [await post('/emails', payload[0], key)] } : await post('/emails/batch', payload, key);
                const ids: any[] = Array.isArray(data?.data) ? data.data : [];
                return batch.map((m, i) => ({ idempotencyKey: m.idempotencyKey, ok: Boolean(ids[i]?.id), providerId: ids[i]?.id, error: ids[i]?.id ? undefined : 'No id returned' }));
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                return batch.map(m => ({ idempotencyKey: m.idempotencyKey, ok: false, error }));
            }
        },

        async events(request: Request): Promise<EmailEvent[]> {
            const body = await request.text();
            if (options.webhookSecret) await verifySvix(options.webhookSecret, request.headers, body);
            const evt = safeJson(body);
            const type = String(evt?.type ?? '');
            const map: Record<string, EmailEvent['type']> = {
                'email.delivered': 'delivered',
                'email.bounced': 'bounced',
                'email.complained': 'complained',
                'email.opened': 'opened',
                'email.clicked': 'clicked'
            };
            const mapped = map[type];
            if (!mapped) return [];
            const to = evt?.data?.to;
            return [
                {
                    type: mapped,
                    email: String(Array.isArray(to) ? to[0] : (to ?? '')).toLowerCase(),
                    at: String(evt?.created_at ?? new Date().toISOString()),
                    providerId: evt?.data?.email_id ? String(evt.data.email_id) : undefined
                }
            ];
        }
    };
}

/** Svix signature check, the scheme Resend signs webhooks with. */
async function verifySvix(secret: string, headers: Headers, body: string): Promise<void> {
    const id = headers.get('svix-id');
    const timestamp = headers.get('svix-timestamp');
    const signatures = headers.get('svix-signature');
    if (!id || !timestamp || !signatures) throw new WebhookError('Missing signature headers.');
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new WebhookError('Webhook timestamp is too old.');
    const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
    const expected = btoa(String.fromCharCode(...mac));
    const ok = signatures.split(' ').some(part => {
        const [version, sig] = part.split(',');
        return version === 'v1' && sig !== undefined && timingSafeEqual(sig, expected);
    });
    if (!ok) throw new WebhookError('Webhook signature does not match.');
}

export class WebhookError extends Error {
    readonly status = 401;
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function safeJson(s: string): any {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}
