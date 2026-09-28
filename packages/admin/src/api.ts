import { signal } from '@preact/signals';

/** The blog's base path, e.g. "/blog/", read from where the admin is served. */
export const base = location.pathname.replace(/admin(\/.*)?$/, '');

export interface Me {
    user: { staffId: string; email: string; name: string; role: 'owner' | 'admin' | 'editor' | 'author' | 'contributor'; via: string };
    site: { title: string; url: string; icon: string | null };
    appUrl: string;
    testMode: boolean;
}

export const session = signal<Me | null | undefined>(undefined);

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
    }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const isForm = init.body instanceof FormData;
    const isText = typeof init.body === 'string';
    const res = await fetch(`${base}admin/api${path}`, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        credentials: 'same-origin',
        headers: { 'x-masthead': '1', ...(init.body !== undefined && !isForm && !isText ? { 'content-type': 'application/json' } : {}), ...(isText ? { 'content-type': 'text/csv' } : {}) },
        body: init.body === undefined ? undefined : isForm || isText ? (init.body as BodyInit) : JSON.stringify(init.body)
    });
    if (res.status === 401 && !path.startsWith('/auth')) {
        session.value = null;
        throw new ApiError(401, 'Sign in to continue.');
    }
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new ApiError(res.status, (data as any)?.error ?? `Request failed (${res.status}).`);
    return data as T;
}

export async function upload(file: File): Promise<string> {
    const form = new FormData();
    form.append('file', file);
    const { url } = await api<{ url: string }>('/media', { body: form });
    return url;
}

export interface Post {
    id: string;
    type: 'post' | 'page';
    slug: string;
    title: string;
    status: 'draft' | 'scheduled' | 'published';
    bodyFormat: 'markdown' | 'html';
    markdown: string | null;
    html: string | null;
    customExcerpt: string | null;
    featureImage: string | null;
    featureImageAlt: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
    featured: boolean;
    publishedAt: string | null;
    updatedAt: string;
    createdAt: string;
    tags: string[];
    authors: string[];
    newsletter: { sentAt: string | null; recipients: number; delivered: number; opened: number } | null;
    /** The day a draft is planned for (YYYY-MM-DD), on the calendar. */
    targetDate?: string | null;
    /** Where its review stands, in lists. */
    review?: { status: 'in_review' | 'approved' | 'changes_requested'; approved: number; reviewers: number } | null;
}

export interface Tag {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    visibility: 'public' | 'internal';
    posts?: number;
}

export interface Staff {
    id: string;
    email: string;
    name: string;
    slug: string;
    role: Me['user']['role'];
    status: 'active' | 'invited' | 'suspended';
    profileImage: string | null;
    lastSeenAt: string | null;
}

export const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString();

/** "now", "5m", "3h", "2d", then the date: for comments and notifications. */
export function fmtAgo(iso: string | null | undefined): string {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
}

/** "just now", "5 minutes ago", "yesterday", "on Sep 3": for sentences. */
export function fmtSince(iso: string | null | undefined): string {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
    if (s < 86400) return rtf.format(-Math.floor(s / 3600), 'hour');
    if (s < 7 * 86400) return rtf.format(-Math.floor(s / 86400), 'day');
    return `on ${fmtDate(iso)}`;
}

/** A local calendar day as YYYY-MM-DD. */
export function dayKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD as a local date at midnight. */
export function fromDayKey(key: string): Date {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
}
