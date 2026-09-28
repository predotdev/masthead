import type { Author, ListItem, ListView, OutputFile, PageMeta, Post, PostView, RenderOptions, SearchEntry, SiteSettings, Snapshot, Tag, Theme, ThemeContext } from '@masthead/core';
import { renderBody } from './body';
import { rss, sitemapIndex, urlset } from './feeds';
import { blogLd, blogPostingLd, breadcrumbLd, collectionLd, headTags, profileLd } from './head';
import { llmsTxt, markdownCopy } from './llms';
import { autoExcerpt, fileFor, plainText, readingMinutes, shortHash, tagLinks, wordCount } from './util';

export interface BuildOptions {
    theme: Theme;
    /** Overrides applied on top of the snapshot's site settings. */
    site?: Partial<SiteSettings>;
    render?: RenderOptions;
    /** Publish time for scheduled posts is compared with this. Defaults to now. */
    now?: Date;
    features?: { subscribeUrl?: string };
}

/** Rewrites and redirects the host should apply. Written to <base>/_masthead/routes.json. */
export interface Route {
    from: string;
    to: string;
    status: 200 | 301 | 302 | 410;
}

export interface BuildResult {
    files: OutputFile[];
    routes: Route[];
    stats: { posts: number; pages: number; tags: number; authors: number; files: number };
}

export async function buildSite(snapshot: Snapshot, options: BuildOptions): Promise<BuildResult> {
    const site: SiteSettings = { ...snapshot.site, ...options.site };
    if (!site.url.endsWith('/')) site.url += '/';
    const base = new URL(site.url);
    const basePath = base.pathname;
    const abs = (path: string) => new URL(path, base.origin).toString();
    const perPage = options.render?.postsPerPage ?? 25;
    const now = options.now ?? new Date();
    const theme = options.theme;

    const authorsById = new Map(snapshot.authors.map(a => [a.id, a]));
    const tagsById = new Map(snapshot.tags.map(t => [t.id, t]));
    const isLive = (p: Post) => (p.status === 'published' || p.status === 'scheduled') && !!p.publishedAt && new Date(p.publishedAt) <= now;
    const posts = snapshot.posts.filter(p => p.type === 'post' && isLive(p)).sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!));
    const pages = snapshot.posts.filter(p => p.type === 'page' && isLive(p));

    const urls = {
        post: (p: Post) => `${basePath}${p.slug}/`,
        markdown: (p: Post) => `${basePath}${p.slug}.md`,
        tag: (t: Tag) => `${basePath}tag/${t.slug}/`,
        author: (a: Author) => `${basePath}author/${a.slug}/`,
        paged: (prefix: string, n: number) => (n === 1 ? prefix : `${prefix}page/${n}/`),
        rss: `${basePath}rss/`,
        css: `${basePath}assets/masthead.css`,
        assets: `${basePath}assets/`,
        search: `${basePath}search/`,
        searchIndex: `${basePath}search.json`
    };
    const version = themeAssetsVersion(theme);
    const ctx: ThemeContext = {
        site,
        basePath,
        cssHref: `${urls.css}?v=${version}`,
        assetsVersion: version,
        rssHref: urls.rss,
        assetsHref: urls.assets,
        searchHref: urls.search,
        searchIndexHref: urls.searchIndex,
        subscribeUrl: options.features?.subscribeUrl
    };
    // Share cards, structured data, feeds and sitemaps need absolute image URLs.
    const absolute = (u: string | null | undefined) => (u && u.startsWith('/') && !u.startsWith('//') ? `${base.origin}${u}` : (u ?? null));
    const metaSite: SiteSettings = {
        ...site,
        logo: absolute(site.logo),
        shareImage: absolute(site.shareImage),
        publisher: site.publisher ? { ...site.publisher, logo: absolute(site.publisher.logo) } : undefined
    };

    const rendered = new Map<string, { html: string; words: number; minutes: number; excerpt: string }>();
    for (const p of [...posts, ...pages]) {
        const html = tagLinks(renderBody(p), site.url, options.render?.linkTag);
        rendered.set(p.id, { html, words: wordCount(html), minutes: readingMinutes(html), excerpt: p.customExcerpt || autoExcerpt(html) });
    }

    const publicTags = (p: Post) => p.tags.map(id => tagsById.get(id)).filter((t): t is Tag => !!t && t.visibility === 'public');
    ctx.topics = snapshot.tags
        .filter(t => t.visibility === 'public')
        .map(t => ({ name: t.name, slug: t.slug, url: urls.tag(t), count: posts.filter(p => p.tags.includes(t.id)).length }))
        .filter(t => t.count > 0)
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const postAuthors = (p: Post) => p.authors.map(id => authorsById.get(id)).filter((a): a is Author => !!a);
    const listItem = (p: Post): ListItem => {
        const r = rendered.get(p.id)!;
        const tags = publicTags(p);
        return { post: p, url: urls.post(p), excerpt: r.excerpt, readingMinutes: r.minutes, authors: postAuthors(p), primaryTag: tags[0], tags };
    };

    const files: OutputFile[] = [];
    const addHtml = (urlPath: string, meta: PageMeta, main: string) =>
        files.push({ path: fileFor(urlPath), contents: theme.document(ctx, meta, main), contentType: 'text/html; charset=utf-8' });
    const blogCrumb = basePath === '/' ? [] : [{ name: 'Blog', url: site.url }];
    const home = { name: site.publisher?.name ?? site.title, url: `${base.origin}/` };

    // ---------------------------------------------------------- posts and pages
    for (const p of [...posts, ...pages]) {
        const r = rendered.get(p.id)!;
        const url = abs(urls.post(p));
        const tags = publicTags(p);
        const authors = postAuthors(p);
        const description = p.metaDescription || p.customExcerpt || autoExcerpt(r.html, 160);
        const view: PostView = {
            post: p,
            url: urls.post(p),
            html: r.html,
            excerpt: r.excerpt,
            readingMinutes: r.minutes,
            authors: authors.map(a => ({ ...a, url: urls.author(a) })),
            tags: tags.map(t => ({ ...t, url: urls.tag(t) })),
            related: p.type === 'post' ? related(p, posts, tags[0]).map(listItem) : []
        };
        const jsonLd =
            p.type === 'post'
                ? [
                      blogPostingLd({
                          post: p,
                          url,
                          description,
                          image: absolute(p.featureImage),
                          authors: authors.map(a => ({ author: { ...a, profileImage: absolute(a.profileImage) }, url: abs(urls.author(a)) })),
                          tags,
                          words: r.words,
                          site: metaSite
                      }),
                      breadcrumbLd([home, ...blogCrumb, { name: p.title, url }])
                  ]
                : [breadcrumbLd([home, ...blogCrumb, { name: p.title, url }])];
        const title = p.metaTitle || p.title;
        addHtml(urls.post(p), {
            title,
            description,
            canonical: p.canonicalUrl || url,
            head: headTags({
                site: metaSite,
                title: p.ogTitle || title,
                description: p.ogDescription || description,
                canonical: p.canonicalUrl || url,
                type: p.type === 'post' ? 'article' : 'website',
                image: absolute(p.ogImage || p.featureImage),
                imageAlt: p.featureImageAlt,
                publishedAt: p.type === 'post' ? p.publishedAt : null,
                updatedAt: p.type === 'post' ? p.updatedAt : null,
                tags,
                rss: abs(urls.rss),
                markdown: abs(urls.markdown(p)),
                jsonLd
            })
        }, theme.post(ctx, view));
        files.push({
            path: fileFor(urls.markdown(p)),
            contents: markdownCopy({ title: p.title, url, authors: authors.map(a => a.name), publishedAt: p.publishedAt, updatedAt: p.updatedAt, markdown: p.markdown ?? plainText(r.html) }),
            contentType: 'text/markdown; charset=utf-8'
        });
    }

    // ---------------------------------------------------------- listings
    const listing = (
        kind: ListView['kind'],
        prefix: string,
        items: Post[],
        extra: {
            heading: string;
            title: string;
            /** Title for page 2 onward; defaults to title. */
            pagedTitle?: string;
            description?: string | null;
            shareTitle?: string | null;
            shareDescription?: string | null;
            type: 'website' | 'profile';
            image?: string | null;
            jsonLd: object[];
            tag?: Tag;
            author?: Author;
            highlights?: ListItem[];
        }
    ) => {
        const count = Math.max(1, Math.ceil(items.length / perPage));
        for (let n = 1; n <= count; n++) {
            const path = urls.paged(prefix, n);
            const prevUrl = n > 1 ? urls.paged(prefix, n - 1) : undefined;
            const nextUrl = n < count ? urls.paged(prefix, n + 1) : undefined;
            const title = n === 1 ? extra.title : `${extra.pagedTitle ?? extra.title} (Page ${n})`;
            const description = extra.description || site.description;
            const view: ListView = {
                kind,
                heading: extra.heading,
                description: extra.description,
                items: items.slice((n - 1) * perPage, n * perPage).map(listItem),
                page: n,
                pages: count,
                prevUrl,
                nextUrl,
                tag: extra.tag,
                author: extra.author,
                highlights: n === 1 ? extra.highlights : undefined
            };
            addHtml(path, {
                title,
                description,
                canonical: abs(path),
                head: headTags({
                    site: metaSite,
                    title: (n === 1 && extra.shareTitle) || title,
                    description: (n === 1 && extra.shareDescription) || description,
                    canonical: abs(path),
                    type: extra.type,
                    image: absolute(extra.image ?? site.shareImage ?? items[0]?.featureImage ?? null),
                    rss: abs(urls.rss),
                    prev: prevUrl && abs(prevUrl),
                    next: nextUrl && abs(nextUrl),
                    jsonLd: extra.jsonLd
                })
            }, theme.list(ctx, view));
        }
    };

    // Most read: newsletter opens, among posts other than the newest (which leads the page).
    const mostRead = posts
        .slice(1)
        .filter(p => (p.newsletter?.opened ?? 0) > 0)
        .sort((a, b) => (b.newsletter?.opened ?? 0) - (a.newsletter?.opened ?? 0))
        .slice(0, 3)
        .map(listItem);
    listing('index', basePath, posts, {
        highlights: mostRead.length === 3 ? mostRead : undefined,
        heading: site.title,
        title: site.metaTitle || site.title,
        pagedTitle: site.title,
        description: site.metaDescription || site.description,
        shareTitle: site.ogTitle,
        shareDescription: site.ogDescription,
        type: 'website',
        jsonLd: [blogLd(metaSite)]
    });

    const tagsWithPosts = snapshot.tags.filter(t => t.visibility === 'public' && posts.some(p => p.tags.includes(t.id)));
    for (const t of tagsWithPosts) {
        const tagPosts = posts.filter(p => p.tags.includes(t.id));
        listing('tag', urls.tag(t), tagPosts, {
            heading: t.name,
            title: `${t.name} - ${site.title}`,
            description: t.description,
            type: 'website',
            tag: t,
            jsonLd: [collectionLd(t.name, abs(urls.tag(t)), t.description)]
        });
    }

    const authorsWithPosts = snapshot.authors.filter(a => posts.some(p => p.authors.includes(a.id)));
    for (const a of authorsWithPosts) {
        const authorPosts = posts.filter(p => p.authors.includes(a.id));
        listing('author', urls.author(a), authorPosts, {
            heading: a.name,
            title: `${a.name} - ${site.title}`,
            description: a.bio,
            type: 'profile',
            image: a.profileImage,
            author: a,
            jsonLd: [profileLd({ ...a, profileImage: absolute(a.profileImage) }, abs(urls.author(a)))]
        });
    }

    // ---------------------------------------------------------- the rest
    files.push({
        path: fileFor(`${basePath}404.html`),
        contents: theme.document(ctx, { title: `Page not found - ${site.title}`, description: site.description, canonical: site.url, head: '<meta name="robots" content="noindex">' }, theme.notFound(ctx)),
        contentType: 'text/html; charset=utf-8'
    });
    files.push({ path: fileFor(urls.css), contents: theme.css, contentType: 'text/css; charset=utf-8' });
    for (const a of theme.assets ?? []) files.push({ ...a, path: fileFor(`${urls.assets}${a.path}`) });

    // Search index: read by the theme's search box, and by the server's search page.
    const search: SearchEntry[] = [...posts, ...pages].map(p => {
        const r = rendered.get(p.id)!;
        return {
            title: p.title,
            url: urls.post(p),
            excerpt: r.excerpt,
            tags: publicTags(p).map(t => t.name),
            authors: postAuthors(p).map(a => a.name),
            date: p.type === 'post' ? p.publishedAt : null,
            image: p.featureImage ?? null,
            text: plainText(r.html).slice(0, 1500)
        };
    });
    files.push({ path: fileFor(urls.searchIndex), contents: JSON.stringify(search), contentType: 'application/json; charset=utf-8' });

    const feedUrl = abs(urls.rss);
    files.push({
        path: fileFor(urls.rss, 'index.xml'),
        contents: rss(
            metaSite,
            feedUrl,
            posts.slice(0, 15).map(p => ({
                title: p.title,
                url: abs(urls.post(p)),
                id: p.id,
                publishedAt: p.publishedAt!,
                updatedAt: p.updatedAt,
                excerpt: rendered.get(p.id)!.excerpt,
                html: rendered.get(p.id)!.html,
                authors: postAuthors(p).map(a => a.name),
                tags: publicTags(p).map(t => t.name),
                image: absolute(p.featureImage)
            }))
        ),
        contentType: 'application/rss+xml; charset=utf-8'
    });

    const newest = (list: Post[]) => list.reduce<string | null>((m, p) => (!m || p.updatedAt > m ? p.updatedAt : m), null);
    const maps: Record<string, { xml: string; lastmod: string | null }> = {
        'sitemap-posts.xml': { xml: urlset(posts.map(p => ({ url: abs(urls.post(p)), lastmod: p.updatedAt, image: absolute(p.featureImage) }))), lastmod: newest(posts) },
        'sitemap-pages.xml': {
            xml: urlset([{ url: site.url, lastmod: newest(posts) }, ...pages.map(p => ({ url: abs(urls.post(p)), lastmod: p.updatedAt, image: absolute(p.featureImage) }))]),
            lastmod: newest([...posts, ...pages])
        },
        'sitemap-tags.xml': {
            xml: urlset(tagsWithPosts.map(t => ({ url: abs(urls.tag(t)), lastmod: newest(posts.filter(p => p.tags.includes(t.id))) }))),
            lastmod: newest(posts)
        },
        'sitemap-authors.xml': {
            xml: urlset(authorsWithPosts.map(a => ({ url: abs(urls.author(a)), lastmod: newest(posts.filter(p => p.authors.includes(a.id))), image: absolute(a.profileImage) }))),
            lastmod: newest(posts)
        }
    };
    for (const [name, m] of Object.entries(maps)) files.push({ path: fileFor(`${basePath}${name}`), contents: m.xml, contentType: 'application/xml; charset=utf-8' });
    files.push({
        path: fileFor(`${basePath}sitemap.xml`),
        contents: sitemapIndex(Object.entries(maps).map(([name, m]) => ({ url: abs(`${basePath}${name}`), lastmod: m.lastmod }))),
        contentType: 'application/xml; charset=utf-8'
    });

    files.push({
        path: fileFor(`${basePath}llms.txt`),
        contents: llmsTxt(
            site,
            posts.map(p => ({ title: p.title, url: abs(urls.markdown(p)), summary: autoExcerpt(rendered.get(p.id)!.html, 160) })),
            pages.map(p => ({ title: p.title, url: abs(urls.markdown(p)), summary: autoExcerpt(rendered.get(p.id)!.html, 160) }))
        ),
        contentType: 'text/plain; charset=utf-8'
    });

    const routes: Route[] = [
        { from: urls.rss, to: `${urls.rss}index.xml`, status: 200 },
        { from: urls.rss.replace(/\/$/, ''), to: urls.rss, status: 301 },
        { from: `${basePath}page/1/`, to: basePath, status: 301 },
        ...(basePath === '/' ? [] : [{ from: basePath.replace(/\/$/, ''), to: basePath, status: 301 as const }])
    ];
    files.push({ path: fileFor(`${basePath}_masthead/routes.json`), contents: `${JSON.stringify(routes, null, 2)}\n`, contentType: 'application/json' });

    return {
        files,
        routes,
        stats: { posts: posts.length, pages: pages.length, tags: tagsWithPosts.length, authors: authorsWithPosts.length, files: files.length }
    };
}

/** Changes whenever the theme's stylesheet or files change, so their URLs can be cached for good. */
export function themeAssetsVersion(theme: Theme): string {
    return shortHash(theme.css + (theme.assets ?? []).map(a => (typeof a.contents === 'string' ? a.contents : String(a.contents.length))).join(''));
}

/** Up to three other posts, preferring the same primary tag. */
function related(post: Post, posts: Post[], primary?: Tag): Post[] {
    const others = posts.filter(p => p.id !== post.id);
    const sameTag = primary ? others.filter(p => p.tags.includes(primary.id)) : [];
    const rest = others.filter(p => !sameTag.includes(p));
    return [...sameTag, ...rest].slice(0, 3);
}
