import type { ListItem, ListView, PageMeta, PostView, Theme, ThemeContext } from '@masthead/core';
import { css } from './style';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function date(iso: string | null, locale: string): string {
    if (!iso) return '';
    try {
        return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
    } catch {
        return iso.slice(0, 10);
    }
}

function subscribe(ctx: ThemeContext): string {
    if (!ctx.subscribeUrl) return '';
    return `<section class="subscribe" aria-label="Newsletter">
  <div>
    <h2 class="subscribe-title">Get new posts by email</h2>
    <p class="subscribe-text">${esc(ctx.site.description || `The latest from ${ctx.site.title}.`)}</p>
  </div>
  <form class="subscribe-form" method="post" action="${esc(ctx.subscribeUrl)}">
    <label class="sr-only" for="subscribe-email">Email address</label>
    <input id="subscribe-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
    <input class="hp" name="company" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button type="submit">Subscribe</button>
  </form>
</section>`;
}

/** Navigation links like "/" or "/about/" are relative to the blog, the way Ghost treats them. */
function navHref(url: string, basePath: string): string {
    if (/^[a-z]+:/i.test(url) || url.startsWith('//') || url.startsWith('#')) return url;
    return url.startsWith('/') ? `${basePath.replace(/\/$/, '')}${url}` : url;
}

function card(ctx: ThemeContext, item: ListItem): string {
    const p = item.post;
    return `<li class="card">
  <a class="card-link" href="${esc(item.url)}">
    ${p.featureImage ? `<img class="card-image" src="${esc(p.featureImage)}" alt="${esc(p.featureImageAlt ?? '')}" loading="lazy" width="1200" height="675">` : ''}
    <div class="card-body">
      ${item.primaryTag ? `<span class="eyebrow">${esc(item.primaryTag.name)}</span>` : ''}
      <h2 class="card-title">${esc(p.title)}</h2>
      <p class="card-excerpt">${esc(item.excerpt)}</p>
      <p class="meta">${esc(item.authors.map(a => a.name).join(', '))}${item.authors.length ? ' · ' : ''}<time datetime="${esc(p.publishedAt ?? '')}">${esc(date(p.publishedAt, ctx.site.locale))}</time> · ${item.readingMinutes} min read</p>
    </div>
  </a>
</li>`;
}

export const defaultTheme: Theme = {
    name: 'default',
    css,

    document(ctx: ThemeContext, meta: PageMeta, main: string): string {
        const s = ctx.site;
        const nav = (s.navigation ?? []).filter(n => n.label).map(n => `<a href="${esc(navHref(n.url, ctx.basePath))}">${esc(n.label)}</a>`).join('');
        const brand = s.logo ? `<img src="${esc(s.logo)}" alt="${esc(s.title)}" height="28">` : esc(s.title);
        return `<!doctype html>
<html lang="${esc(s.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${esc(meta.canonical)}">
${s.icon ? `<link rel="icon" href="${esc(s.icon)}">` : ''}
<link rel="stylesheet" href="${esc(ctx.cssHref)}">
${s.accentColor ? `<style>:root{--accent:${esc(s.accentColor)}}</style>` : ''}
${meta.head}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="wrap bar"><a class="brand" href="${esc(ctx.basePath)}">${brand}</a><nav class="nav">${nav}</nav></div></header>
<main id="main" class="wrap">
${main}
</main>
<footer class="site-footer"><div class="wrap bar"><span>© ${new Date().getUTCFullYear()} ${esc(s.title)}</span><a href="${esc(ctx.rssHref)}">RSS</a></div></footer>
</body>
</html>
`;
    },

    post(ctx: ThemeContext, v: PostView): string {
        const p = v.post;
        const primary = v.tags[0];
        const isPost = p.type === 'post';
        return `<article class="post">
  <header class="post-header">
    ${isPost && primary ? `<a class="eyebrow" href="${esc(primary.url)}">${esc(primary.name)}</a>` : ''}
    <h1 class="post-title">${esc(p.title)}</h1>
    ${p.customExcerpt ? `<p class="dek">${esc(p.customExcerpt)}</p>` : ''}
    ${
        isPost
            ? `<p class="meta">${v.authors.map(a => `<a href="${esc(a.url)}">${esc(a.name)}</a>`).join(', ')}${v.authors.length ? ' · ' : ''}<time datetime="${esc(p.publishedAt ?? '')}">${esc(date(p.publishedAt, ctx.site.locale))}</time> · ${v.readingMinutes} min read</p>`
            : ''
    }
  </header>
  ${
      p.featureImage
          ? `<figure class="feature"><img src="${esc(p.featureImage)}" alt="${esc(p.featureImageAlt ?? '')}" width="1200" height="675">${p.featureImageCaption ? `<figcaption>${p.featureImageCaption}</figcaption>` : ''}</figure>`
          : ''
  }
  <div class="content">
${v.html}
  </div>
  ${isPost && v.tags.length ? `<footer class="post-footer">${v.tags.map(t => `<a class="chip" href="${esc(t.url)}">${esc(t.name)}</a>`).join('')}</footer>` : ''}
</article>
${isPost ? subscribe(ctx) : ''}
${v.related.length ? `<section class="related" aria-label="More posts"><h2 class="section-title">Keep reading</h2><ul class="cards">${v.related.map(r => card(ctx, r)).join('\n')}</ul></section>` : ''}`;
    },

    list(ctx: ThemeContext, v: ListView): string {
        const head =
            v.kind === 'index'
                ? `<header class="list-header"><h1 class="list-title">${esc(v.heading)}</h1>${ctx.site.description ? `<p class="dek">${esc(ctx.site.description)}</p>` : ''}</header>`
                : `<header class="list-header">${v.author?.profileImage ? `<img class="avatar" src="${esc(v.author.profileImage)}" alt="" width="64" height="64">` : ''}<span class="eyebrow">${v.kind === 'tag' ? 'Topic' : 'Author'}</span><h1 class="list-title">${esc(v.heading)}</h1>${v.description ? `<p class="dek">${esc(v.description)}</p>` : ''}</header>`;
        const pager =
            v.pages > 1
                ? `<nav class="pager" aria-label="Pages">${v.prevUrl ? `<a href="${esc(v.prevUrl)}">Newer posts</a>` : '<span></span>'}<span>Page ${v.page} of ${v.pages}</span>${v.nextUrl ? `<a href="${esc(v.nextUrl)}">Older posts</a>` : '<span></span>'}</nav>`
                : '';
        return `${head}
<ul class="cards">
${v.items.map(i => card(ctx, i)).join('\n')}
</ul>
${pager}
${v.kind === 'index' && v.page === 1 ? subscribe(ctx) : ''}`;
    },

    notFound(ctx: ThemeContext): string {
        return `<header class="list-header"><h1 class="list-title">Page not found</h1><p class="dek">This page moved or never existed. <a href="${esc(ctx.basePath)}">Go to the latest posts</a>.</p></header>`;
    }
};

export default defaultTheme;
