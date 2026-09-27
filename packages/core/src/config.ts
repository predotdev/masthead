import type { AIProvider, Assets, Auth, EmailTransport, Policy, SiteSettings, Snapshot, Source, Theme, WebTarget } from './types';

export interface RenderOptions {
    /** Posts per listing page. Ghost's default theme uses 25. */
    postsPerPage?: number;
    /**
     * Add a query parameter to outbound links in post bodies, e.g.
     * { param: 'ref', value: 'example.com' }, so the sites you link to (and
     * your own analytics) can see where the visit came from.
     */
    linkTag?: { param: string; value: string };
}

/** Anything that can produce a Snapshot: a file, an importer, a database. */
export interface ContentSource {
    id: string;
    load(): Promise<Snapshot>;
}

export interface MastheadConfig {
    /** Overrides applied on top of the imported site settings. */
    site?: Partial<SiteSettings>;
    content?: ContentSource;
    output?: WebTarget;
    theme?: Theme;
    render?: RenderOptions;
    ai?: AIProvider;
    email?: EmailTransport;
    assets?: Assets;
    auth?: Auth;
    sources?: Source[];
    policies?: Policy[];
}

export function defineConfig(config: MastheadConfig): MastheadConfig {
    return config;
}

/** Reads a required environment variable with a message that says where to set it. */
export function env(name: string): string {
    const value = (globalThis as any).process?.env?.[name];
    if (!value) throw new Error(`${name} is not set. Add it to your environment or .env file.`);
    return value;
}
