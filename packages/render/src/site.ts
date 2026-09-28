import type { AnalyticsConfig, Author, ListItem, ListView, OutputFile, PageMeta, Post, PostView, RenderOptions, SearchEntry, ShareCard, ShareCardSite, SiteSettings, Snapshot, Tag, Theme, ThemeContext } from '@masthead/core';
import { renderBody } from './body';
import { rss, sitemapIndex, urlset } from './feeds';
import { blogLd, blogPostingLd, breadcrumbLd, collectionLd, headTags, profileLd } from './head';
import { responsiveImages } from './images';
import { llmsFull, llmsTxt, markdownCopy } from './llms';
import { autoExcerpt, fileFor, ownLinks, plainText, readingMinutes, shortHash, tagLinks, wordCount } from './util';

export interface BuildOptions {
    theme: Theme;
    /** Overrides applied on top of the snapshot's site settings. */
    site?: Partial<SiteSettings>;
    render?: RenderOptions;
    /** Publish time for scheduled posts is compared with this. Defaults to now. */
    now?: Date;
    features?: {
        subscribeUrl?: string;
        analytics?: AnalyticsConfig;
        /**
         * Pages without their own share image get a generated card at <base>content/cards/<key>.png,
         * listed in <base>_masthead/cards.json for the server to draw. `version` names the card design:
         * a new one gives every card a new address.
         */
        shareCards?: { version: string };
    };
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
    stats: BuildStats;
}

export interface BuildStats {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    files: number;
}

/**
 * Post bodies on demand. A site that passes one is rendered without ever
 * holding every body (or every output file) at once, so publishing stays
 * within a small memory budget however many posts there are. Without one,
 * the bodies are read from the snapshot's posts.
 */
export interface BodySource {
    load(ids: string[]): Promise<Map<string, Pick<Post, 'html' | 'markdown' | 'bodyFormat'>>>;
}

/** Bodies are loaded and rendered this many posts at a time. */
const CHUNK = 50;
/** Up to this many posts, rendered bodies are kept between passes instead of rendered twice. */
const KEEP_RENDERED = 400;
/** llms-full.txt carries the full text of this many of the newest posts. */
const LLMS_FULL_POSTS = 100;
/**
 * "Keep reading" adds these to a candidate's similarity in meaning (a cosine; the closest posts on
 * one blog sit within a few hundredths of each other, so these settle near ties and no more): for
 * the share of tags the two posts have in common, and for being new (halving each year).
 */
const RELATED_TAG_WEIGHT = 0.03;
const RELATED_RECENCY_WEIGHT = 0.02;
/** Generated share cards are this size, the one link previews show largest. */
const CARD_SIZE = { width: 1200, height: 630 };

/** The whole site in memory: for static builds and small sites. */
export async function buildSite(snapshot: Snapshot, options: BuildOptions): Promise<BuildResult> {
    const files: OutputFile[] = [];
    const gen = renderSite(snapshot, options);
    for (let r = await gen.next(); ; r = await gen.next()) {
        if (r.done) return { files, routes: r.value.routes, stats: { ...r.value.stats, files: files.length } };
        files.push(r.value);
    }
}

/**
 * The site, one file at a time: theme files first (a page must never reach
 * readers before the stylesheet version it names), then posts, listings,
 * feeds and indexes. Returns the redirects and counts when done.
 */
export async function* renderSite(snapshot: Snapshot, options: BuildOptions, bodies?: BodySource): AsyncGenerator<OutputFile, { routes: Route[]; stats: BuildStats }> {
    const site: SiteSettings = { ...snapshot.site, ...options.site };
    if (!site.url.endsWith('/')) site.url += '/';
    const base = new URL(site.url);
    const basePath = base.pathname;
    const abs = (path: string) => new URL(path, base.origin).toString();
    const perPage = options.render?.postsPerPage ?? 25;
    const now = options.now ?? new Date();
    const theme = options.theme;
    let count = 0;

    const authorsById = new Map(snapshot.authors.map(a => [a.id, a]));
    const tagsById = new Map(snapshot.tags.map(t => [t.id, t]));
    const isLive = (p: Post) => (p.status === 'published' || p.status === 'scheduled') && !!p.publishedAt && new Date(p.publishedAt) <= now;
    // A cover with no description of its own is described by the post's title: never an empty alt, in the page, the share card or the structured data.
    const described = (p: Post): Post => (p.featureImage && !p.featureImageAlt?.trim() ? { ...p, featureImageAlt: p.title } : p);
    const posts = snapshot.posts.filter(p => p.type === 'post' && isLive(p)).map(described).sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!));
    const pages = snapshot.posts.filter(p => p.type === 'page' && isLive(p)).map(described);

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
        subscribeUrl: options.features?.subscribeUrl,
        analytics: options.features?.analytics
    };
    // Share cards, structured data, feeds and sitemaps need absolute image URLs.
    const absolute = (u: string | null | undefined) => (u && u.startsWith('/') && !u.startsWith('//') ? `${base.origin}${u}` : (u ?? null));
    // Stored images' sizes, for img width/height and og:image:width/height.
    const imageSizeOf = (u: string | null | undefined) => (u ? (snapshot.imageSizes?.[u.startsWith(base.origin) ? u.slice(base.origin.length) : u] ?? null) : null);
    // Body images on pages (not in feeds or the Markdown copies): WebP, resized copies, lazy loading.
    const bodyImages = {
        basePath,
        origin: base.origin,
        sizeOf: (path: string) => snapshot.imageSizes?.[path] ?? null,
        sizes: theme.bodyImageSizes ?? { content: '100vw', wide: '100vw', full: '100vw' }
    };
    const metaSite: SiteSettings = {
        ...site,
        logo: absolute(site.logo),
        shareImage: absolute(site.shareImage),
        publisher: site.publisher ? { ...site.publisher, logo: absolute(site.publisher.logo) } : undefined
    };
    // Share cards for pages without their own image. A card's address changes with anything it
    // shows (its title, the logo, the design), so link previews pick up a new title.
    const shareCards = options.features?.shareCards;
    const cards: Record<string, ShareCard> = {};
    const cardSite = shareCardSite(site);
    const cardSiteKey = JSON.stringify([shareCards?.version, cardSite]);
    const shareCard = (name: string, card: ShareCard) => {
        if (!shareCards) return null;
        const key = `${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80)}-${shortHash(cardSiteKey + JSON.stringify(card))}`;
        cards[key] = card;
        return { url: abs(`${basePath}content/cards/${key}.png`), size: CARD_SIZE, alt: card.title };
    };
    const postCount = (n: number) => (n === 1 ? '1 post' : `${n} posts`);

    // ---------------------------------------------------------- theme files first
    yield { path: fileFor(urls.css), contents: theme.css, contentType: 'text/css; charset=utf-8' };
    count++;
    for (const a of theme.assets ?? []) {
        yield { ...a, path: fileFor(`${urls.assets}${a.path}`) };
        count++;
    }

    // ---------------------------------------------------------- pass 1: what listings need from each body
    const all = [...posts, ...pages];
    const keepRendered = !bodies || all.length <= KEEP_RENDERED;
    const newest = new Set(posts.slice(0, Math.max(15, LLMS_FULL_POSTS)).map(p => p.id));
    // search.json is fetched whole by the search box: its per-post text shrinks as the blog grows, to stay a few MB.
    const searchText = all.length <= 500 ? 1500 : all.length <= 2000 ? 600 : 250;
    interface Facts {
        words: number;
        minutes: number;
        excerpt: string;
        summary: string;
        text: string;
        empty: boolean;
        html?: string;
        markdown?: string;
    }
    const facts = new Map<string, Facts>();
    const withBody = async function* (list: Post[]): AsyncGenerator<{ post: Post; html: string }> {
        for (let i = 0; i < list.length; i += CHUNK) {
            const chunk = list.slice(i, i + CHUNK);
            const loaded = bodies ? await bodies.load(chunk.map(p => p.id)) : null;
            for (const p of chunk) {
                const full = loaded ? { ...p, ...(loaded.get(p.id) ?? {}) } : p;
                yield { post: full, html: headingIds(demoteHeadings(ownLinks(tagLinks(renderBody(full), site.url, options.render?.linkTag), site.url))) };
            }
        }
    };
    for await (const { post: p, html } of withBody(all)) {
        const text = plainText(html);
        const keep = keepRendered || newest.has(p.id);
        facts.set(p.id, {
            words: wordCount(html),
            minutes: readingMinutes(html),
            excerpt: own(p.customExcerpt || autoExcerpt(html)),
            summary: own(p.metaDescription || p.customExcerpt || autoExcerpt(html, 160)),
            text: own(text.slice(0, searchText)),
            empty: !text && !p.featureImage,
            html: keep ? html : undefined,
            markdown: keep ? (p.markdown ?? undefined) : undefined
        });
    }

    // Lookups built once, so nothing below scans every post for every post.
    const publicTags = (p: Post) => p.tags.map(id => tagsById.get(id)).filter((t): t is Tag => !!t && t.visibility === 'public');
    const postAuthors = (p: Post) => p.authors.map(id => authorsById.get(id)).filter((a): a is Author => !!a);
    const byTag = new Map<string, Post[]>();
    const byAuthor = new Map<string, Post[]>();
    const add = (map: Map<string, Post[]>, key: string, p: Post) => {
        const list = map.get(key);
        if (list) list.push(p);
        else map.set(key, [p]);
    };
    for (const p of posts) {
        for (const id of p.tags) add(byTag, id, p);
        for (const id of p.authors) add(byAuthor, id, p);
    }
    ctx.topics = snapshot.tags
        .filter(t => t.visibility === 'public')
        .map(t => ({ name: t.name, slug: t.slug, url: urls.tag(t), count: byTag.get(t.id)?.length ?? 0 }))
        .filter(t => t.count > 0)
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const listItem = (p: Post): ListItem => {
        const f = facts.get(p.id)!;
        const tags = publicTags(p);
        return { post: p, url: urls.post(p), excerpt: f.excerpt, readingMinutes: f.minutes, authors: postAuthors(p), primaryTag: tags[0], tags };
    };
    const livePosts = new Map(posts.map(p => [p.id, p]));
    const newestAt = posts.length ? Date.parse(posts[0].publishedAt!) : 0;
    /**
     * Up to three other posts to read next. The posts closest in meaning come first, nudged toward
     * shared tags and newer posts (years counted back from the newest post, so a rebuild changes
     * nothing by itself). A post without embeddings, and any places left, take the newest of the
     * same primary tag, then the newest overall.
     */
    const related = (post: Post, tags: Tag[]): Post[] => {
        const out: Post[] = [];
        const near = snapshot.related?.[post.id];
        if (near?.length) {
            const mine = new Set(tags.map(t => t.id));
            const scored: { p: Post; s: number }[] = [];
            for (const { id, score } of near) {
                const p = livePosts.get(id);
                if (!p || p.id === post.id) continue;
                const theirs = publicTags(p);
                const shared = theirs.reduce((n, t) => n + (mine.has(t.id) ? 1 : 0), 0);
                const overlap = shared ? shared / (mine.size + theirs.length - shared) : 0;
                const years = (newestAt - Date.parse(p.publishedAt!)) / 31_557_600_000;
                scored.push({ p, s: score + RELATED_TAG_WEIGHT * overlap + RELATED_RECENCY_WEIGHT * 0.5 ** years });
            }
            scored.sort((a, b) => b.s - a.s);
            for (const { p } of scored.slice(0, 3)) out.push(p);
        }
        const primary = tags[0];
        for (const p of primary ? (byTag.get(primary.id) ?? []) : []) {
            if (out.length === 3) return out;
            if (p.id !== post.id && !out.includes(p)) out.push(p);
        }
        for (const p of posts) {
            if (out.length === 3) break;
            if (p.id !== post.id && !out.includes(p)) out.push(p);
        }
        return out;
    };

    const html = (urlPath: string, meta: PageMeta, main: string): OutputFile => ({ path: fileFor(urlPath), contents: theme.document(ctx, meta, main), contentType: 'text/html; charset=utf-8' });
    const blogCrumb = basePath === '/' ? [] : [{ name: 'Blog', url: site.url }];
    const home = { name: site.publisher?.name ?? site.title, url: `${base.origin}/` };

    // ---------------------------------------------------------- pass 2: posts and pages
    const renderPost = (p: Post, body: string, markdown: string | null | undefined): OutputFile[] => {
        const f = facts.get(p.id)!;
        const url = abs(urls.post(p));
        const tags = publicTags(p);
        const authors = postAuthors(p);
        const description = f.summary || site.description;
        const coverSize = imageSizeOf(p.featureImage);
        const shareImage = p.ogImage || p.featureImage;
        const card = shareImage ? null : shareCard(p.slug, postShareCard(p, tags, authors, f.minutes));
        const view: PostView = {
            post: p,
            url: urls.post(p),
            html: responsiveImages(body, { ...bodyImages, eagerFirst: !p.featureImage }),
            excerpt: f.excerpt,
            readingMinutes: f.minutes,
            authors: authors.map(a => ({ ...a, url: urls.author(a) })),
            tags: tags.map(t => ({ ...t, url: urls.tag(t) })),
            related: p.type === 'post' ? related(p, tags).map(listItem) : [],
            featureImageSize: coverSize ?? undefined
        };
        const jsonLd =
            p.type === 'post'
                ? [
                      blogPostingLd({
                          post: p,
                          url,
                          description,
                          image: absolute(p.featureImage) ?? card?.url,
                          imageAlt: p.featureImage ? p.featureImageAlt : card?.alt,
                          imageSize: coverSize ?? card?.size,
                          authors: authors.map(a => ({ author: { ...a, profileImage: absolute(a.profileImage) }, url: abs(urls.author(a)) })),
                          tags,
                          words: f.words,
                          site: metaSite
                      }),
                      breadcrumbLd([home, ...blogCrumb, { name: p.title, url }])
                  ]
                : [breadcrumbLd([home, ...blogCrumb, { name: p.title, url }])];
        const title = p.metaTitle || p.title;
        return [
            html(
                urls.post(p),
                {
                    title,
                    description,
                    canonical: p.canonicalUrl || url,
                    head: headTags({
                        site: metaSite,
                        title: p.ogTitle || title,
                        description: p.ogDescription || description,
                        canonical: p.canonicalUrl || url,
                        type: p.type === 'post' ? 'article' : 'website',
                        image: absolute(shareImage) ?? card?.url,
                        imageAlt: card ? card.alt : p.featureImageAlt,
                        imageSize: card ? card.size : imageSizeOf(shareImage),
                        authors: p.type === 'post' ? authors.map(a => a.name) : undefined,
                        publishedAt: p.type === 'post' ? p.publishedAt : null,
                        updatedAt: p.type === 'post' ? p.updatedAt : null,
                        tags,
                        rss: abs(urls.rss),
                        markdown: abs(urls.markdown(p)),
                        jsonLd
                    })
                },
                theme.post(ctx, view)
            ),
            {
                path: fileFor(urls.markdown(p)),
                contents: markdownCopy({ title: p.title, url, authors: authors.map(a => a.name), publishedAt: p.publishedAt, updatedAt: p.updatedAt, markdown: markdown ?? plainText(body) }),
                contentType: 'text/markdown; charset=utf-8'
            }
        ];
    };
    if (keepRendered) {
        for (const p of all) {
            const f = facts.get(p.id)!;
            for (const file of renderPost(p, f.html!, f.markdown)) (yield file, count++);
        }
    } else {
        for await (const { post: p, html: body } of withBody(all)) for (const file of renderPost(p, body, p.markdown)) (yield file, count++);
    }

    // ---------------------------------------------------------- listings
    const listing = function* (
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
            /** A generated share card, used when there is no share image of its own. */
            card?: { name: string; card: ShareCard };
            jsonLd: object[];
            tag?: Tag;
            author?: Author;
            highlights?: ListItem[];
        }
    ): Generator<OutputFile> {
        const total = Math.max(1, Math.ceil(items.length / perPage));
        const card = extra.card ? shareCard(extra.card.name, extra.card.card) : null;
        for (let n = 1; n <= total; n++) {
            const path = urls.paged(prefix, n);
            const prevUrl = n > 1 ? urls.paged(prefix, n - 1) : undefined;
            const nextUrl = n < total ? urls.paged(prefix, n + 1) : undefined;
            const title = n === 1 ? extra.title : `${extra.pagedTitle ?? extra.title} (Page ${n})`;
            const description = extra.description || site.description;
            const view: ListView = {
                kind,
                heading: extra.heading,
                description: extra.description,
                items: items.slice((n - 1) * perPage, n * perPage).map(listItem),
                page: n,
                pages: total,
                prevUrl,
                nextUrl,
                tag: extra.tag,
                author: extra.author,
                highlights: n === 1 ? extra.highlights : undefined
            };
            const listImage = card ? null : (extra.image ?? site.shareImage ?? items[0]?.featureImage ?? null);
            yield html(path, {
                title,
                description,
                canonical: abs(path),
                head: headTags({
                    site: metaSite,
                    title: (n === 1 && extra.shareTitle) || title,
                    description: (n === 1 && extra.shareDescription) || description,
                    canonical: abs(path),
                    type: extra.type,
                    image: card?.url ?? absolute(listImage),
                    imageAlt: card?.alt,
                    imageSize: card?.size ?? imageSizeOf(listImage),
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
    for (const file of listing('index', basePath, posts, {
        highlights: mostRead.length === 3 ? mostRead : undefined,
        heading: site.title,
        title: site.metaTitle || site.title,
        pagedTitle: site.title,
        description: site.metaDescription || site.description,
        shareTitle: site.ogTitle,
        shareDescription: site.ogDescription,
        type: 'website',
        // The front page's share image is the site's, when it has one.
        card: site.shareImage ? undefined : { name: 'home', card: { kind: 'home', title: site.appearance?.hero?.title || site.title, text: site.ogDescription || site.metaDescription || site.description } },
        jsonLd: [blogLd(metaSite)]
    }))
        (yield file, count++);

    const tagsWithPosts = snapshot.tags.filter(t => t.visibility === 'public' && byTag.has(t.id));
    for (const t of tagsWithPosts) {
        for (const file of listing('tag', urls.tag(t), byTag.get(t.id)!, {
            heading: t.name,
            title: `${t.name} - ${site.title}`,
            description: t.description,
            type: 'website',
            card: { name: `tag-${t.slug}`, card: { kind: 'tag', title: t.name, eyebrow: 'Topic', text: t.description, meta: postCount(byTag.get(t.id)!.length) } },
            tag: t,
            jsonLd: [collectionLd(t.name, abs(urls.tag(t)), t.description)]
        }))
            (yield file, count++);
    }

    const authorsWithPosts = snapshot.authors.filter(a => byAuthor.has(a.id));
    for (const a of authorsWithPosts) {
        for (const file of listing('author', urls.author(a), byAuthor.get(a.id)!, {
            heading: a.name,
            title: `${a.name} - ${site.title}`,
            description: a.bio,
            type: 'profile',
            image: a.profileImage,
            card: { name: `author-${a.slug}`, card: { kind: 'author', title: a.name, eyebrow: 'Author', text: a.bio, image: absolute(a.profileImage), meta: postCount(byAuthor.get(a.id)!.length) } },
            author: a,
            jsonLd: [profileLd({ ...a, profileImage: absolute(a.profileImage) }, abs(urls.author(a)))]
        }))
            (yield file, count++);
    }

    // ---------------------------------------------------------- the rest
    const rest: OutputFile[] = [];
    rest.push({
        path: fileFor(`${basePath}404.html`),
        contents: theme.document(ctx, { title: `Page not found - ${site.title}`, description: site.description, canonical: site.url, head: '<meta name="robots" content="noindex">' }, theme.notFound(ctx)),
        contentType: 'text/html; charset=utf-8'
    });

    // Pages with no words and no picture (say, an untitled About stub) stay out of indexes.
    const listed = (p: Post) => !facts.get(p.id)!.empty;

    // Search index: read by the theme's search box, and by the server's search page.
    const search: SearchEntry[] = all.filter(listed).map(p => {
        const f = facts.get(p.id)!;
        return {
            title: p.title,
            url: urls.post(p),
            excerpt: f.excerpt,
            tags: publicTags(p).map(t => t.name),
            authors: postAuthors(p).map(a => a.name),
            date: p.type === 'post' ? p.publishedAt : null,
            image: p.featureImage ?? null,
            text: f.text
        };
    });
    rest.push({ path: fileFor(urls.searchIndex), contents: JSON.stringify(search), contentType: 'application/json; charset=utf-8' });

    const feedUrl = abs(urls.rss);
    rest.push({
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
                excerpt: facts.get(p.id)!.excerpt,
                html: facts.get(p.id)!.html ?? '',
                authors: postAuthors(p).map(a => a.name),
                tags: publicTags(p).map(t => t.name),
                image: absolute(p.featureImage)
            }))
        ),
        contentType: 'application/rss+xml; charset=utf-8'
    });

    const lastmod = (list: Post[]) => list.reduce<string | null>((m, p) => (!m || p.updatedAt > m ? p.updatedAt : m), null);
    const maps: Record<string, { xml: string; lastmod: string | null }> = {
        'sitemap-posts.xml': { xml: urlset(posts.map(p => ({ url: abs(urls.post(p)), lastmod: p.updatedAt, image: absolute(p.featureImage) }))), lastmod: lastmod(posts) },
        'sitemap-pages.xml': {
            xml: urlset([{ url: site.url, lastmod: lastmod(posts) }, ...pages.filter(listed).map(p => ({ url: abs(urls.post(p)), lastmod: p.updatedAt, image: absolute(p.featureImage) }))]),
            lastmod: lastmod([...posts, ...pages])
        },
        'sitemap-tags.xml': {
            xml: urlset(tagsWithPosts.map(t => ({ url: abs(urls.tag(t)), lastmod: lastmod(byTag.get(t.id)!) }))),
            lastmod: lastmod(posts)
        },
        'sitemap-authors.xml': {
            xml: urlset(authorsWithPosts.map(a => ({ url: abs(urls.author(a)), lastmod: lastmod(byAuthor.get(a.id)!), image: absolute(a.profileImage) }))),
            lastmod: lastmod(posts)
        }
    };
    for (const [name, m] of Object.entries(maps)) rest.push({ path: fileFor(`${basePath}${name}`), contents: m.xml, contentType: 'application/xml; charset=utf-8' });
    rest.push({
        path: fileFor(`${basePath}sitemap.xml`),
        contents: sitemapIndex(Object.entries(maps).map(([name, m]) => ({ url: abs(`${basePath}${name}`), lastmod: m.lastmod }))),
        contentType: 'application/xml; charset=utf-8'
    });

    const entry = (p: Post) => ({ title: p.title, url: abs(urls.markdown(p)), summary: facts.get(p.id)!.summary });
    rest.push({
        path: fileFor(`${basePath}llms.txt`),
        contents: llmsTxt(site, posts.filter(listed).map(entry), pages.filter(listed).map(entry), abs(`${basePath}llms-full.txt`)),
        contentType: 'text/plain; charset=utf-8'
    });
    rest.push({
        path: fileFor(`${basePath}llms-full.txt`),
        contents: llmsFull(
            site,
            posts.slice(0, LLMS_FULL_POSTS).map(p => {
                const f = facts.get(p.id)!;
                return { title: p.title, url: abs(urls.post(p)), authors: postAuthors(p).map(a => a.name), publishedAt: p.publishedAt, updatedAt: p.updatedAt, markdown: f.markdown ?? plainText(f.html ?? '') };
            }),
            posts.length
        ),
        contentType: 'text/plain; charset=utf-8'
    });

    const routes: Route[] = [
        { from: urls.rss, to: `${urls.rss}index.xml`, status: 200 },
        { from: urls.rss.replace(/\/$/, ''), to: urls.rss, status: 301 },
        { from: `${basePath}page/1/`, to: basePath, status: 301 },
        ...(basePath === '/' ? [] : [{ from: basePath.replace(/\/$/, ''), to: basePath, status: 301 as const }])
    ];
    rest.push({ path: fileFor(`${basePath}_masthead/routes.json`), contents: `${JSON.stringify(routes, null, 2)}\n`, contentType: 'application/json' });
    if (shareCards) rest.push({ path: fileFor(`${basePath}_masthead/cards.json`), contents: JSON.stringify({ site: cardSite, cards }), contentType: 'application/json' });
    for (const file of rest) (yield file, count++);

    return {
        routes,
        stats: { posts: posts.length, pages: pages.length, tags: tagsWithPosts.length, authors: authorsWithPosts.length, files: count }
    };
}

/**
 * A copy of a short string that does not point into the long one it was cut
 * from. JavaScript engines keep the whole parent alive behind a slice, which
 * would hold every post's full text in memory through the build.
 */
function own(s: string): string {
    return s.length ? (JSON.parse(JSON.stringify(s)) as string) : s;
}

/** Section links: every h2 to h4 without an id gets one from its text, so readers and AI answers can cite a section. */
/**
 * The post's title is the page's only h1: a body that uses h1 for its sections moves every
 * heading down one level (h1 to h2, h2 to h3...), keeping its outline.
 */
function demoteHeadings(html: string): string {
    if (!/<h1[\s>]/i.test(html)) return html;
    return html.replace(/<(\/?)h([1-5])(?=[\s>])/gi, (_, close: string, level: string) => `<${close}h${Number(level) + 1}`);
}

function headingIds(html: string): string {
    const used = new Set<string>();
    for (const m of html.matchAll(/\sid="([^"]+)"/g)) used.add(m[1]);
    return html.replace(/<h([2-4])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (whole, level: string, attrs: string | undefined, inner: string) => {
        if (attrs && /\sid=/.test(attrs)) return whole;
        const slug =
            plainText(inner)
                .toLowerCase()
                .normalize('NFKD')
                .replace(/[̀-ͯ]/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 80) || 'section';
        let id = slug;
        for (let n = 2; used.has(id); n++) id = `${slug}-${n}`;
        used.add(id);
        return `<h${level} id="${id}"${attrs ?? ''}>${inner}</h${level}>`;
    });
}

/** What every share card of a site shows: its lockup and sky, with absolute addresses. */
export function shareCardSite(site: SiteSettings): ShareCardSite {
    const origin = new URL(site.url).origin;
    const absolute = (u: string | null | undefined) => (u && u.startsWith('/') && !u.startsWith('//') ? `${origin}${u}` : (u ?? null));
    return { title: site.title, wordmark: site.appearance?.hero?.title || null, logo: absolute(site.logo), backdrop: absolute(site.appearance?.backdrop?.image), locale: site.locale, url: site.url };
}

/** A post's share card: its title, primary topic, date and byline (a page shows only its title). */
export function postShareCard(p: Post, tags: Tag[], authors: Author[], minutes: number): ShareCard {
    const post = p.type === 'post';
    return {
        kind: 'post',
        title: p.ogTitle || p.title,
        eyebrow: post ? tags[0]?.name : null,
        date: post ? p.publishedAt : null,
        meta: post ? [authors.map(a => a.name).join(', '), `${minutes} min read`].filter(Boolean).join(' · ') : null
    };
}

/** Changes whenever the theme's stylesheet or files change, so their URLs can be cached for good. */
export function themeAssetsVersion(theme: Theme): string {
    return shortHash(theme.css + (theme.assets ?? []).map(a => (typeof a.contents === 'string' ? a.contents : String(a.contents.length))).join(''));
}
