import type { Author, Post, SiteSettings, Tag } from '@masthead/core';
import { escapeHtml } from './util';

export interface HeadInput {
    site: SiteSettings;
    title: string;
    description: string;
    canonical: string;
    type: 'website' | 'article' | 'profile';
    image?: string | null;
    imageAlt?: string | null;
    /** The share image's size, when known (for og:image:width and og:image:height). */
    imageSize?: { width: number; height: number } | null;
    /** Author names, shown as "Written by" in link previews on Slack and X. */
    authors?: string[];
    publishedAt?: string | null;
    updatedAt?: string | null;
    tags?: Tag[];
    rss: string;
    markdown?: string;
    prev?: string;
    next?: string;
    jsonLd: object[];
}

/** Share cards, feeds and structured data for <head>. Title, description and canonical are written by the theme. */
export function headTags(h: HeadInput): string {
    const handle = h.site.twitter ? (h.site.twitter.startsWith('@') ? h.site.twitter : `@${h.site.twitter}`) : null;
    const image = h.image ?? h.site.shareImage ?? null;
    const tags: string[] = [
        meta('property', 'og:site_name', h.site.title),
        meta('property', 'og:type', h.type),
        meta('property', 'og:title', h.title),
        meta('property', 'og:description', h.description),
        meta('property', 'og:url', h.canonical),
        meta('property', 'og:locale', h.site.locale.replace('-', '_')),
        image ? meta('property', 'og:image', image) : '',
        image && h.imageAlt ? meta('property', 'og:image:alt', h.imageAlt) : '',
        image && h.imageSize ? meta('property', 'og:image:width', String(h.imageSize.width)) : '',
        image && h.imageSize ? meta('property', 'og:image:height', String(h.imageSize.height)) : '',
        h.publishedAt ? meta('property', 'article:published_time', h.publishedAt) : '',
        h.updatedAt ? meta('property', 'article:modified_time', h.updatedAt) : '',
        ...(h.tags ?? []).map(t => meta('property', 'article:tag', t.name)),
        meta('name', 'twitter:card', image ? 'summary_large_image' : 'summary'),
        meta('name', 'twitter:title', h.title),
        meta('name', 'twitter:description', h.description),
        image ? meta('name', 'twitter:image', image) : '',
        handle ? meta('name', 'twitter:site', handle) : '',
        h.authors?.length ? meta('name', 'twitter:label1', 'Written by') : '',
        h.authors?.length ? meta('name', 'twitter:data1', h.authors.join(', ')) : '',
        h.tags?.length ? meta('name', 'twitter:label2', 'Filed under') : '',
        h.tags?.length ? meta('name', 'twitter:data2', h.tags.map(t => t.name).join(', ')) : '',
        `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(h.site.title)}" href="${escapeHtml(h.rss)}">`,
        h.markdown ? `<link rel="alternate" type="text/markdown" href="${escapeHtml(h.markdown)}">` : '',
        h.prev ? `<link rel="prev" href="${escapeHtml(h.prev)}">` : '',
        h.next ? `<link rel="next" href="${escapeHtml(h.next)}">` : '',
        '<meta name="generator" content="Masthead">',
        ...h.jsonLd.map(o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`)
    ];
    return tags.filter(Boolean).join('\n');
}

function meta(attr: 'name' | 'property', key: string, value: string): string {
    return `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
}

// ------------------------------------------------------------------ structured data

function publisher(site: SiteSettings) {
    const p = site.publisher ?? { name: site.title, url: new URL(site.url).origin, logo: site.logo };
    return {
        '@type': 'Organization',
        name: p.name,
        url: p.url,
        ...(p.logo ? { logo: { '@type': 'ImageObject', url: p.logo } } : {}),
        ...(p.sameAs?.length ? { sameAs: p.sameAs } : {})
    };
}

export function personLd(author: Author, url: string) {
    return {
        '@type': 'Person',
        name: author.name,
        url,
        ...(author.profileImage ? { image: author.profileImage } : {}),
        ...(sameAs(author).length ? { sameAs: sameAs(author) } : {})
    };
}

function sameAs(a: Author): string[] {
    const out: string[] = [];
    if (a.website) out.push(a.website);
    if (a.twitter) out.push(a.twitter.startsWith('http') ? a.twitter : `https://x.com/${a.twitter.replace(/^@/, '')}`);
    if (a.linkedin) out.push(a.linkedin.startsWith('http') ? a.linkedin : `https://www.linkedin.com/in/${a.linkedin}`);
    return out;
}

export function blogPostingLd(p: {
    post: Post;
    url: string;
    description: string;
    image?: string | null;
    imageSize?: { width: number; height: number } | null;
    authors: { author: Author; url: string }[];
    tags: Tag[];
    words: number;
    site: SiteSettings;
}) {
    return {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: p.post.title.slice(0, 110),
        description: p.description,
        url: p.url,
        mainEntityOfPage: { '@type': 'WebPage', '@id': p.url },
        ...(p.image ? { image: { '@type': 'ImageObject', url: p.image, ...(p.imageSize ? { width: p.imageSize.width, height: p.imageSize.height } : {}) } } : {}),
        datePublished: p.post.publishedAt,
        dateModified: p.post.updatedAt,
        author: p.authors.map(a => personLd(a.author, a.url)),
        publisher: publisher(p.site),
        ...(p.tags.length ? { keywords: p.tags.map(t => t.name).join(', '), articleSection: p.tags[0].name } : {}),
        wordCount: p.words,
        inLanguage: p.site.locale,
        isPartOf: { '@type': 'Blog', '@id': p.site.url, name: p.site.title }
    };
}

export function breadcrumbLd(items: { name: string; url: string }[]) {
    return {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url }))
    };
}

export function blogLd(site: SiteSettings) {
    return {
        '@context': 'https://schema.org',
        '@type': 'Blog',
        '@id': site.url,
        name: site.title,
        url: site.url,
        description: site.description,
        inLanguage: site.locale,
        publisher: publisher(site)
    };
}

export function collectionLd(name: string, url: string, description?: string | null) {
    return {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name,
        url,
        ...(description ? { description } : {})
    };
}

export function profileLd(author: Author, url: string) {
    return { '@context': 'https://schema.org', '@type': 'ProfilePage', url, mainEntity: personLd(author, url) };
}
