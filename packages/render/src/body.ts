import type { Post } from '@masthead/core';
import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: false, async: false });

/** Renders the post body from whichever field its bodyFormat names. */
export function renderBody(post: Post): string {
    const format = post.bodyFormat ?? (post.markdown ? 'markdown' : 'html');
    if (format === 'html') return post.html ?? '';
    return renderMarkdown(post.markdown ?? '');
}

export function renderMarkdown(markdown: string): string {
    return marked.parse(markdown) as string;
}
