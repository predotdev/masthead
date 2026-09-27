export const now = () => new Date().toISOString();

/** 24 hex characters, the same shape as ids imported from Ghost. */
export function newId(): string {
    return hex(crypto.getRandomValues(new Uint8Array(12)));
}

export function randomToken(bytes = 32): string {
    return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function hex(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
}

export function b64url(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function sha256(input: string | Uint8Array): Promise<string> {
    const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

export async function hmac(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))).slice(0, 32);
}

export function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
    }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export function redirect(location: string, status = 302, headers: Record<string, string> = {}): Response {
    return new Response(null, { status, headers: { location, ...headers } });
}

export function cookies(req: Request): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (req.headers.get('cookie') ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** JSON or form body as a plain object. */
export async function body(req: Request): Promise<Record<string, any>> {
    const type = req.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
        try {
            const data = await req.json();
            return data && typeof data === 'object' ? (data as Record<string, any>) : {};
        } catch {
            throw new HttpError(400, 'The request body is not valid JSON.');
        }
    }
    if (type.includes('form')) {
        const form = await req.formData();
        const out: Record<string, any> = {};
        form.forEach((v, k) => (out[k] = typeof v === 'string' ? v : v));
        return out;
    }
    return {};
}

export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function isEmail(s: unknown): s is string {
    return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function slugify(s: string): string {
    return (
        s
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 180) || 'untitled'
    );
}

export function csvEscape(v: unknown): string {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (c === '"') quoted = false;
            else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') {
            row.push(cell);
            cell = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else cell += c;
    }
    if (cell || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows.filter(r => r.some(c => c.trim()));
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
