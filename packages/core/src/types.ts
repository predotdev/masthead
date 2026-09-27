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
    /** Stats from when the post went out as a newsletter, if it did. */
    newsletter?: { sentAt: string | null; recipients: number; delivered: number; opened: number } | null;
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
    icon?: string | null;
    /** Default share image for pages without their own. */
    shareImage?: string | null;
    /** Brand color for links and buttons, e.g. "#0f62fe". */
    accentColor?: string | null;
    twitter?: string | null;
    navigation?: NavigationItem[];
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
}

export interface ThemeContext {
    site: SiteSettings;
    basePath: string;
    cssHref: string;
    rssHref: string;
    /** Where the newsletter signup form posts. Absent when the site has no newsletter. */
    subscribeUrl?: string;
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
}

/** A theme turns views into HTML. It never fetches anything. */
export interface Theme {
    name: string;
    css: string;
    document(ctx: ThemeContext, meta: PageMeta, main: string): string;
    post(ctx: ThemeContext, view: PostView): string;
    list(ctx: ThemeContext, view: ListView): string;
    notFound(ctx: ThemeContext): string;
}
