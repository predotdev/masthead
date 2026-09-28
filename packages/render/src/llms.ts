import type { SiteSettings } from '@masthead/core';

/** What the publisher says about itself, for readers who arrive at any one file. */
function aboutText(site: SiteSettings): string {
    return (site.about ?? site.publisher?.description ?? '').replace(/\s+/g, ' ').trim();
}

function publisherName(site: SiteSettings): string {
    return site.publisher?.name ?? site.title;
}

/** The name a language model should call the publication: the front page's wordmark ("pre.dev blog"), else the title. */
function heading(site: SiteSettings): string {
    return site.appearance?.hero?.title || site.title;
}

/** The one-line summary under the heading: who publishes, and what they do, before the blog's own blurb. */
function summaryLine(site: SiteSettings): string {
    return aboutText(site) || site.metaDescription || site.description;
}

function aboutSection(site: SiteSettings): string[] {
    const text = aboutText(site);
    const offers = site.offerings ?? [];
    if (!text && !offers.length) return [];
    return [
        `## About ${publisherName(site)}`,
        '',
        ...(text ? [text, ''] : []),
        ...offers.map(o => `- [${o.name.replace(/[[\]]/g, '')}](${o.url}): ${o.description.replace(/\s+/g, ' ')}`),
        ...(offers.length ? [''] : [])
    ];
}

/** A post as clean Markdown, for AI crawlers and anyone who wants the text without the page. */
export function markdownCopy(
    p: { title: string; url: string; authors: string[]; publishedAt: string | null; updatedAt: string; markdown: string },
    site?: SiteSettings
): string {
    const byline = [p.authors.length ? `By ${p.authors.join(', ')}` : '', p.publishedAt ? `Published ${p.publishedAt.slice(0, 10)}` : '', `Updated ${p.updatedAt.slice(0, 10)}`]
        .filter(Boolean)
        .join(' · ');
    const about = site ? aboutText(site) : '';
    const footer = about ? `\n---\n\nAbout ${publisherName(site!)}: ${about}${site!.publisher?.url ? ` ${site!.publisher.url}` : ''}\n` : '';
    return `# ${p.title}\n\n${byline}\nSource: ${p.url}\n\n${p.markdown.trim()}\n${footer}`;
}

export interface LlmsEntry {
    title: string;
    url: string;
    summary: string;
}

export interface LlmsLinks {
    /** llms-full.txt */
    full?: string;
    rss?: string;
    sitemap?: string;
}

/** llms.txt (llmstxt.org): a map of the publication for language models. */
export function llmsTxt(site: SiteSettings, posts: LlmsEntry[], pages: LlmsEntry[], links: string | LlmsLinks = {}): string {
    const l: LlmsLinks = typeof links === 'string' ? { full: links } : links;
    const line = (e: LlmsEntry) => `- [${e.title.replace(/[[\]]/g, '')}](${e.url})${e.summary ? `: ${e.summary.replace(/\s+/g, ' ')}` : ''}`;
    const optional = [
        ...(l.full ? [`- [Full text of the newest posts](${l.full}): every post in one file`] : []),
        ...(l.rss ? [`- [RSS feed](${l.rss})`] : []),
        ...(l.sitemap ? [`- [Sitemap](${l.sitemap})`] : [])
    ];
    return [
        `# ${heading(site)}`,
        '',
        `> ${summaryLine(site)}`,
        '',
        'Every post is also available as Markdown at the same address with .md in place of the trailing slash.',
        ...(l.full ? [`The full text of the newest posts is in one file: ${l.full}`] : []),
        '',
        ...aboutSection(site),
        '## Posts',
        '',
        ...posts.map(line),
        ...(pages.length ? ['', '## Pages', '', ...pages.map(line)] : []),
        ...(optional.length ? ['', '## Optional', '', ...optional] : []),
        ''
    ].join('\n');
}

/** llms-full.txt: the newest posts' full text in one file, for models that read a whole publication at once. */
export function llmsFull(site: SiteSettings, posts: { title: string; url: string; authors: string[]; publishedAt: string | null; updatedAt: string; markdown: string }[], total: number): string {
    const head = [
        `# ${heading(site)}`,
        '',
        `> ${summaryLine(site)}`,
        '',
        ...aboutSection(site),
        total > posts.length ? `The ${posts.length} newest of ${total} posts. Every post is also at its own address with .md in place of the trailing slash.` : `All ${total} posts.`,
        ''
    ];
    return `${[...head, ...posts.map(p => markdownCopy(p))].join('\n')}`;
}
