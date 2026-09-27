import type { SiteSettings } from '@masthead/core';

/** A post as clean Markdown, for AI crawlers and anyone who wants the text without the page. */
export function markdownCopy(p: { title: string; url: string; authors: string[]; publishedAt: string | null; updatedAt: string; markdown: string }): string {
    const byline = [p.authors.length ? `By ${p.authors.join(', ')}` : '', p.publishedAt ? `Published ${p.publishedAt.slice(0, 10)}` : '', `Updated ${p.updatedAt.slice(0, 10)}`]
        .filter(Boolean)
        .join(' · ');
    return `# ${p.title}\n\n${byline}\nSource: ${p.url}\n\n${p.markdown.trim()}\n`;
}

export interface LlmsEntry {
    title: string;
    url: string;
    summary: string;
}

/** llms.txt (llmstxt.org): a map of the publication for language models. */
export function llmsTxt(site: SiteSettings, posts: LlmsEntry[], pages: LlmsEntry[]): string {
    const line = (e: LlmsEntry) => `- [${e.title.replace(/[[\]]/g, '')}](${e.url})${e.summary ? `: ${e.summary.replace(/\s+/g, ' ')}` : ''}`;
    return [
        `# ${site.title}`,
        '',
        `> ${site.description}`,
        '',
        'Every post is also available as Markdown at the same address with .md in place of the trailing slash.',
        '',
        '## Posts',
        '',
        ...posts.map(line),
        ...(pages.length ? ['', '## Pages', '', ...pages.map(line)] : []),
        ''
    ].join('\n');
}
