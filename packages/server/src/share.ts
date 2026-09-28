/**
 * The share kit: an X post, an X thread, a LinkedIn post and newsletter subject
 * lines for one post, written in the house style. It only writes text for people
 * to copy; nothing is ever posted anywhere.
 *
 * The model writes {link} where the post's address goes. Each channel's address
 * carries its own campaign tags (utm_source=x or linkedin, utm_medium=social,
 * utm_campaign=<slug>), filled in afterwards, so the model can't mangle a URL.
 */
import type { Post } from '@masthead/core';
import { answeredBy, chooseModel, compose, provider, settled, type WritingJob } from './ai';
import { siteSettings } from './content';
import type { Ctx } from './env';
import { blockText } from './knowledge';
import { eventStream } from './sse';
import { HttpError } from './util';

export interface ShareInput {
    /** What to lead with, in the writer's words, e.g. "the benchmark numbers". */
    angle?: string;
    /** A text model from the catalog; the site default when absent or not listed. */
    model?: string;
}

export interface ShareKit {
    x: string;
    thread: string[];
    linkedin: string;
    subjects: { subject: string; preheader: string }[];
}

export const LINK = '{link}';

/** The post's address for one channel, with its campaign tags. */
export function shareUrl(siteUrl: string, slug: string, source: 'x' | 'linkedin'): string {
    const url = new URL(`${siteUrl}${slug}/`);
    url.searchParams.set('utm_source', source);
    url.searchParams.set('utm_medium', 'social');
    url.searchParams.set('utm_campaign', slug);
    return url.toString();
}

const TASK = `Write posts that bring readers to the blog post below, and subject lines for emailing it. Use only what the post says: never invent numbers, features, customers or quotes. Write ${LINK} exactly where the post's address goes; it is replaced with the real address.

Reply in exactly this shape: these four headings in this order, each followed by its content, and nothing else.

## X post
One post of at most 240 characters before the link. Lead with the most specific, surprising point in the post. No hashtags, no emoji. End with ${LINK}.

## X thread
Four to six posts of at most 260 characters each, separated by a line that holds only ---. The first states the core claim so people want the rest; each middle post carries one concrete point from the post; the last ends with ${LINK}. No numbering, no hashtags, no emoji.

## LinkedIn post
120 to 200 words in short paragraphs. The first line earns the click. Concrete points from the post, no hashtags, no emoji. End with ${LINK} on its own line.

## Newsletter subject lines
Five options, each two lines: "Subject: " with at most 60 characters, then "Preheader: " with at most 100 characters that adds what the subject leaves out.`;

function shareJob(post: Post, input: ShareInput): Omit<WritingJob, 'model' | 'requested'> {
    const body = (post.markdown?.trim() ? post.markdown : blockText(post.html ?? '')).trim();
    if (!body) throw new HttpError(400, 'Write the post first: the share kit is made from its text.');
    const angle = input.angle?.trim().slice(0, 300);
    return {
        task: TASK,
        messages: [
            {
                role: 'user',
                content: [`Title: ${post.title || 'Untitled'}`, post.customExcerpt ? `Excerpt: ${post.customExcerpt}` : '', angle ? `Lead with this angle: ${angle}` : '', `The post (Markdown):\n${body.slice(0, 14000)}`]
                    .filter(Boolean)
                    .join('\n\n')
            }
        ],
        maxTokens: 2500,
        temperature: 0.7
    };
}

const SECTIONS: [keyof ShareKit, RegExp][] = [
    ['x', /^x post$/i],
    ['thread', /^x thread$/i],
    ['linkedin', /^linkedin(?: post)?$/i],
    ['subjects', /^(?:newsletter )?subject lines$/i]
];

/** Reads the four sections, forgiving bold headings, numbering and quotes. */
export function parseShare(text: string): ShareKit {
    const raw: Record<keyof ShareKit, string> = { x: '', thread: '', linkedin: '', subjects: '' };
    let at: keyof ShareKit | null = null;
    for (const line of text.replace(/\r/g, '').split('\n')) {
        const heading = line.match(/^\s*(?:#{1,4}\s*(.+?)\s*#*|\*\*(.+?)\*\*:?)\s*$/);
        const name = heading ? (heading[1] ?? heading[2]).replace(/[*:]/g, '').trim() : '';
        const found = name ? SECTIONS.find(([, re]) => re.test(name)) : undefined;
        if (found) at = found[0];
        else if (at) raw[at] += `${line}\n`;
    }
    const subjects: ShareKit['subjects'] = [];
    for (const line of raw.subjects.split('\n')) {
        const m = line.replace(/^[\s>*_\-\d.)]+/, '').match(/^(subject|preheader)(?:\s+line)?\**\s*:\s*\**\s*(.*)$/i);
        const value = m?.[2].replace(/\**\s*$/, '').trim().replace(/^["“](.*)["”]$/, '$1').trim();
        if (!m || !value) continue;
        if (m[1].toLowerCase() === 'subject') subjects.push({ subject: value, preheader: '' });
        else if (subjects.length && !subjects[subjects.length - 1].preheader) subjects[subjects.length - 1].preheader = value;
    }
    return { x: raw.x.trim(), thread: threadPosts(raw.thread), linkedin: raw.linkedin.trim(), subjects: subjects.slice(0, 5) };
}

/** Thread posts come between lines of ---; a model that numbered them ("2/") or only left blank lines is read too. */
function threadPosts(text: string): string[] {
    const split = (re: RegExp) =>
        text
            .split(re)
            .map(t => t.trim())
            .filter(Boolean);
    const dashed = split(/^\s*-{3,}\s*$/m);
    if (dashed.length > 1) return dashed;
    const numbered = split(/^(?=\s*\d{1,2}\/\d{0,2}\s)/m);
    if (numbered.length > 1) return numbered;
    const paragraphs = split(/\n\s*\n/);
    return paragraphs.length >= 3 && paragraphs.length <= 8 ? paragraphs : dashed;
}

/** The kit with each channel's address in place of {link}; a post the model left without one gets it at the end. */
export function withLinks(kit: ShareKit, links: { x: string; linkedin: string }): ShareKit {
    const put = (text: string, url: string) => (!text ? text : text.includes(LINK) ? text.replaceAll(LINK, url) : `${text}\n\n${url}`);
    const thread = kit.thread.map(t => t.replaceAll(LINK, links.x));
    if (thread.length && !kit.thread.some(t => t.includes(LINK))) thread[thread.length - 1] = `${thread[thread.length - 1]}\n\n${links.x}`;
    return { x: put(kit.x, links.x), thread, linkedin: put(kit.linkedin, links.linkedin), subjects: kit.subjects };
}

async function linksFor(ctx: Ctx, post: Post) {
    const site = await siteSettings(ctx.env, ctx.db);
    return { x: shareUrl(site.url, post.slug, 'x'), linkedin: shareUrl(site.url, post.slug, 'linkedin') };
}

export async function share(ctx: Ctx, post: Post, input: ShareInput) {
    const job = shareJob(post, input);
    const ai = provider(ctx);
    const chosen = await chooseModel(ctx, 'text', input.model);
    const links = await linksFor(ctx, post);
    // The same writing as the stream, read to the end.
    const events = compose(ctx, ai, { ...job, ...chosen }, new AbortController().signal);
    let step = await events.next();
    while (!step.done) step = await events.next();
    const { text, end } = step.value;
    return { ...withLinks(parseShare(text), links), links, ...answeredBy(end.model, chosen), usage: end.usage };
}

export async function shareStream(ctx: Ctx, post: Post, input: ShareInput, client?: AbortSignal): Promise<Response> {
    const job = shareJob(post, input);
    const ai = provider(ctx);
    const chosen = await chooseModel(ctx, 'text', input.model);
    const links = await linksFor(ctx, post);
    return eventStream(async function* (signal) {
        const { text, end } = yield* compose(ctx, ai, { ...job, ...chosen }, signal);
        yield { event: 'done', data: { ...withLinks(parseShare(text), links), links, ...answeredBy(end.model, chosen), usage: end.usage, finishReason: end.finishReason } };
        yield* settled(ai, end.usage, signal);
    }, client);
}
