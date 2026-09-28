/**
 * The content model and the connector interfaces.
 *
 * Everything vendor-specific lives behind one of these interfaces, in its own
 * connector package. The core never imports a vendor SDK.
 */

// ------------------------------------------------------------------ content

export interface Author {
    id: string;
    slug: string;
    name: string;
    bio?: string | null;
    profileImage?: string | null;
    website?: string | null;
    /** Handles or full URLs; rendered as sameAs links in structured data. */
    twitter?: string | null;
    linkedin?: string | null;
}

export interface Tag {
    id: string;
    slug: string;
    name: string;
    description?: string | null;
    /** Internal tags organize content and are never rendered publicly. */
    visibility: 'public' | 'internal';
}

export interface Post {
    id: string;
    type: 'post' | 'page';
    slug: string;
    title: string;
    status: 'draft' | 'scheduled' | 'published';
    /**
     * Which field is the body. 'markdown' for posts written here; 'html' for
     * imported posts, which keep their original HTML until someone converts
     * them to Markdown in the editor.
     */
    bodyFormat?: 'markdown' | 'html';
    /** The body in Markdown. Imported posts also carry a converted copy, used for the .md version. */
    markdown?: string | null;
    /** The original HTML of an imported post. */
    html?: string | null;
    customExcerpt?: string | null;
    featureImage?: string | null;
    featureImageAlt?: string | null;
    featureImageCaption?: string | null;
    metaTitle?: string | null;
    metaDescription?: string | null;
    ogImage?: string | null;
    ogTitle?: string | null;
    ogDescription?: string | null;
    twitterImage?: string | null;
    twitterTitle?: string | null;
    twitterDescription?: string | null;
    canonicalUrl?: string | null;
    featured?: boolean;
    publishedAt: string | null;
    updatedAt: string;
    createdAt: string;
    /** Author ids, first is the primary author. */
    authors: string[];
    /** Tag ids in order; the first public tag is the primary tag. */
    tags: string[];
    /** Tag ids the server picked for the post by itself; null when it never tried. */
    autoTags?: string[] | null;
    /** Stats from when the post went out as a newsletter, if it did. */
    newsletter?: { sentAt: string | null; recipients: number; delivered: number; opened: number } | null;
    /** The day a draft is planned for (YYYY-MM-DD), on the admin's content calendar. Never shown to readers. */
    targetDate?: string | null;
}

export type StaffRole = 'owner' | 'admin' | 'editor' | 'author' | 'contributor';

/** A person who can sign in to the admin. Authors are staff. Contains email addresses: keep snapshots private. */
export interface StaffRecord extends Author {
    email: string;
    role: StaffRole;
    status: 'active' | 'invited' | 'suspended';
}

export interface NewsletterSettings {
    senderName?: string | null;
    senderEmail?: string | null;
    replyTo?: string | null;
}

export interface NavigationItem {
    label: string;
    url: string;
    /** Shown under the label in a dropdown menu. */
    description?: string | null;
    /** A small badge next to the label, e.g. "New" or "Labs". */
    badge?: string | null;
    /** An icon name from the theme's set, shown in dropdown menus (e.g. "terminal", "window", "workflow", "pointer", "flask"). */
    icon?: string | null;
    /** Heading this item sits under inside a dropdown menu. */
    group?: string | null;
    /** Makes the item a dropdown menu; its own url is then ignored. */
    items?: NavigationItem[];
}

export type SocialNetwork = 'x' | 'linkedin' | 'youtube' | 'instagram' | 'discord' | 'github' | 'facebook' | 'threads' | 'bluesky' | 'mastodon' | 'tiktok';

export interface FooterSettings {
    /** One line under the brand. */
    tagline?: string | null;
    columns?: { title: string; links: NavigationItem[] }[];
    /** Links in the bottom row, such as the privacy policy and terms. */
    legal?: NavigationItem[];
    /** Defaults to "© {year} <site title>"; {year} becomes the current year. */
    copyright?: string | null;
    social?: { network: SocialNetwork; url: string }[];
}

export interface Appearance {
    /** The color scheme before a reader chooses one. Defaults to the reader's system setting. */
    colorScheme?: 'system' | 'light' | 'dark';
    /** Where the brand in the header links. Defaults to the blog's front page. */
    brandUrl?: string | null;
    /** Show the site title next to the logo image. */
    logoText?: boolean;
    /** The logo is a light mark drawn for dark backgrounds: invert it in the light scheme. */
    invertLogoInLight?: boolean;
    /**
     * A backdrop behind the header and the top of every page: an image (with an
     * optional one for phones) and twinkling sparkles. In the light scheme it is
     * inverted, so a night sky becomes dark specks on white.
     */
    backdrop?: { image?: string | null; mobileImage?: string | null; sparkles?: boolean } | null;
    /**
     * The front page's masthead: `title` big after the logo (a title starting with the
     * site title sets the rest lighter, e.g. "pre.dev blog") and `text` as a tagline under
     * it (none when blank). Without a title the newest post leads the page.
     */
    hero?: { title?: string | null; text?: string | null } | null;
    /** A button at the end of the header, e.g. "Sign in" to your product. */
    headerCta?: {
        label: string;
        url: string;
        /** Swaps the button for signed-in readers, detected by a cookie your product sets on the same domain. */
        signedIn?: { cookie: string; label: string; url: string } | null;
    } | null;
    /** Heading and text of the newsletter signup band. */
    subscribe?: { title?: string | null; text?: string | null } | null;
}

export interface SiteSettings {
    /** Public URL of the blog, including any subdirectory, e.g. https://example.com/blog/ */
    url: string;
    title: string;
    description: string;
    /** Title and description for the blog's front page, when they differ from the above. */
    metaTitle?: string | null;
    metaDescription?: string | null;
    /** Share-card title and description for the front page. */
    ogTitle?: string | null;
    ogDescription?: string | null;
    locale: string;
    logo?: string | null;
    /** Filled in by the server: the logo's size in pixels, so pages can reserve its space. */
    logoSize?: { width: number; height: number } | null;
    icon?: string | null;
    /** Default share image for pages without their own. */
    shareImage?: string | null;
    /** Brand color for links and buttons, e.g. "#0f62fe". */
    accentColor?: string | null;
    twitter?: string | null;
    navigation?: NavigationItem[];
    footer?: FooterSettings | null;
    appearance?: Appearance | null;
    /** The organization that publishes the blog; defaults to the site origin. */
    publisher?: { name: string; url: string; logo?: string | null; sameAs?: string[] };
}

/** A complete, portable copy of a publication. Importers produce it; builds read it. */
export interface Snapshot {
    format: 'masthead.snapshot/1';
    exportedAt: string;
    /** Free-form description of where the snapshot came from, e.g. "ghost 6.65". */
    source: string;
    site: SiteSettings;
    posts: Post[];
    authors: Author[];
    tags: Tag[];
    /** Sign-in accounts for authors and admins. Present when exported from an admin API. */
    staff?: StaffRecord[];
    /** Known image sizes by URL path (e.g. /blog/content/images/x.png), for layout and share cards. */
    imageSizes?: Record<string, { width: number; height: number }>;
    newsletter?: NewsletterSettings;
}

// ------------------------------------------------------------------ audience

export interface MemberRecord {
    email: string;
    name?: string | null;
    status: 'pending' | 'subscribed' | 'unsubscribed';
    /** Set when the address bounced or marked mail as spam: never email it. */
    suppressed?: 'bounced' | 'complained' | null;
    labels: string[];
    note?: string | null;
    createdAt: string;
    emailCount?: number;
    openedCount?: number;
    /** Ids from the platform the member came from; keeps its old unsubscribe links working. */
    externalId?: string | null;
    externalUuid?: string | null;
    /** Review flags, e.g. "resubscribed-after-opt-out". */
    flags?: string[];
}

export interface MemberEventRecord {
    email: string;
    type: 'subscribed' | 'unsubscribed';
    /** Who made the change: the member, an admin, an API integration, or an import. */
    source: 'member' | 'admin' | 'api' | 'import' | 'provider';
    at: string;
}

/** Newsletter subscribers and their history. Personal data: never commit it. */
export interface AudienceExport {
    format: 'masthead.audience/1';
    exportedAt: string;
    source: string;
    members: MemberRecord[];
    events: MemberEventRecord[];
}

// ------------------------------------------------------------------ AI models

export type ModelKind = 'text' | 'image' | 'video' | 'embedding';

export interface ModelInfo {
    id: string;
    name: string;
    kind: ModelKind;
    contextLength?: number;
    /** Provider-specific prices, e.g. credits per million tokens or per image. */
    price?: Record<string, number>;
    /**
     * What a media model accepts, where the catalog says. `streaming`: an image model that sends
     * previews while it paints. `references`: an image model that takes images to edit or draw
     * from (false when the catalog says it takes none). `audio`: a video model that also makes sound.
     */
    supports?: { durations?: number[]; aspectRatios?: string[]; resolutions?: string[]; frameImages?: string[]; streaming?: boolean; references?: boolean; audio?: boolean };
    /** When the provider released it (ISO 8601), for newest-first lists. */
    released?: string;
    /** A public benchmark score, where the catalog has one: higher is more capable. Compare within one kind only. */
    score?: number;
    /** An alias such as "...-latest" names the model it stands for today. */
    aliasOf?: { id: string; name: string };
    /** The day the provider retires the model (YYYY-MM-DD), once announced. */
    retires?: string;
    /** The site's default model for this kind. */
    isDefault?: boolean;
}

export interface TextMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface TextRequest {
    model?: string;
    system?: string;
    messages: TextMessage[];
    /** Ask the model for a single JSON object. */
    json?: boolean;
    maxTokens?: number;
    temperature?: number;
    /** Ends the call early, e.g. when the person who asked for it goes away. */
    signal?: AbortSignal;
}

/** How a text stream ended: the value its async generator returns. */
export interface StreamEnd {
    model: string;
    usage: Usage;
    /** "stop" when the model finished, "length" when it ran out of room. */
    finishReason?: string;
}

export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    /** What the call cost, in the provider's billing unit. */
    charged?: number;
    remaining?: number | null;
    requestId?: string;
}

export interface TextResult {
    text: string;
    model: string;
    usage: Usage;
}

export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3';

export interface ImageRequest {
    model?: string;
    prompt: string;
    aspectRatio?: AspectRatio;
    /** Images to edit or draw from: URLs or data: URLs. */
    references?: string[];
    signal?: AbortSignal;
    /** Called with rough versions of the image as it forms, on models whose catalog says `supports.streaming`. */
    onPreview?: (preview: { dataUrl: string; index: number }) => void;
}

export interface VideoRequest {
    model?: string;
    prompt: string;
    aspectRatio?: string;
    /** Seconds, when the model lets you choose. */
    duration?: number;
    /** Stills to draw from: URLs or data: URLs. */
    references?: string[];
    /** A still the clip starts from (a URL or data: URL), on models that take a first frame. */
    firstFrame?: string;
}

export interface VideoJob {
    id: string;
    status: 'queued' | 'running' | 'completed' | 'failed';
    error?: string;
}

export interface EmbeddingResult {
    vectors: number[][];
    model: string;
    usage: Usage;
}

export interface ImageResult {
    bytes: Uint8Array;
    mimeType: string;
    model: string;
    usage: Usage;
}

/** One connector serves model listing, text and images. */
export interface AIProvider {
    id: string;
    listModels(kind?: ModelKind): Promise<ModelInfo[]>;
    text(request: TextRequest): Promise<TextResult>;
    image(request: ImageRequest): Promise<ImageResult>;
    /**
     * The same as text, token by token. Written as an async generator it can
     * return a StreamEnd, which is how callers learn the model and token counts.
     */
    stream?(request: TextRequest): AsyncIterable<string>;
    /**
     * What an earlier call was charged, by the requestId in its usage. A
     * stream's charge settles after it ends: null until the provider knows it.
     */
    usage?(requestId: string, signal?: AbortSignal): Promise<Usage | null>;
    embed?(input: string[], model?: string): Promise<EmbeddingResult>;
    /** Video is asynchronous: submit, poll, then fetch the file. */
    video?: {
        submit(request: VideoRequest): Promise<VideoJob>;
        status(id: string): Promise<VideoJob>;
        content(id: string): Promise<Uint8Array>;
    };
}

// ------------------------------------------------------------------ studio

/** A piece of new material from a source: a merged PR, a task, a project. */
export interface Signal {
    /** Stable reference, namespaced by source: "github:owner/repo#123". */
    ref: string;
    source: string;
    kind: string;
    title: string;
    summary: string;
    at: string;
    url?: string;
    tags?: string[];
    metrics?: Record<string, number>;
}

/** Everything a draft may cite about one signal. Policies redact it before any model sees it. */
export interface Evidence {
    ref: string;
    title: string;
    body: string;
    fields?: Record<string, unknown>;
    attachments?: { name: string; url: string; mimeType?: string }[];
}

export interface Source {
    id: string;
    pull(since: Date): AsyncIterable<Signal>;
    expand(ref: string): Promise<Evidence>;
}

export interface Issue {
    severity: 'block' | 'warn';
    message: string;
    /** Character range in the draft body, when the issue points at text. */
    range?: [number, number];
}

export interface Draft {
    title: string;
    body: string;
    citations: string[];
}

/**
 * Rules that run between sources and models. They are the place for house
 * rules, so none of them has to live in connector code.
 */
export interface Policy {
    id: string;
    admit?(signal: Signal): boolean;
    redact?(evidence: Evidence): Evidence;
    review?(draft: Draft): Issue[];
}

// ------------------------------------------------------------------ channels and infrastructure

export interface OutputFile {
    /** Path relative to the site root, e.g. "blog/my-post/index.html". */
    path: string;
    contents: string | Uint8Array;
    contentType: string;
}

/** Where the rendered site goes: a folder, a bucket, a git branch. */
export interface WebTarget {
    id: string;
    write(files: OutputFile[]): Promise<void>;
    remove?(paths: string[]): Promise<void>;
}

export interface EmailMessage {
    to: string;
    from: string;
    replyTo?: string;
    subject: string;
    html: string;
    text: string;
    headers?: Record<string, string>;
    /** Stable per recipient and send, so a retried batch never delivers twice. */
    idempotencyKey: string;
}

export interface SendResult {
    idempotencyKey: string;
    ok: boolean;
    providerId?: string;
    error?: string;
}

export interface EmailEvent {
    type: 'delivered' | 'bounced' | 'complained' | 'opened' | 'clicked';
    email: string;
    at: string;
    providerId?: string;
    /** For a click, the link that was clicked. */
    url?: string;
}

/** Moves bytes. Lists, consent, tokens and retries belong to the core. */
export interface EmailTransport {
    id: string;
    send(batch: EmailMessage[]): Promise<SendResult[]>;
    events?(request: Request): Promise<EmailEvent[]>;
}

export interface Assets {
    id: string;
    put(key: string, body: Uint8Array, contentType: string): Promise<string>;
}

export interface User {
    id: string;
    email: string;
    name?: string;
    role: 'owner' | 'editor' | 'author';
}

export interface Auth {
    id: string;
    user(request: Request): Promise<User | null>;
}

// ------------------------------------------------------------------ themes

export interface PageMeta {
    title: string;
    description: string;
    canonical: string;
    /** Extra tags for <head>: share cards, structured data, feeds. */
    head: string;
}

export interface ListItem {
    post: Post;
    url: string;
    excerpt: string;
    readingMinutes: number;
    authors: Author[];
    primaryTag?: Tag;
    /** Every public tag on the post, primary first. */
    tags?: Tag[];
}

export interface ThemeContext {
    site: SiteSettings;
    basePath: string;
    cssHref: string;
    rssHref: string;
    /** Where the theme's own files (from Theme.assets) are served, ending in "/". */
    assetsHref: string;
    /** Append as ?v= to theme file URLs; it changes whenever they do. */
    assetsVersion: string;
    /** The search page, which also works without JavaScript. */
    searchHref: string;
    /** The search index: a JSON array of SearchEntry. */
    searchIndexHref: string;
    /** Where the newsletter signup form posts. Absent when the site has no newsletter. */
    subscribeUrl?: string;
    /** Public tags that have posts, most used first. */
    topics?: { name: string; url: string; slug: string; count: number }[];
    /** Product analytics the theme loads, when configured. */
    analytics?: AnalyticsConfig;
}

/** Analytics the published pages load (PostHog), set from the server's environment. */
export interface AnalyticsConfig {
    posthog?: {
        /** The project's public API key (phc_...). */
        key: string;
        /** Where events go: https://us.i.posthog.com, https://eu.i.posthog.com, or your own proxy. */
        host: string;
        /** Pages served on this host count as production; any other host is a preview. */
        canonicalHost: string;
        /** The blog's path on that host, e.g. "/blog/". The site at another path (PREVIEW_PATH) is a preview too. */
        canonicalPath?: string;
        /** Track previews too, tagged environment=preview. Off by default. */
        trackPreview?: boolean;
    };
}

/** One post in the search index. */
export interface SearchEntry {
    title: string;
    url: string;
    excerpt: string;
    tags: string[];
    authors: string[];
    date: string | null;
    image: string | null;
    /** The start of the post's text, for matching. */
    text: string;
}

export interface PostView {
    post: Post;
    url: string;
    html: string;
    excerpt: string;
    readingMinutes: number;
    authors: (Author & { url: string })[];
    tags: (Tag & { url: string })[];
    related: ListItem[];
    /** The feature image's real size, when known. */
    featureImageSize?: { width: number; height: number };
}

export interface ListView {
    kind: 'index' | 'tag' | 'author';
    heading: string;
    description?: string | null;
    items: ListItem[];
    page: number;
    pages: number;
    prevUrl?: string;
    nextUrl?: string;
    author?: Author;
    tag?: Tag;
    /** On the front page: the most-read posts, by newsletter opens. */
    highlights?: ListItem[];
}

/** A theme turns views into HTML. It never fetches anything. */
export interface Theme {
    name: string;
    css: string;
    /** Extra files served from ThemeContext.assetsHref, e.g. a small script. Paths are relative to it. */
    assets?: OutputFile[];
    document(ctx: ThemeContext, meta: PageMeta, main: string): string;
    post(ctx: ThemeContext, view: PostView): string;
    list(ctx: ThemeContext, view: ListView): string;
    notFound(ctx: ThemeContext): string;
    /** A short page such as "Check your email" after signing up. */
    message?(ctx: ThemeContext, view: { title: string; html: string }): string;
    /** Search results, rendered on the server for readers without JavaScript. */
    search?(ctx: ThemeContext, view: { query: string; results: SearchEntry[] }): string;
}
