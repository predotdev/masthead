import type { AIProvider, EmailTransport, StaffRole, Theme } from '@masthead/core';

/** Worker bindings, variables and secrets. */
export interface Env {
    DB: D1Database;
    BUCKET: R2Bucket;
    /** The admin app's static files. */
    ASSETS?: Fetcher;
    /** Cloudflare Images binding: makes resized copies of uploaded images for srcset. Optional. */
    IMAGES?: ImagesBinding;
    /** Canonical public URL of the blog, e.g. https://example.com/blog/ */
    SITE_URL: string;
    /**
     * Where this server is reachable when that differs from SITE_URL, for
     * example on a preview host before switching traffic. Links in emails and
     * the admin use it. Same path as SITE_URL.
     */
    APP_URL?: string;
    /**
     * A second path the whole site answers on, e.g. "/blog-new/" while an old blog still has
     * SITE_URL's path: links stay on it, canonical URLs keep naming SITE_URL, and it is noindex.
     * The admin stays on the main path.
     */
    PREVIEW_PATH?: string;
    /** Signs login, unsubscribe and confirmation links. Long and random. */
    SECRET: string;
    /** Owner access for the first sign-in and for the CLI. Long and random. */
    BOOTSTRAP_TOKEN?: string;
    EMAIL_FROM?: string;
    EMAIL_REPLY_TO?: string;
    /**
     * "true": test mode. Email reaches only the team: addresses in EMAIL_TEST_ALLOW,
     * staff, and the provider's test addresses (@resend.dev). Newsletters go only to
     * the team members of a segment; confirmations and test sends to anyone else are
     * not sent. Staff sign-in and invites are unaffected.
     */
    EMAIL_TEST_MODE?: string;
    /** Test mode's team: comma-separated addresses or @domains, e.g. "@example.com". */
    EMAIL_TEST_ALLOW?: string;
    /** Where anything that slips past the team check goes in test mode. Default delivered@resend.dev. */
    EMAIL_TEST_ADDRESS?: string;
    POSTAL_ADDRESS?: string;
    RESEND_API_KEY?: string;
    RESEND_WEBHOOK_SECRET?: string;
    PREDEV_API_KEY?: string;
    /**
     * Names post ideas never mention (customers, partners, vendors), newline or comma
     * separated; Settings, Ideas adds more. Set it as a secret to keep the list private.
     */
    DENYLIST?: string;
    TEXT_MODEL?: string;
    IMAGE_MODEL?: string;
    VIDEO_MODEL?: string;
    EMBEDDING_MODEL?: string;
    /** "param=value" added to outbound links in posts, e.g. "ref=example.com". */
    LINK_TAG?: string;
    /** PostHog project key (phc_...). Set it and pages load PostHog and the server records subscriptions. */
    POSTHOG_KEY?: string;
    /** PostHog host. Default https://us.i.posthog.com (EU: https://eu.i.posthog.com, or your own proxy). */
    POSTHOG_HOST?: string;
    /** "true": also track previews (hosts other than SITE_URL's), tagged environment=preview. */
    POSTHOG_TRACK_PREVIEW?: string;
    /** "true": tell search engines (IndexNow: Bing, Yandex and others) about changed pages on publish. Turn on once SITE_URL serves this blog. */
    INDEXNOW?: string;
    /** The IndexNow key (32 hex characters). Generated and kept in settings when not set. */
    INDEXNOW_KEY?: string;
    /** Admin stats read PostHog with a personal API key (query read access) for this project id. */
    POSTHOG_PERSONAL_API_KEY?: string;
    POSTHOG_PROJECT_ID?: string;
}

export interface Principal {
    staffId: string;
    email: string;
    name: string;
    role: StaffRole;
    via: 'session' | 'api-key' | 'bootstrap';
}

export interface AppOptions {
    theme: Theme;
    /** Build the AI provider from the environment. */
    ai?: (env: Env) => AIProvider | null;
    /** Build the email transport from the environment. */
    email?: (env: Env) => EmailTransport | null;
}

export interface Ctx {
    env: Env;
    db: D1Database;
    exec: ExecutionContext;
    options: AppOptions;
    url: URL;
    basePath: string;
    principal?: Principal;
    /**
     * Served at the canonical address (SITE_URL's host), directly or through a
     * proxy that passes it as x-forwarded-host. Other hosts are previews: noindex.
     */
    canonical?: boolean;
}
