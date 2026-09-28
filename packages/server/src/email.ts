import type { Post, SiteSettings, SocialNetwork } from '@masthead/core';
import { autoExcerpt, readingMinutes } from '@masthead/render';
import { FAINT, FONT, INK, LINE, MUTED, TEXT, button, emailBody, emailInline, type EmailAssets } from './email-body';
import { escapeHtml as esc } from './util';

/**
 * Email templates: the newsletter and the sign-in and confirmation notices.
 *
 * One 600px table layout with inline styles. The only <style> blocks hold the
 * phone layout, the dark scheme (for clients that honor prefers-color-scheme)
 * and a Gmail fix that keeps white text white on the dark masthead. Clients
 * that invert colors on their own get a light email to work from.
 */

const PAGE = '#f3f3f4';
const CARD = '#ffffff';
const CARD_LINE = '#e6e6e8';
/** The text column inside the card. */
const COLUMN = 520;

const PHONE = `@media (max-width:620px){.outer{padding:0!important}.cd{border-radius:0!important;border-left:0!important;border-right:0!important;box-shadow:none!important}.sky{border-radius:0!important}.px{padding-left:22px!important;padding-right:22px!important}.top{padding:14px 22px 12px!important}.ftr{padding-left:22px!important;padding-right:22px!important}.ttl{font-size:28px!important;line-height:1.2!important}.dek{font-size:17px!important}.bmt{width:92px!important}.bmt img{width:80px!important}}`;

const DARK = `:root{color-scheme:light dark;supported-color-schemes:light dark}@media (prefers-color-scheme:dark){.pg{background-color:#000000!important}.cd{background-color:#0a0a0b!important;border-color:#1f1f22!important;box-shadow:none!important}.ink{color:#fafafa!important}.txt{color:#d4d4d8!important}.mut{color:#a1a1a6!important}.fnt{color:#8b8b90!important}.ln{border-color:#232326!important}.ln2{border-color:#2c2c30!important}.bink{border-color:#fafafa!important}.srf{background-color:#141416!important;border-color:#232326!important}.tnt{background-color:#0d1524!important;border-color:#1e3354!important}.btn{background-color:#fafafa!important}.btt{color:#0a0a0a!important}.plr{background-color:#1a1a1d!important}.drk{border:1px solid #2c2c30!important}.mk{background-color:#5c4a0c!important}.av{background-color:#1c1c1f!important;color:#d4d4d8!important}}a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}`;

/** Gmail's apps turn white text dark in their dark mode, even over a dark image; blending turns it back. */
const GMAIL = `u+.body .gbs{background:#000;mix-blend-mode:screen}u+.body .gbd{background:#000;mix-blend-mode:difference}`;

/** Keeps the body text out of the inbox preview after the preheader. */
const PREVIEW_FILL = '&#847;&zwnj;&nbsp;'.repeat(80);

function frame(o: { title: string; preheader: string; lang: string; top?: string; card: string; footer: string }): string {
    return `<!doctype html>
<html lang="${esc(o.lang || 'en')}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(o.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>td,th,div,p,a,h1,h2,h3,h4,h5,h6,li,span,strong,em{font-family:'Segoe UI',Arial,sans-serif!important}pre,code{font-family:Consolas,'Courier New',monospace!important}</style><![endif]-->
<style>${PHONE}</style>
<style>${DARK}</style>
<style>${GMAIL}</style>
</head>
<body class="body pg" style="margin:0;padding:0;width:100%;background-color:${PAGE};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;-webkit-font-smoothing:antialiased">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${esc(o.preheader)}${PREVIEW_FILL}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="pg" bgcolor="${PAGE}" style="background-color:${PAGE}"><tr><td align="center" class="outer" style="padding:20px 12px 44px">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;font-family:${FONT}">
${o.top ?? ''}<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="cd" bgcolor="${CARD}" style="background-color:${CARD};border:1px solid ${CARD_LINE};border-radius:16px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 12px 32px rgba(0,0,0,0.06)">
${o.card}
</table></td></tr>
${o.footer}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
}

const abs = (url: string, origin: string) => (url.startsWith('//') ? `https:${url}` : url.startsWith('/') ? `${origin}${url}` : url);

interface Brand {
    logo: string | null;
    logoSize?: { width: number; height: number };
    /** The site's name, and anything after it in the masthead title, set lighter ("pre.dev" "blog"). */
    name: string;
    kind: string;
    words: boolean;
    url: string;
    /** A light logo drawn for dark backgrounds sits on the night sky. */
    dark: boolean;
    sky: string | null;
    alt: string;
}

function brand(site: SiteSettings, origin: string, assets?: Partial<EmailAssets>): Brand {
    const a = site.appearance ?? {};
    const logo = site.logo ? abs(site.logo, origin) : null;
    const dark = logo ? !!a.invertLogoInLight : !!a.backdrop?.image;
    const title = a.hero?.title?.trim() || site.title;
    const named = title.toLowerCase().startsWith(`${site.title.toLowerCase()} `);
    return {
        logo,
        logoSize: site.logo ? assets?.images?.[site.logo] : undefined,
        name: named ? title.slice(0, site.title.length) : title,
        kind: named ? title.slice(site.title.length + 1) : '',
        words: !logo || !!a.logoText,
        url: site.url,
        dark,
        sky: dark && a.backdrop?.image ? abs(a.backdrop.image, origin) : null,
        alt: site.title
    };
}

/** The masthead: logo and name, on the night sky when the logo is a light one. */
function masthead(b: Brand): string {
    const h = 34;
    const w = b.logoSize ? Math.round((h * b.logoSize.width) / b.logoSize.height) : 0;
    const color = b.dark ? '#ffffff' : INK;
    const img = b.logo
        ? `<img src="${esc(b.logo)}"${w ? ` width="${w}"` : ''} height="${h}" alt="${b.words ? '' : esc(b.alt)}" style="display:block;height:${h}px;${w ? `width:${w}px;` : ''}border:0;color:${color};font-size:18px;font-weight:600">`
        : '';
    const name = `${esc(b.name)}${b.kind ? `<span style="color:${b.dark ? '#8e8e93' : '#8a8a8f'};font-weight:400"> ${esc(b.kind)}</span>` : ''}`;
    const words = b.words ? (b.dark ? `<div class="gbs"><div class="gbd">${name}</div></div>` : name) : '';
    const cells = [
        img ? `<td valign="middle"${words ? ' style="padding-right:12px"' : ''}><a href="${esc(b.url)}" style="text-decoration:none">${img}</a></td>` : '',
        words
            ? `<td valign="middle" style="font-size:25px;line-height:32px;font-weight:600;letter-spacing:-0.02em;color:${color}"><a href="${esc(b.url)}"${b.dark ? '' : ' class="ink"'} style="color:${color};text-decoration:none">${words}</a></td>`
            : ''
    ].join('');
    const inner = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>${cells}</tr></table>`;
    if (!b.dark) return `<tr><td class="px" align="center" style="padding:36px 40px 0">${inner}</td></tr>`;
    // The sky is an image (a gradient without one), which clients that invert colors leave alone, so the light logo stays visible.
    const sky = b.sky ? `url('${esc(b.sky)}');background-position:50% 0;background-size:cover;background-repeat:no-repeat` : 'linear-gradient(#000000,#000000)';
    return `<tr><td class="sky" align="center" bgcolor="#000000"${b.sky ? ` background="${esc(b.sky)}"` : ''} style="background-color:#000000;background-image:${sky};border-radius:15px 15px 0 0;padding:40px 24px">${inner}</td></tr>`;
}

const NETWORKS: Record<SocialNetwork, string> = {
    x: 'X',
    linkedin: 'LinkedIn',
    youtube: 'YouTube',
    instagram: 'Instagram',
    discord: 'Discord',
    github: 'GitHub',
    facebook: 'Facebook',
    threads: 'Threads',
    bluesky: 'Bluesky',
    mastodon: 'Mastodon',
    tiktok: 'TikTok'
};

const dot = `<span class="fnt" style="color:#b4b4b8">&nbsp;&nbsp;·&nbsp;&nbsp;</span>`;

/** The footer under the card: who sent it, where to find them, and (for newsletters) why and how to stop. */
function footer(site: SiteSettings, origin: string, o: { unsubscribe?: string; postalAddress?: string | null } = {}): string {
    const f = site.footer ?? {};
    const tagline = f.tagline || site.description;
    const social = (f.social?.length ? f.social : site.twitter ? [{ network: 'x' as const, url: `https://x.com/${site.twitter.replace(/^@/, '')}` }] : [])
        .filter(s => /^https?:\/\//.test(s.url))
        .map(s => `<a href="${esc(s.url)}" class="mut" style="color:${MUTED};text-decoration:none;font-weight:500">${esc(NETWORKS[s.network] ?? s.network)}</a>`)
        .join(dot);
    const legal = (f.legal ?? []).map(l => `<a href="${esc(abs(l.url, origin))}" class="mut" style="color:${MUTED};text-decoration:underline">${esc(l.label)}</a>`).join(dot);
    const copyright = (f.copyright || `© {year} ${site.title}`).replace('{year}', String(new Date().getUTCFullYear()));
    const why = o.unsubscribe
        ? `You're receiving this because you subscribed to ${esc(site.title)}.<br><a href="${o.unsubscribe}" class="mut" style="color:${MUTED};text-decoration:underline">Unsubscribe</a>`
        : '';
    const lines = [why, o.postalAddress ? esc(o.postalAddress) : '', esc(copyright), legal].filter(Boolean).join('<br>');
    return `<tr><td class="ftr" align="center" style="padding:32px 32px 0;text-align:center">
<div class="ink" style="font-size:15px;line-height:22px;font-weight:600;color:${INK}"><a href="${esc(site.url)}" class="ink" style="color:${INK};text-decoration:none">${esc(site.title)}</a></div>${tagline ? `<div class="mut" style="margin-top:2px;font-size:13.5px;line-height:20px;color:${MUTED}">${esc(tagline)}</div>` : ''}${social ? `<div style="margin-top:16px;font-size:13.5px;line-height:20px">${social}</div>` : ''}
<div class="mut" style="margin-top:22px;font-size:12.5px;line-height:20px;color:${MUTED}">${lines}</div>
</td></tr>`;
}

export interface NewsletterEmail {
    subject: string;
    html: string;
    text: string;
    /** The post it was made from. */
    slug?: string;
}

export const UNSUBSCRIBE_PLACEHOLDER = '%%MASTHEAD_UNSUBSCRIBE%%';

export interface Byline {
    name: string;
    image?: string | null;
}

function byline(authors: Byline[], meta: string, origin: string): string {
    const shown = authors.slice(0, 3);
    const faces = shown
        .map((a, i) => {
            const pad = i === shown.length - 1 ? 12 : 4;
            const face = a.image
                ? `<img src="${esc(abs(a.image, origin))}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border:0;border-radius:18px">`
                : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="av" width="36" height="36" align="center" valign="middle" bgcolor="#efeff1" style="width:36px;height:36px;border-radius:18px;background-color:#efeff1;color:#3a3a3c;font-size:14px;font-weight:600;line-height:36px;text-align:center">${esc(([...a.name.trim()][0] ?? '').toUpperCase())}</td></tr></table>`;
            return `<td valign="middle" style="padding-right:${pad}px">${face}</td>`;
        })
        .join('');
    const names = shown.length ? `<div class="ink" style="font-size:14.5px;line-height:20px;font-weight:600;color:${INK}">${esc(authors.map(a => a.name).join(', '))}</div>` : '';
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:26px auto 0"><tr>${faces}<td valign="middle" style="text-align:${shown.length ? 'left' : 'center'}">${names}<div class="mut" style="font-size:13.5px;line-height:19px;color:${MUTED}">${esc(meta)}</div></td></tr></table>`;
}

/** Share links for the post's clean address, the same ones the blog offers. */
function share(url: string, title: string): string {
    const x = `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`;
    const linkedin = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
    const link = (href: string, label: string) => `<a href="${esc(href)}" class="mut" style="color:${MUTED};text-decoration:none;font-weight:500">${label}</a>`;
    return `<div class="mut" style="margin-top:18px;font-size:13.5px;line-height:20px;text-align:center;color:${MUTED}">Share on ${link(x, 'X')} or ${link(linkedin, 'LinkedIn')}</div>`;
}

/** Markdown for the text part: card markup written as plain words and links. */
function plainBody(markdown: string): string {
    return markdown
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, url: string, label: string) => {
            const words = label.replace(/<[^>]+>/g, '').trim();
            return words && words !== url ? `${words} (${url})` : url;
        })
        .replace(/<iframe\b[^>]*src="([^"]+)"[^>]*>[\s\S]*?<\/iframe>/gi, '$1')
        .replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt ? `[${alt}]` : ''))
        .replace(/<\/(p|div|figure|figcaption|h\d|li|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** The newsletter for a post. The unsubscribe placeholder is swapped per recipient. */
export function newsletterEmail(o: {
    site: SiteSettings;
    post: Post;
    body: string;
    markdown: string;
    postUrl: string;
    /** The post's address without campaign parameters, for share links. */
    shareUrl?: string;
    origin: string;
    authors: Byline[];
    /** The post's primary tag, shown above the title. */
    tag?: string | null;
    postalAddress?: string | null;
    assets?: Partial<EmailAssets>;
}): NewsletterEmail {
    const date = o.post.publishedAt ? new Date(o.post.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
    const post = o.post;
    const postUrl = esc(o.postUrl);
    const excerpt = post.customExcerpt?.trim() ?? '';
    const preheader = excerpt || autoExcerpt(o.body, 140);
    const minutes = readingMinutes(o.body);
    const b = brand(o.site, o.origin, o.assets);

    const label = o.tag ? `<div class="mut" style="margin:0 0 14px;font-size:12px;line-height:16px;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED}">${esc(o.tag)}</div>` : '';
    const heading = `<h1 class="ttl ink" style="margin:0;font-size:34px;line-height:1.15;font-weight:650;letter-spacing:-0.025em;color:${INK};text-wrap:balance"><a href="${postUrl}" class="ink" style="color:${INK};text-decoration:none">${esc(post.title)}</a></h1>`;
    const dek = excerpt ? `<p class="dek mut" style="margin:14px 0 0;font-size:18px;line-height:1.55;color:${MUTED};text-wrap:pretty">${esc(excerpt)}</p>` : '';
    const meta = [date, `${minutes} min read`].filter(Boolean).join(' · ');
    const intro = `<tr><td class="px" align="center" style="padding:${b.dark ? 40 : 28}px 40px 0;text-align:center">${label}${heading}${dek}${byline(o.authors, meta, o.origin)}</td></tr>`;

    const bodyOptions = { origin: o.origin, postUrl, width: COLUMN, assets: o.assets };
    let cover = '';
    if (post.featureImage) {
        const src = abs(post.featureImage, o.origin);
        const known = o.assets?.images?.[post.featureImage];
        const width = known ? Math.min(known.width, COLUMN) : COLUMN;
        const height = known ? Math.round((width * known.height) / known.width) : 0;
        const caption = post.featureImageCaption ? emailInline(post.featureImageCaption, bodyOptions) : '';
        cover = `<tr><td class="px" align="center" style="padding:32px 40px 0"><a href="${postUrl}" style="text-decoration:none"><img src="${esc(src)}" width="${width}"${height ? ` height="${height}"` : ''} alt="${esc(post.featureImageAlt || post.title)}" class="ln" style="display:block;width:100%;max-width:${width}px;height:auto;margin:0 auto;border:1px solid ${LINE};border-radius:12px;box-sizing:border-box"></a>${caption ? `<div class="fnt" style="padding-top:10px;font-size:13.5px;line-height:1.5;color:${FAINT};text-align:center">${caption}</div>` : ''}</td></tr>`;
    }

    const body = `<tr><td class="px txt" style="padding:36px 40px 4px;font-size:17px;line-height:1.7;color:${TEXT};text-align:left;word-wrap:break-word">${emailBody(o.body, bodyOptions)}</td></tr>`;
    const close = `<tr><td class="px" style="padding:36px 40px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="ln" style="border-top:1px solid ${LINE};font-size:0;line-height:0;height:1px">&nbsp;</td></tr></table><div style="height:32px;line-height:32px;font-size:1px">&nbsp;</div>${button(postUrl, 'Read on the web')}${share(o.shareUrl ?? o.postUrl, post.title)}</td></tr>`;

    const top = `<tr><td class="top" align="right" style="padding:0 6px 14px;font-size:12.5px;line-height:18px"><a href="${postUrl}" class="mut" style="color:${MUTED};text-decoration:underline">Read on the web</a></td></tr>`;
    const html = frame({
        title: post.title,
        preheader,
        lang: o.site.locale,
        top,
        card: `${masthead(b)}${intro}${cover}${body}${close}`,
        footer: footer(o.site, o.origin, { unsubscribe: UNSUBSCRIBE_PLACEHOLDER, postalAddress: o.postalAddress })
    });

    const byNames = o.authors.map(a => a.name).join(', ');
    const text = `${post.title}\n${[byNames, date].filter(Boolean).join(' · ')}\n\n${plainBody(o.markdown)}\n\nRead on the web: ${o.postUrl}\n\n--\n${o.site.title}\nUnsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}${o.postalAddress ? `\n${o.postalAddress}` : ''}\n`;
    return { subject: post.title, html, text };
}

function notice(site: SiteSettings, heading: string, paragraph: string, action: { label: string; url: string }, fine: string) {
    const origin = new URL(site.url).origin;
    const b = brand(site, origin);
    const url = esc(action.url);
    const card = `${masthead(b)}<tr><td class="px" style="padding:${b.dark ? 40 : 30}px 40px 40px;text-align:left">
<h1 class="ink" style="margin:0;font-size:26px;line-height:1.25;font-weight:650;letter-spacing:-0.02em;color:${INK}">${esc(heading)}</h1>
<p class="txt" style="margin:12px 0 28px;font-size:16.5px;line-height:1.6;color:${TEXT}">${esc(paragraph)}</p>
${button(url, esc(action.label), { align: 'left' })}
<p class="fnt" style="margin:28px 0 0;font-size:13px;line-height:1.6;color:${FAINT}">${esc(fine)}</p>
<p class="fnt" style="margin:14px 0 0;font-size:12.5px;line-height:1.6;color:${FAINT};word-break:break-all">Button not working? Paste this link into your browser:<br><a href="${url}" class="fnt" style="color:${FAINT};text-decoration:underline">${url}</a></p>
</td></tr>`;
    return {
        html: frame({ title: heading, preheader: paragraph, lang: site.locale, card, footer: footer(site, origin) }),
        text: `${heading}\n\n${paragraph}\n\n${action.label}: ${action.url}\n\n${fine}\n`
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
