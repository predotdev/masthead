import type { SiteSettings } from '@masthead/core';
import { cdata, escapeXml, rfc822 } from './util';

export interface FeedItem {
    title: string;
    url: string;
    id: string;
    publishedAt: string;
    updatedAt: string;
    excerpt: string;
    html: string;
    authors: string[];
    tags: string[];
    image?: string | null;
}

/** RSS 2.0 with full content, the format feed readers and aggregators expect. */
export function rss(site: SiteSettings, feedUrl: string, items: FeedItem[]): string {
    const newest = items[0]?.updatedAt ?? new Date().toISOString();
    const entries = items
        .map(
            it => `    <item>
      <title>${cdata(it.title)}</title>
      <link>${escapeXml(it.url)}</link>
      <guid isPermaLink="false">${escapeXml(it.id)}</guid>
      <pubDate>${rfc822(it.publishedAt)}</pubDate>
${it.authors.map(a => `      <dc:creator>${cdata(a)}</dc:creator>`).join('\n')}
${it.tags.map(t => `      <category>${cdata(t)}</category>`).join('\n')}
      <description>${cdata(it.excerpt)}</description>
${it.image ? `      <media:content url="${escapeXml(it.image)}" medium="image"/>\n` : ''}      <content:encoded>${cdata(it.html)}</content:encoded>
    </item>`
        )
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${cdata(site.title)}</title>
    <description>${cdata(site.about || site.description)}</description>
    <link>${escapeXml(site.url)}</link>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>
    <language>${escapeXml(site.locale)}</language>
    <lastBuildDate>${rfc822(newest)}</lastBuildDate>
    <generator>Masthead</generator>
${entries}
  </channel>
</rss>
`;
}

export interface SitemapEntry {
    url: string;
    lastmod?: string | null;
    image?: string | null;
}

export function urlset(entries: SitemapEntry[]): string {
    const rows = entries
        .map(
            e => `  <url>
    <loc>${escapeXml(e.url)}</loc>${e.lastmod ? `\n    <lastmod>${escapeXml(e.lastmod)}</lastmod>` : ''}${
                e.image ? `\n    <image:image><image:loc>${escapeXml(e.image)}</image:loc></image:image>` : ''
            }
  </url>`
        )
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${rows}
</urlset>
`;
}

export function sitemapIndex(children: { url: string; lastmod?: string | null }[]): string {
    const rows = children
        .map(c => `  <sitemap>\n    <loc>${escapeXml(c.url)}</loc>${c.lastmod ? `\n    <lastmod>${escapeXml(c.lastmod)}</lastmod>` : ''}\n  </sitemap>`)
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows}
</sitemapindex>
`;
}
