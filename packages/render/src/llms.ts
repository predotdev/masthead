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
export function llmsTxt(site: SiteSettings, posts: LlmsEntry[], pages: LlmsEntry[], fullUrl?: string): string {
    const line = (e: LlmsEntry) => `- [${e.title.replace(/[[\]]/g, '')}](${e.url})${e.summary ? `: ${e.summary.replace(/\s+/g, ' ')}` : ''}`;
    return [
        `# ${site.title}`,
        '',
        `> ${site.description}`,
        '',
        'Every post is also available as Markdown at the same address with .md in place of the trailing slash.',
        ...(fullUrl ? [`The full text of the newest posts is in one file: ${fullUrl}`] : []),
        '',
        '## Posts',
        '',
        ...posts.map(line),
        ...(pages.length ? ['', '## Pages', '', ...pages.map(line)] : []),
        ''
    ].join('\n');
}

/** llms-full.txt: the newest posts' full text in one file, for models that read a whole publication at once. */
export function llmsFull(site: SiteSettings, posts: { title: string; url: string; authors: string[]; publishedAt: string | null; updatedAt: string; markdown: string }[], total: number): string {
    const head = [`# ${site.title}`, '', `> ${site.description}`, '', total > posts.length ? `The ${posts.length} newest of ${total} posts. Every post is also at its own address with .md in place of the trailing slash.` : `All ${total} posts.`, ''];
    return `${[...head, ...posts.map(p => markdownCopy(p))].join('\n')}`;
}
