import type { Author, ListItem, ListView, NavigationItem, PageMeta, PostView, SearchEntry, Theme, ThemeContext } from '@masthead/core';
import { icons, navIcons, socialIcons } from './icons';
import { script } from './script';
import { css } from './style';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JSON that is safe inside a <script> element. */
const jsonScript = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

function date(iso: string | null | undefined, locale: string): string {
    if (!iso) return '';
    try {
        return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
    } catch {
        return iso.slice(0, 10);
    }
}

/** Navigation links like "/" or "/about/" are relative to the blog, the way Ghost treats them. */
function href(url: string, basePath: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#')) return url;
    return url.startsWith('/') ? `${basePath.replace(/\/$/, '')}${url}` : url;
}

const isExternal = (url: string, ctx: ThemeContext) => /^https?:\/\//i.test(url) && new URL(url).host !== new URL(ctx.site.url).host;

/**
 * Responsive sources for images stored with the blog. Variants live under
 * content/images/size/wN/, the way Ghost keeps them; the server answers a
 * missing variant with the original, so a srcset never breaks an image.
 */
function srcset(url: string | null | undefined, ctx: ThemeContext): string {
    if (!url) return '';
    const base = `${ctx.basePath}content/images/`;
    const path = url.startsWith(ctx.site.url) ? url.slice(new URL(ctx.site.url).origin.length) : url;
    if (!path.startsWith(base) || path.startsWith(`${base}size/`) || /\.(gif|svg)(\?|$)/i.test(path)) return '';
    const rest = path.slice(base.length);
    return ` srcset="${[600, 1000, 2000].map(w => `${esc(`${base}size/w${w}/${rest}`)} ${w}w`).join(', ')}"`;
}

/** width and height attributes for the logo drawn `height` pixels tall, so the page reserves its space. */
function logoDims(ctx: ThemeContext, height: number): string {
    const s = ctx.site.logoSize;
    return s && s.height > 0 ? ` width="${Math.round((height * s.width) / s.height)}" height="${height}"` : ` height="${height}"`;
}

function brand(ctx: ThemeContext, cls = 'brand'): string {
    const s = ctx.site;
    const a = s.appearance ?? {};
    const to = esc(href(a.brandUrl || ctx.basePath, ctx.basePath));
    if (!s.logo) return `<a class="${cls}" href="${to}">${esc(s.title)}</a>`;
    const img = `<img class="${a.invertLogoInLight ? 'brand-mark' : ''}" src="${esc(s.logo)}" alt="${a.logoText ? '' : esc(s.title)}"${logoDims(ctx, 24)}>`;
    return `<a class="${cls}" href="${to}"${a.logoText ? '' : ` aria-label="${esc(s.title)}"`}>${img}${a.logoText ? `<span>${esc(s.title)}</span>` : ''}</a>`;
}

function navLink(ctx: ThemeContext, n: NavigationItem): string {
    const url = href(n.url, ctx.basePath);
    const ext = isExternal(url, ctx);
    return `<a class="nav-link" href="${esc(url)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${esc(n.label)}</a>`;
}

function dropdown(ctx: ThemeContext, n: NavigationItem): string {
    const groups = new Map<string, NavigationItem[]>();
    for (const item of n.items ?? []) groups.set(item.group ?? '', [...(groups.get(item.group ?? '') ?? []), item]);
    const panel = [...groups]
        .map(
            ([group, items]) => `<div class="dd-group">${group ? `<p class="dd-heading">${esc(group)}</p>` : ''}${items
                .map(i => {
                    const url = href(i.url, ctx.basePath);
                    const ext = isExternal(url, ctx);
                    const icon = i.icon && navIcons[i.icon] ? `<span class="dd-icon">${navIcons[i.icon]}</span>` : '';
                    return `<a class="dd-item" href="${esc(url)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${icon}<span class="dd-text"><span class="dd-label">${esc(i.label)}${i.badge ? ` <span class="badge">${esc(i.badge)}</span>` : ''}${ext ? icons.external() : ''}</span>${i.description ? `<span class="dd-desc">${esc(i.description)}</span>` : ''}</span></a>`;
                })
                .join('')}</div>`
        )
        .join('');
    return `<div class="dd"><button class="dd-trigger" type="button" aria-haspopup="true">${esc(n.label)}${icons.chevron()}</button><div class="dd-panel">${panel}</div></div>`;
}

function cta(ctx: ThemeContext, cls: string): string {
    const c = ctx.site.appearance?.headerCta;
    if (!c?.label || !c.url) return '';
    const signed = c.signedIn?.cookie
        ? ` data-signed-in-cookie="${esc(c.signedIn.cookie)}" data-signed-in-label="${esc(c.signedIn.label)}" data-signed-in-url="${esc(href(c.signedIn.url, ctx.basePath))}"`
        : '';
    return `<a class="btn ${cls}" href="${esc(href(c.url, ctx.basePath))}"${signed}>${esc(c.label)}</a>`;
}

function header(ctx: ThemeContext): string {
    const nav = (ctx.site.navigation ?? []).filter(n => n.label);
    const subscribe = ctx.subscribeUrl ? '<a class="btn btn-primary" href="#subscribe">Subscribe</a>' : '';
    const mobile = nav
        .map(n =>
            n.items?.length
                ? `<p class="menu-heading">${esc(n.label)}</p>${n.items.map(i => `<a href="${esc(href(i.url, ctx.basePath))}">${esc(i.label)}${isExternal(href(i.url, ctx.basePath), ctx) ? icons.external() : ''}</a>`).join('')}`
                : `<a href="${esc(href(n.url, ctx.basePath))}">${esc(n.label)}</a>`
        )
        .join('');
    return `<header class="site-header">
  <div class="wrap bar">
    ${brand(ctx)}
    <nav class="nav" aria-label="Main">${nav.map(n => (n.items?.length ? dropdown(ctx, n) : navLink(ctx, n))).join('')}</nav>
    <div class="actions">
      <a class="icon-btn search-trigger" href="${esc(ctx.searchHref)}" data-search aria-label="Search">${icons.search()}<span class="kbd-hint">Search <kbd>/</kbd></span></a>
      <button class="icon-btn theme-toggle" type="button" data-theme-toggle aria-label="Switch between light and dark"><span class="sun">${icons.sun()}</span><span class="moon">${icons.moon()}</span></button>
      ${cta(ctx, 'btn-pill')}
      ${subscribe}
      <details class="menu">
        <summary class="icon-btn" aria-label="Menu"><span class="menu-open">${icons.menu(20)}</span><span class="menu-close">${icons.close(20)}</span></summary>
        <div class="menu-panel">${mobile}<div class="menu-actions">${cta(ctx, 'btn-pill')}${subscribe}</div></div>
      </details>
    </div>
  </div>
</header>`;
}

/** The night sky is the first thing painted: fetch its image early (the phone one on narrow screens). */
function backdropPreload(ctx: ThemeContext): string {
    const b = ctx.site.appearance?.backdrop;
    if (!b?.image) return '';
    if (!b.mobileImage) return `<link rel="preload" as="image" href="${esc(b.image)}" fetchpriority="high">`;
    return `<link rel="preload" as="image" href="${esc(b.image)}" media="(min-width: 768px)" fetchpriority="high">\n<link rel="preload" as="image" href="${esc(b.mobileImage)}" media="(max-width: 767px)" fetchpriority="high">`;
}

/** The night-sky layer at the top of every page: an image and a canvas of sparkles (drawn by masthead.js). */
function backdrop(ctx: ThemeContext): string {
    const b = ctx.site.appearance?.backdrop;
    if (!b || (!b.image && !b.sparkles)) return '';
    const vars = [b.image ? `--backdrop:url('${esc(b.image)}')` : '', b.mobileImage ? `--backdrop-m:url('${esc(b.mobileImage)}')` : ''].filter(Boolean).join(';');
    return `<div class="backdrop${b.image ? ' has-image' : ''}" aria-hidden="true"${vars ? ` style="${vars}"` : ''}>${b.sparkles ? '<canvas class="sparkles" data-sparkles></canvas>' : ''}</div>`;
}

function footer(ctx: ThemeContext): string {
    const f = ctx.site.footer ?? {};
    const cols = (f.columns ?? []).filter(c => c.title && c.links?.length);
    const link = (n: NavigationItem) => {
        const url = href(n.url, ctx.basePath);
        return `<a href="${esc(url)}"${isExternal(url, ctx) ? ' target="_blank" rel="noopener"' : ''}>${esc(n.label)}</a>`;
    };
    const social = [...(f.social ?? []), { network: 'rss', url: ctx.rssHref }]
        .map(s => `<a href="${esc(s.url)}" aria-label="${esc(s.network === 'x' ? 'X' : s.network === 'rss' ? 'RSS feed' : s.network)}"${s.network === 'rss' ? '' : ' target="_blank" rel="noopener"'}>${socialIcons[s.network] ?? icons.link()}</a>`)
        .join('');
    return `<footer class="site-footer">
  <div class="wrap">
    <div class="foot-top">
      <div class="foot-brand">${brand(ctx)}${f.tagline ? `<p class="foot-tagline">${esc(f.tagline)}</p>` : ctx.site.description ? `<p class="foot-tagline">${esc(ctx.site.description)}</p>` : ''}</div>
      ${cols.length ? `<div class="foot-cols">${cols.map(c => `<div class="foot-col"><h2>${esc(c.title)}</h2><ul>${c.links.map(l => `<li>${link(l)}</li>`).join('')}</ul></div>`).join('')}</div>` : ''}
    </div>
    <div class="foot-bottom">
      <div class="foot-legal"><span>${esc((f.copyright || `© {year} ${ctx.site.title}`).replace('{year}', String(new Date().getUTCFullYear())))}</span>${(f.legal ?? []).map(link).join('')}</div>
      <div class="social">${social}</div>
    </div>
  </div>
</footer>`;
}

function signup(ctx: ThemeContext): string {
    if (!ctx.subscribeUrl) return '';
    const s = ctx.site.appearance?.subscribe ?? {};
    return `<section class="signup" id="subscribe" aria-labelledby="signup-title">
  <span class="signup-icon">${icons.mail(20)}</span>
  <h2 class="signup-title" id="signup-title">${esc(s.title || `Get ${ctx.site.title} in your inbox`)}</h2>
  <p class="signup-text">${esc(s.text || ctx.site.description || 'New posts by email.')}</p>
  <form class="signup-form" method="post" action="${esc(ctx.subscribeUrl)}" data-subscribe>
    <label class="sr-only" for="signup-email">Email address</label>
    <input id="signup-email" name="email" type="email" required autocomplete="email" placeholder="you@company.com">
    <input class="hp" name="company" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button class="btn btn-primary" type="submit">Subscribe</button>
  </form>
  <p class="signup-note" data-subscribe-note role="status" hidden></p>
  <p class="signup-fine">No spam. Unsubscribe with one click.</p>
</section>`;
}

function meta(ctx: ThemeContext, item: { authors: Author[]; publishedAt: string | null; readingMinutes: number }): string {
    const parts = [item.authors.map(a => esc(a.name)).join(', '), `<time datetime="${esc(item.publishedAt ?? '')}">${esc(date(item.publishedAt, ctx.site.locale))}</time>`, `${item.readingMinutes} min read`].filter(Boolean);
    return `<p class="meta">${parts.join('<span class="dot"></span>')}</p>`;
}

function card(ctx: ThemeContext, item: ListItem): string {
    const p = item.post;
    const topics = (item.tags ?? (item.primaryTag ? [item.primaryTag] : [])).map(t => t.slug).join(' ');
    return `<li data-topics="${esc(topics)}"><a class="card-link" href="${esc(item.url)}">
  ${p.featureImage ? `<div class="card-image"><img src="${esc(p.featureImage)}"${srcset(p.featureImage, ctx)} sizes="(max-width: 640px) 100vw, (max-width: 960px) 50vw, 400px" alt="${esc(p.featureImageAlt ?? '')}" loading="lazy" decoding="async" width="1200" height="675"></div>` : ''}
  <div class="card-body">
    ${item.primaryTag ? `<span class="eyebrow">${esc(item.primaryTag.name)}</span>` : ''}
    <h3 class="card-title">${esc(p.title)}</h3>
    <p class="card-excerpt">${esc(item.excerpt)}</p>
    ${meta(ctx, { authors: item.authors, publishedAt: p.publishedAt, readingMinutes: item.readingMinutes })}
  </div>
</a></li>`;
}

/**
 * The front page's masthead: the configured title, big, after the logo, and a tagline if one is set.
 * A title that starts with the site's name ("pre.dev blog") sets the name at full strength
 * and the rest lighter. Without a title, the heading is for screen readers only.
 */
function masthead(ctx: ThemeContext): string {
    const s = ctx.site;
    const h = s.appearance?.hero;
    if (!h?.title) return `<h1 class="sr-only">${esc(s.title)}</h1>`;
    const mark = s.logo ? `<img class="masthead-mark${s.appearance?.invertLogoInLight ? ' brand-mark' : ''}" src="${esc(s.logo)}" alt=""${logoDims(ctx, 96)}>` : '';
    const named = !!s.title && h.title.toLowerCase().startsWith(`${s.title.toLowerCase()} `);
    const title = named
        ? `<span class="masthead-name">${esc(h.title.slice(0, s.title.length))}</span> <span class="masthead-kind">${esc(h.title.slice(s.title.length + 1))}</span>`
        : `<span class="masthead-name">${esc(h.title)}</span>`;
    return `<header class="masthead">
  <h1 class="masthead-title">${mark} ${title}</h1>
  ${h.text ? `<p class="masthead-tagline">${esc(h.text)}</p>` : ''}
</header>`;
}

/** The newest post as the front page's hero: headline, summary, and its cover in a glowing frame. */
function featured(ctx: ThemeContext, item: ListItem): string {
    const p = item.post;
    const kicker = [item.primaryTag?.name, date(p.publishedAt, ctx.site.locale)].filter(Boolean).map(x => esc(x!)).join('<span class="dot"></span>');
    const avatars = item.authors
        .map(a => (a.profileImage ? `<img src="${esc(a.profileImage)}" alt="" width="28" height="28">` : `<span aria-hidden="true">${esc(initials(a.name))}</span>`))
        .join('');
    return `<section class="feature-hero">
  <p class="feature-kicker"><span class="spark" aria-hidden="true"></span>${kicker}</p>
  <h2 class="hero-title feature-title"><a href="${esc(item.url)}">${esc(p.title)}</a></h2>
  <p class="hero-text">${esc(item.excerpt)}</p>
  <div class="feature-meta">
    <span class="feature-by">${avatars ? `<span class="avatars small">${avatars}</span>` : ''}<span>${esc(item.authors.map(a => a.name).join(', '))}${item.authors.length ? ' · ' : ''}${item.readingMinutes} min read</span></span>
    <a class="btn btn-primary" href="${esc(item.url)}">Read the post ${icons.arrowRight(15)}</a>
  </div>
  ${p.featureImage ? `<a class="feature-frame" href="${esc(item.url)}" tabindex="-1" aria-hidden="true"><img src="${esc(p.featureImage)}"${srcset(p.featureImage, ctx)} sizes="(max-width: 1100px) 100vw, 1040px" alt="" fetchpriority="high" decoding="async" width="1200" height="675"></a>` : ''}
</section>`;
}

function topics(ctx: ThemeContext, current?: string, filter = false): string {
    const list = (ctx.topics ?? []).slice(0, 12);
    if (list.length < 2) return '';
    const chip = (label: string, href: string, slug: string, count: number | null, on: boolean) =>
        `<a class="topic" href="${esc(href)}"${filter ? ` data-topic="${esc(slug)}" data-count="${count ?? ''}"` : ''}${on ? ' aria-current="page"' : ''}>${esc(label)}${count ? `<span class="topic-count">${count}</span>` : ''}</a>`;
    return `<nav class="topics"${filter ? ' data-filter' : ''} aria-label="Topics">${chip('All', ctx.basePath, '', null, !current)}${list.map(t => chip(t.name, t.url, t.slug, t.count, t.slug === current)).join('')}</nav>`;
}

/** The three most-read posts, as a ranked row. */
function mostRead(ctx: ThemeContext, items: ListItem[] | undefined): string {
    if (!items?.length) return '';
    return `<section class="most-read" aria-labelledby="most-read-title">
  <h2 class="section-title" id="most-read-title">Most read</h2>
  <ol class="ranked">${items
      .map(
          (i, n) => `<li><a class="ranked-link" href="${esc(i.url)}">
    <span class="rank" aria-hidden="true">${String(n + 1).padStart(2, '0')}</span>
    <span class="ranked-body">${i.primaryTag ? `<span class="eyebrow">${esc(i.primaryTag.name)}</span>` : ''}<span class="ranked-title">${esc(i.post.title)}</span><span class="meta">${esc(date(i.post.publishedAt, ctx.site.locale))} · ${i.readingMinutes} min read</span></span>
    ${i.post.featureImage ? `<span class="ranked-image"><img src="${esc(i.post.featureImage)}"${srcset(i.post.featureImage, ctx)} sizes="160px" alt="" loading="lazy" decoding="async" width="160" height="90"></span>` : ''}
  </a></li>`
      )
      .join('')}</ol>
</section>`;
}

function initials(name: string): string {
    return name
        .split(/\s+/)
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
}

/** Ghost's video card needs Ghost's script for its custom player; use the browser's own controls instead. */
function ghostCompat(html: string): string {
    return html.includes('kg-video-card') ? html.replace(/<video(?![^>]*\scontrols)/g, '<video controls') : html;
}

export const defaultTheme: Theme = {
    name: 'default',
    css,
    assets: [{ path: 'masthead.js', contents: script, contentType: 'text/javascript; charset=utf-8' }],

    document(ctx: ThemeContext, meta: PageMeta, main: string): string {
        const s = ctx.site;
        const scheme = s.appearance?.colorScheme ?? 'system';
        return `<!doctype html>
<html lang="${esc(s.locale)}" data-default-theme="${esc(scheme)}" data-base="${esc(ctx.basePath)}" data-search-index="${esc(ctx.searchIndexHref)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${esc(meta.canonical)}">
<meta name="color-scheme" content="light dark">
<script>(function(d){var t;try{t=localStorage.getItem('mh-theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=d.getAttribute('data-default-theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}d.setAttribute('data-theme',t);d.classList.add('js')})(document.documentElement)</script>
${s.icon ? `<link rel="icon" href="${esc(s.icon)}">` : ''}
<link rel="stylesheet" href="${esc(ctx.cssHref)}">
${backdropPreload(ctx)}
<script src="${esc(ctx.assetsHref)}masthead.js?v=${esc(ctx.assetsVersion)}" defer></script>
${ctx.analytics?.posthog ? `<script type="application/json" id="mh-analytics">${jsonScript(ctx.analytics)}</script>` : ''}
${meta.head}
</head>
<body>
${backdrop(ctx)}
<a class="skip" href="#main">Skip to content</a>
${header(ctx)}
<div class="page">
<main id="main" class="wrap">
${main}
</main>
${footer(ctx)}
</div>
</body>
</html>
`;
    },

    post(ctx: ThemeContext, v: PostView): string {
        const p = v.post;
        const primary = v.tags[0];
        const isPost = p.type === 'post';
        const url = new URL(v.url, ctx.site.url).toString();
        const avatars = v.authors
            .map(a => (a.profileImage ? `<img src="${esc(a.profileImage)}" alt="" width="36" height="36" loading="lazy">` : `<span aria-hidden="true">${esc(initials(a.name))}</span>`))
            .join('');
        const share = `<div class="share"><span class="share-label">Share</span>
      <a class="icon-btn" data-share="x" href="https://x.com/intent/post?url=${encodeURIComponent(url)}&amp;text=${encodeURIComponent(p.title)}" target="_blank" rel="noopener" aria-label="Share on X">${socialIcons.x}</a>
      <a class="icon-btn" data-share="linkedin" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}" target="_blank" rel="noopener" aria-label="Share on LinkedIn">${socialIcons.linkedin}</a>
      <a class="icon-btn" data-share="copy" href="${esc(url)}" data-copy-link aria-label="Copy link">${icons.link()}</a></div>`;
        return `<article class="post" data-post-slug="${esc(p.slug)}" data-post-type="${esc(p.type)}" data-post-tags="${esc(v.tags.map(t => t.slug).join(','))}" data-post-authors="${esc(v.authors.map(a => a.slug).join(','))}" data-post-published="${esc(p.publishedAt ?? '')}">
  <header class="post-header">
    ${isPost && primary ? `<a class="eyebrow" href="${esc(primary.url)}">${esc(primary.name)}</a>` : ''}
    <h1 class="post-title">${esc(p.title)}</h1>
    ${p.customExcerpt ? `<p class="dek">${esc(p.customExcerpt)}</p>` : ''}
    ${
        isPost
            ? `<div class="byline">${avatars ? `<span class="avatars">${avatars}</span>` : ''}<span class="byline-text"><span class="byline-names">${v.authors.map(a => `<a href="${esc(a.url)}">${esc(a.name)}</a>`).join(', ')}</span><span><time datetime="${esc(p.publishedAt ?? '')}">${esc(date(p.publishedAt, ctx.site.locale))}</time> · ${v.readingMinutes} min read</span></span></div>`
            : ''
    }
  </header>
  ${
      p.featureImage
          ? `<figure class="feature"><img src="${esc(p.featureImage)}"${srcset(p.featureImage, ctx)} sizes="(max-width: 1100px) 100vw, 1024px" alt="${esc(p.featureImageAlt ?? '')}" fetchpriority="high" decoding="async" width="${v.featureImageSize?.width || 1200}" height="${v.featureImageSize?.height || 675}">${p.featureImageCaption ? `<figcaption>${p.featureImageCaption}</figcaption>` : ''}</figure>`
          : ''
  }
  <div class="content">
${ghostCompat(v.html)}
  </div>
  ${isPost ? `<footer class="post-foot"><div class="chips">${v.tags.map(t => `<a class="chip" href="${esc(t.url)}">${esc(t.name)}</a>`).join('')}</div>${share}</footer>` : ''}
</article>
${isPost ? signup(ctx) : ''}
${v.related.length ? `<section class="related" aria-labelledby="related-title"><h2 class="section-title" id="related-title">Keep reading</h2><ul class="cards">${v.related.map(r => card(ctx, r)).join('\n')}</ul></section>` : ''}`;
    },

    list(ctx: ThemeContext, v: ListView): string {
        const pager =
            v.pages > 1
                ? `<nav class="pager" aria-label="Pages">${v.prevUrl ? `<a href="${esc(v.prevUrl)}">← Newer posts</a>` : '<span></span>'}<span>Page ${v.page} of ${v.pages}</span>${v.nextUrl ? `<a href="${esc(v.nextUrl)}">Older posts →</a>` : '<span></span>'}</nav>`
                : '';
        if (v.kind === 'index' && v.page === 1) {
            const [first, ...rest] = v.items;
            return `${masthead(ctx)}
${first ? featured(ctx, first) : ''}
${mostRead(ctx, v.highlights)}
<section class="latest" aria-labelledby="latest-title">
  <div class="latest-head"><h2 class="section-title" id="latest-title">Latest</h2>${topics(ctx, undefined, true)}</div>
  <ul class="cards" data-filterable>
${rest.map(i => card(ctx, i)).join('\n')}
  </ul>
  <p class="filter-more" data-filter-more hidden><a class="btn btn-pill" href="#"></a></p>
</section>
${pager}
${signup(ctx)}`;
        }
        const kind = v.kind === 'tag' ? 'Topic' : v.kind === 'author' ? 'Author' : '';
        const count = v.kind === 'index' ? '' : `<p class="list-count">${(ctx.topics ?? []).find(t => t.slug === v.tag?.slug)?.count ?? v.items.length} posts</p>`;
        return `<header class="list-header">
  ${v.author?.profileImage ? `<img class="avatar" src="${esc(v.author.profileImage)}" alt="" width="72" height="72">` : ''}
  ${kind ? `<span class="list-kind">${kind}</span>` : ''}
  <h1 class="list-title">${esc(v.heading)}</h1>
  ${v.description ? `<p class="list-text">${esc(v.description)}</p>` : ''}
  ${v.kind === 'tag' ? count : ''}
  ${v.kind === 'tag' ? topics(ctx, v.tag?.slug) : ''}
</header>
<ul class="cards">
${v.items.map(i => card(ctx, i)).join('\n')}
</ul>
${pager}
${signup(ctx)}`;
    },

    notFound(ctx: ThemeContext): string {
        return `<section class="message">
  <p class="not-found-code">404</p>
  <h1>This page doesn't exist</h1>
  <p class="dek">It may have moved, or the link may be wrong. Search the blog, or start from the latest posts.</p>
  <p><a class="btn btn-primary" href="${esc(ctx.basePath)}">Latest posts</a> <a class="btn btn-pill" href="${esc(ctx.searchHref)}" data-search>Search</a></p>
</section>`;
    },

    message(ctx: ThemeContext, view: { title: string; html: string }): string {
        return `<section class="message"><h1>${esc(view.title)}</h1>${view.html}<a class="btn btn-pill" href="${esc(ctx.basePath)}">Back to the blog</a></section>`;
    },

    search(ctx: ThemeContext, view: { query: string; results: SearchEntry[] }): string {
        const q = view.query.trim();
        return `<section class="search-page">
  <h1 class="list-title">Search</h1>
  <form method="get" action="${esc(ctx.searchHref)}" role="search">
    <label class="sr-only" for="q">Search posts</label>
    <input id="q" name="q" type="search" value="${esc(q)}" placeholder="Search posts" autofocus>
    <button class="btn btn-primary" type="submit">Search</button>
  </form>
  ${
      q
          ? view.results.length
              ? `<ul class="results">${view.results.map(r => `<li><a class="search-hit" href="${esc(r.url)}"><span class="search-hit-title">${esc(r.title)}</span><span class="search-hit-excerpt">${esc(r.excerpt)}</span><span class="search-hit-meta">${esc([r.tags[0], date(r.date, ctx.site.locale)].filter(Boolean).join(' · '))}</span></a></li>`).join('')}</ul>`
              : `<p class="search-empty">No posts match “${esc(q)}”.</p>`
          : ''
  }
</section>`;
    }
};

export default defaultTheme;
