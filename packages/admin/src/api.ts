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
