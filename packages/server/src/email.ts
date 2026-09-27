import type { Post, SiteSettings } from '@masthead/core';
import { escapeHtml as esc } from './util';

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

function frame(title: string, preheader: string, inner: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">
<title>${esc(title)}</title>
<style>
  body{margin:0;padding:0;background:#f4f4f5}
  .content img{max-width:100%;height:auto;border-radius:6px}
  .content a{color:#111}
  .content h2{font-size:22px;line-height:1.3;margin:28px 0 8px}
  .content h3{font-size:18px;line-height:1.35;margin:24px 0 8px}
  .content p,.content li{font-size:16px;line-height:1.65;color:#1a1a1e}
  .content blockquote{margin:16px 0;padding-left:14px;border-left:3px solid #111;color:#55555c}
  .content pre{background:#f4f4f5;padding:12px 14px;border-radius:8px;overflow-x:auto;font-size:13px}
  .content figure{margin:20px 0}
  .content figcaption{font-size:13px;color:#77777f;text-align:center}
  .kg-btn,.kg-cta-button{display:inline-block;background:#111;color:#fff !important;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600}
</style></head>
<body style="margin:0;padding:0;background:#f4f4f5">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:${FONT}">
${inner}
</table></td></tr></table></body></html>`;
}

/** Makes a rendered post body safe and readable in mail clients. */
export function emailBody(html: string, origin: string): string {
    return html
        .replace(/<iframe[^>]*src="([^"]+)"[^>]*><\/iframe>/gi, (_m, src: string) => `<p><a href="${src}">Watch the video</a></p>`)
        .replace(/<video[^>]*src="([^"]+)"[^>]*>[\s\S]*?<\/video>/gi, (_m, src: string) => `<p><a href="${src}">Watch the video</a></p>`)
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/\s(src|href)="\/(?!\/)/g, ` $1="${origin}/`)
        .replace(/\ssrcset="[^"]*"/g, '')
        .replace(/\ssizes="[^"]*"/g, '');
}

export interface NewsletterEmail {
    subject: string;
    html: string;
    text: string;
}

export const UNSUBSCRIBE_PLACEHOLDER = '%%MASTHEAD_UNSUBSCRIBE%%';

/** The newsletter for a post. The unsubscribe placeholder is swapped per recipient. */
export function newsletterEmail(o: {
    site: SiteSettings;
    post: Post;
    body: string;
    markdown: string;
    postUrl: string;
    origin: string;
    authors: string[];
    postalAddress?: string | null;
}): NewsletterEmail {
    const date = o.post.publishedAt ? new Date(o.post.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
    const image = o.post.featureImage ? (o.post.featureImage.startsWith('/') ? `${o.origin}${o.post.featureImage}` : o.post.featureImage) : null;
    const preheader = o.post.customExcerpt ?? '';
    const inner = `
<tr><td style="padding:22px 32px 0;font-size:14px;font-weight:700;letter-spacing:-.01em"><a href="${esc(o.site.url)}" style="color:#111;text-decoration:none">${esc(o.site.title)}</a></td></tr>
<tr><td style="padding:18px 32px 0"><h1 style="margin:0;font-size:28px;line-height:1.15;letter-spacing:-.02em;color:#111"><a href="${esc(o.postUrl)}" style="color:#111;text-decoration:none">${esc(o.post.title)}</a></h1>
<p style="margin:10px 0 0;font-size:14px;color:#77777f">${esc([o.authors.join(', '), date].filter(Boolean).join(' · '))}</p></td></tr>
${image ? `<tr><td style="padding:22px 32px 0"><img src="${esc(image)}" alt="${esc(o.post.featureImageAlt ?? '')}" width="536" style="display:block;width:100%;height:auto;border-radius:8px"></td></tr>` : ''}
<tr><td class="content" style="padding:12px 32px 8px">${emailBody(o.body, o.origin)}</td></tr>
<tr><td style="padding:8px 32px 28px"><a href="${esc(o.postUrl)}" style="font-size:14px;color:#111">Read on the web</a></td></tr>
<tr><td style="padding:20px 32px 28px;border-top:1px solid #ececef;font-size:12.5px;line-height:1.6;color:#8a8a93">
You're receiving this because you subscribed to ${esc(o.site.title)}.<br>
<a href="${UNSUBSCRIBE_PLACEHOLDER}" style="color:#8a8a93">Unsubscribe</a>${o.postalAddress ? `<br>${esc(o.postalAddress)}` : ''}
</td></tr>`;
    const text = `${o.post.title}\n${[o.authors.join(', '), date].filter(Boolean).join(' · ')}\n\n${o.markdown.trim()}\n\nRead on the web: ${o.postUrl}\n\n--\nUnsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}${o.postalAddress ? `\n${o.postalAddress}` : ''}\n`;
    return { subject: o.post.title, html: frame(o.post.title, preheader, inner), text };
}

function notice(site: SiteSettings, heading: string, paragraph: string, button: { label: string; url: string }, fine: string) {
    const inner = `
<tr><td style="padding:28px 32px 0;font-size:14px;font-weight:700">${esc(site.title)}</td></tr>
<tr><td style="padding:18px 32px 0"><h1 style="margin:0;font-size:22px;line-height:1.25;color:#111">${esc(heading)}</h1>
<p style="margin:12px 0 0;font-size:15.5px;line-height:1.6;color:#44444b">${esc(paragraph)}</p></td></tr>
<tr><td style="padding:22px 32px 8px"><a href="${esc(button.url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:600;font-size:15px">${esc(button.label)}</a></td></tr>
<tr><td style="padding:14px 32px 28px;font-size:12.5px;line-height:1.6;color:#8a8a93">${esc(fine)}</td></tr>`;
    return {
        html: frame(heading, paragraph, inner),
        text: `${heading}\n\n${paragraph}\n\n${button.label}: ${button.url}\n\n${fine}\n`
    };
}

export function confirmEmail(site: SiteSettings, url: string) {
    return {
        subject: `Confirm your subscription to ${site.title}`,
        ...notice(site, 'Confirm your subscription', `Click below to start getting new posts from ${site.title} by email.`, { label: 'Confirm subscription', url }, "If you didn't ask for this, ignore this email and you won't be subscribed.")
    };
}

export function signInEmail(site: SiteSettings, url: string, invite: boolean) {
    return invite
        ? {
              subject: `You're invited to ${site.title}`,
              ...notice(site, `Join ${site.title}`, 'You have been invited to write and manage the blog. The link below signs you in.', { label: 'Accept invite', url }, 'The link works once and expires in 20 minutes.')
          }
        : {
              subject: `Sign in to ${site.title}`,
              ...notice(site, 'Sign in', 'Use the link below to sign in to the blog admin.', { label: 'Sign in', url }, "The link works once and expires in 20 minutes. If you didn't ask for it, ignore this email.")
          };
}

/** A small standalone page for signup, confirmation and unsubscribe results. */
export function page(site: SiteSettings, cssHref: string, title: string, body: string, noindex = true): string {
    return `<!doctype html><html lang="${esc(site.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - ${esc(site.title)}</title>${noindex ? '<meta name="robots" content="noindex">' : ''}<link rel="stylesheet" href="${esc(cssHref)}"></head>
<body><header class="site-header"><div class="wrap bar"><a class="brand" href="${esc(new URL(site.url).pathname)}">${esc(site.title)}</a></div></header>
<main id="main" class="wrap"><section class="list-header"><h1 class="list-title">${esc(title)}</h1>${body}</section></main></body></html>`;
}
