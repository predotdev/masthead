import type { AIProvider, EmailTransport, StaffRole, Theme } from '@masthead/core';

/** Worker bindings, variables and secrets. */
export interface Env {
    DB: D1Database;
    BUCKET: R2Bucket;
    /** The admin app's static files. */
    ASSETS?: Fetcher;
    /** Canonical public URL of the blog, e.g. https://example.com/blog/ */
    SITE_URL: string;
    /**
     * Where this server is reachable when that differs from SITE_URL, for
     * example on a preview host before switching traffic. Links in emails and
     * the admin use it. Same path as SITE_URL.
     */
    APP_URL?: string;
    /** Signs login, unsubscribe and confirmation links. Long and random. */
    SECRET: string;
    /** Owner access for the first sign-in and for the CLI. Long and random. */
    BOOTSTRAP_TOKEN?: string;
    EMAIL_FROM?: string;
    EMAIL_REPLY_TO?: string;
    /** "true": newsletters and subscriber mail go only to EMAIL_TEST_ADDRESS. Staff sign-in mail is unaffected. */
    EMAIL_TEST_MODE?: string;
    EMAIL_TEST_ADDRESS?: string;
    POSTAL_ADDRESS?: string;
    RESEND_API_KEY?: string;
    RESEND_WEBHOOK_SECRET?: string;
    PREDEV_API_KEY?: string;
    TEXT_MODEL?: string;
    IMAGE_MODEL?: string;
    /** "param=value" added to outbound links in posts, e.g. "ref=example.com". */
    LINK_TAG?: string;
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
}
