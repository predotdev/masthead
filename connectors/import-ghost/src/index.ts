/**
 * Import a Ghost site through the Ghost Admin API.
 *
 * Needs a custom integration's Admin API key (Ghost admin -> Settings ->
 * Integrations). Everything here is a read.
 *
 * - importGhost() returns a Snapshot: settings, posts and pages (with their
 *   original HTML plus a Markdown copy), tags, authors and staff accounts.
 * - exportGhostAudience() returns newsletter members and their subscribe /
 *   unsubscribe history. That is personal data: keep the file private.
 */
import type {
    AudienceExport,
    Author,
    ContentSource,
    MemberEventRecord,
    MemberRecord,
    NavigationItem,
    Post,
    SiteSettings,
    Snapshot,
    StaffRecord,
    StaffRole,
    Tag
} from '@masthead/core';
import TurndownService from 'turndown';

export interface GhostImportOptions {
    /** Admin API base: the URL Ghost is configured with, e.g. https://example.com/blog */
    url: string;
    /** "<id>:<secret>" from a custom integration. */
    adminKey: string;
    /** Also import drafts and scheduled posts. Default true. */
    includeDrafts?: boolean;
    fetch?: typeof fetch;
    onProgress?: (message: string) => void;
}

export function ghost(options: GhostImportOptions): ContentSource {
    return { id: 'ghost', load: () => importGhost(options) };
}

// ------------------------------------------------------------------ content

export async function importGhost(options: GhostImportOptions): Promise<Snapshot> {
    const client = ghostClient(options);
    const [siteRes, settingsRes, users, tags, newsletters] = await Promise.all([
        client.get('site/'),
        client.get('settings/'),
        client.all('users', 'include=roles'),
        client.all('tags', ''),
        client.all('newsletters', '')
    ]);
    const statuses = options.includeDrafts === false ? 'published,sent' : 'published,sent,scheduled,draft';
    const query = `filter=${encodeURIComponent(`status:[${statuses}]`)}&formats=html&include=tags,authors,email&order=published_at%20desc`;
    const [posts, pages] = await Promise.all([client.all('posts', query), client.all('pages', query.replace(',email', ''))]);

    const s: Record<string, any> = {};
    for (const row of settingsRes.settings ?? []) s[row.key] = row.value;
    const site = siteRes.site ?? {};
    const siteUrl = ensureSlash(String(site.url ?? options.url));
    const origin = new URL(siteUrl).origin;
    const primaryNewsletter = newsletters.find((n: any) => n.status === 'active') ?? newsletters[0];

    const settings: SiteSettings = {
        url: siteUrl,
        title: String(s.title ?? site.title ?? ''),
        description: String(s.description ?? site.description ?? ''),
        metaTitle: s.meta_title ?? null,
        metaDescription: s.meta_description ?? null,
        ogTitle: s.og_title ?? null,
        ogDescription: s.og_description ?? null,
        locale: String(s.locale ?? site.locale ?? 'en'),
        logo: s.logo ?? null,
        icon: s.icon ?? null,
        shareImage: s.og_image ?? s.cover_image ?? null,
        accentColor: s.accent_color ?? null,
        twitter: s.twitter ?? null,
        navigation: parseNavigation(s.navigation),
        publisher: { name: String(s.title ?? site.title ?? origin), url: origin, logo: s.logo ?? null }
    };

    return {
        format: 'masthead.snapshot/1',
        exportedAt: new Date().toISOString(),
        source: `ghost ${site.version ?? ''}`.trim(),
        site: settings,
        authors: users.map(toAuthor),
        staff: users.map(toStaff),
        tags: tags.map(toTag),
        newsletter: primaryNewsletter
            ? {
                  senderName: primaryNewsletter.sender_name ?? null,
                  senderEmail: primaryNewsletter.sender_email ?? null,
                  replyTo: primaryNewsletter.sender_reply_to === 'support' ? (s.members_support_address ?? null) : null
              }
            : undefined,
        posts: [...posts.map((p: any) => toPost(p, 'post')), ...pages.map((p: any) => toPost(p, 'page'))]
    };
}

function toAuthor(u: any): Author {
    return {
        id: String(u.id),
        slug: String(u.slug),
        name: String(u.name ?? u.slug),
        bio: u.bio ?? null,
        profileImage: u.profile_image ?? null,
        website: u.website ?? null,
        twitter: u.twitter ?? u.x ?? null,
        linkedin: u.linkedin ?? null
    };
}

const ROLE_MAP: Record<string, StaffRole> = {
    owner: 'owner',
    administrator: 'admin',
    editor: 'editor',
    'super editor': 'editor',
    author: 'author',
    contributor: 'contributor'
};

function toStaff(u: any): StaffRecord {
    const roleName = String(u.roles?.[0]?.name ?? 'Author').toLowerCase();
    return {
        ...toAuthor(u),
        email: String(u.email ?? '').toLowerCase(),
        role: ROLE_MAP[roleName] ?? 'author',
        status: u.status === 'inactive' || u.status === 'locked' ? 'suspended' : 'active'
    };
}

function toTag(t: any): Tag {
    return {
        id: String(t.id),
        slug: String(t.slug),
        name: String(t.name),
        description: t.description ?? null,
        visibility: t.visibility === 'internal' ? 'internal' : 'public'
    };
}

function toPost(p: any, type: 'post' | 'page'): Post {
    const status = p.status === 'published' || p.status === 'sent' ? 'published' : p.status === 'scheduled' ? 'scheduled' : 'draft';
    const html = p.html ?? '';
    const e = p.email;
    return {
        id: String(p.id),
        type,
        slug: String(p.slug),
        title: String(p.title ?? ''),
        status,
        bodyFormat: 'html',
        html,
        markdown: html ? htmlToMarkdown(html) : '',
        customExcerpt: p.custom_excerpt ?? null,
        featureImage: p.feature_image ?? null,
        featureImageAlt: p.feature_image_alt ?? null,
        featureImageCaption: p.feature_image_caption ?? null,
        metaTitle: p.meta_title ?? null,
        metaDescription: p.meta_description ?? null,
        ogImage: p.og_image ?? null,
        ogTitle: p.og_title ?? null,
        ogDescription: p.og_description ?? null,
        twitterImage: p.twitter_image ?? null,
        twitterTitle: p.twitter_title ?? null,
        twitterDescription: p.twitter_description ?? null,
        canonicalUrl: p.canonical_url ?? null,
        featured: Boolean(p.featured),
        publishedAt: p.published_at ?? null,
        updatedAt: String(p.updated_at ?? p.published_at ?? p.created_at),
        createdAt: String(p.created_at),
        authors: (p.authors ?? []).map((a: any) => String(a.id)),
        tags: (p.tags ?? []).map((t: any) => String(t.id)),
        newsletter:
            e && Number(e.email_count) > 1
                ? {
                      sentAt: e.submitted_at ?? e.created_at ?? null,
                      recipients: Number(e.email_count) || 0,
                      delivered: Number(e.delivered_count) || 0,
                      opened: Number(e.opened_count) || 0
                  }
                : null
    };
}

// ------------------------------------------------------------------ audience

/** Members with their newsletter status, suppressions and subscribe history. */
export async function exportGhostAudience(options: GhostImportOptions): Promise<AudienceExport> {
    const client = ghostClient(options);
    const log = options.onProgress ?? (() => {});
    const first = await client.get('members/?limit=1');
    const total = Number(first.meta?.pagination?.total ?? 0);
    const pageSize = 100;
    const pages = Math.ceil(total / pageSize);
    const rows: any[] = [];
    // Four pages at a time stays well inside the Admin API's rate limits.
    for (let start = 1; start <= pages; start += 4) {
        const batch = await Promise.all(
            Array.from({ length: Math.min(4, pages - start + 1) }, (_, i) =>
                client.get(`members/?limit=${pageSize}&page=${start + i}&include=labels&order=created_at%20asc`)
            )
        );
        for (const b of batch) rows.push(...(b.members ?? []));
        log(`members ${rows.length}/${total}`);
    }

    const byId = new Map<string, any>(rows.map(m => [String(m.id), m]));
    const events: MemberEventRecord[] = [];
    let cursor = '';
    for (;;) {
        const f = cursor ? `type:newsletter_event+data.created_at:<'${cursor}'` : 'type:newsletter_event';
        const res = await client.get(`members/events/?limit=100&filter=${encodeURIComponent(f)}`);
        const list: any[] = res.events ?? [];
        if (!list.length) break;
        for (const e of list) {
            const m = byId.get(String(e.data?.member_id));
            if (!m) continue;
            const src = String(e.data?.source ?? 'import');
            events.push({
                email: String(m.email).toLowerCase(),
                type: e.data?.subscribed ? 'subscribed' : 'unsubscribed',
                source: src === 'member' || src === 'admin' || src === 'api' || src === 'import' ? src : 'import',
                at: String(e.data?.created_at)
            });
        }
        const last = String(list[list.length - 1].data?.created_at ?? '');
        const next = last.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
        if (!next || next === cursor) break;
        cursor = next;
        log(`events ${events.length}`);
    }
    events.sort((a, b) => a.at.localeCompare(b.at));

    // Members who unsubscribed themselves and were later re-subscribed by an
    // integration are flagged for review, never silently changed.
    const optedOut = new Set<string>();
    const resubscribed = new Set<string>();
    for (const e of events) {
        if (e.type === 'unsubscribed' && e.source === 'member') {
            optedOut.add(e.email);
            resubscribed.delete(e.email);
        } else if (e.type === 'subscribed' && e.source === 'member') {
            optedOut.delete(e.email);
            resubscribed.delete(e.email);
        } else if (e.type === 'subscribed' && optedOut.has(e.email)) {
            resubscribed.add(e.email);
        }
    }

    const members: MemberRecord[] = rows.map(m => {
        const email = String(m.email).toLowerCase();
        const reason = String(m.email_suppression?.info?.reason ?? '');
        const suppressed = m.email_suppression?.suppressed ? (reason.includes('spam') || reason.includes('complain') ? 'complained' : 'bounced') : null;
        const subscribed = Array.isArray(m.newsletters) ? m.newsletters.length > 0 : Boolean(m.subscribed);
        return {
            email,
            name: m.name ?? null,
            status: subscribed ? 'subscribed' : 'unsubscribed',
            suppressed,
            labels: (m.labels ?? []).map((l: any) => String(l.name)),
            note: m.note ?? null,
            createdAt: String(m.created_at),
            emailCount: Number(m.email_count) || 0,
            openedCount: Number(m.email_opened_count) || 0,
            externalId: String(m.id),
            externalUuid: m.uuid ? String(m.uuid) : null,
            flags: subscribed && resubscribed.has(email) ? ['resubscribed-after-opt-out'] : []
        };
    });

    return { format: 'masthead.audience/1', exportedAt: new Date().toISOString(), source: 'ghost', members, events };
}

// ------------------------------------------------------------------ helpers

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
turndown.remove(['script', 'style']);
turndown.addRule('embeds', {
    filter: node => node.nodeName === 'IFRAME' || node.nodeName === 'VIDEO',
    replacement: (_content, node) => {
        const src = (node as any).getAttribute?.('src') ?? '';
        return src ? `\n\n[${node.nodeName === 'VIDEO' ? 'Video' : 'Embedded content'}](${src})\n\n` : '';
    }
});

/** A readable Markdown version of an imported HTML body. */
export function htmlToMarkdown(html: string): string {
    return turndown.turndown(html).trim();
}

function parseNavigation(value: unknown): NavigationItem[] {
    const raw = typeof value === 'string' ? safeJson(value) : value;
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((n: any) => n && typeof n.url === 'string')
        .map((n: any) => ({ label: String(n.label ?? '').trim(), url: String(n.url) }));
}

function safeJson(s: string): unknown {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

function ensureSlash(u: string): string {
    return u.endsWith('/') ? u : `${u}/`;
}

function ghostClient(options: GhostImportOptions) {
    const base = `${options.url.replace(/\/+$/, '')}/ghost/api/admin/`;
    const doFetch = options.fetch ?? fetch;
    const [id, secret] = options.adminKey.split(':');
    if (!id || !secret) throw new Error('The Ghost Admin API key must look like "<id>:<secret>".');

    async function token(): Promise<string> {
        const now = Math.floor(Date.now() / 1000);
        const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }));
        const payload = b64url(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' }));
        const keyBytes = new Uint8Array(secret.match(/.{2}/g)!.map(h => parseInt(h, 16)));
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
        return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
    }

    async function get(path: string, attempt = 0): Promise<any> {
        const res = await doFetch(base + path, { headers: { authorization: `Ghost ${await token()}`, 'accept-version': 'v6.0' } });
        if ((res.status === 429 || res.status >= 500) && attempt < 4) {
            await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
            return get(path, attempt + 1);
        }
        if (!res.ok) throw new Error(`Ghost Admin API ${path.split('?')[0]} returned ${res.status}.`);
        return res.json();
    }

    async function all(resource: string, query: string): Promise<any[]> {
        const out: any[] = [];
        for (let page = 1; ; ) {
            const body = await get(`${resource}/?limit=100&page=${page}${query ? `&${query}` : ''}`);
            out.push(...(body[resource] ?? []));
            const next = body.meta?.pagination?.next;
            if (!next) return out;
            page = next;
        }
    }

    return { get, all };
}

function b64url(input: string | Uint8Array): string {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
