/**
 * Schema and migrations. Each migration is a list of single statements run
 * as one D1 batch, so a migration applies completely or not at all.
 */
const MIGRATIONS: string[][] = [
    [
        `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        `CREATE TABLE staff (
            id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','author','contributor')),
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended')),
            bio TEXT, profile_image TEXT, website TEXT, twitter TEXT, linkedin TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT)`,
        `CREATE TABLE tags (
            id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
            visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','internal')),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE TABLE posts (
            id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'post' CHECK (type IN ('post','page')),
            slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published')),
            body_format TEXT NOT NULL DEFAULT 'markdown' CHECK (body_format IN ('markdown','html')),
            markdown TEXT, html TEXT, custom_excerpt TEXT,
            feature_image TEXT, feature_image_alt TEXT, feature_image_caption TEXT,
            meta_title TEXT, meta_description TEXT, og_title TEXT, og_description TEXT, og_image TEXT,
            twitter_title TEXT, twitter_description TEXT, twitter_image TEXT, canonical_url TEXT,
            featured INTEGER NOT NULL DEFAULT 0, newsletter TEXT,
            published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE INDEX posts_listing ON posts (type, status, published_at)`,
        `CREATE TABLE post_tags (post_id TEXT NOT NULL, tag_id TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (post_id, tag_id))`,
        `CREATE TABLE post_authors (post_id TEXT NOT NULL, staff_id TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (post_id, staff_id))`,
        `CREATE TABLE members (
            id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT,
            status TEXT NOT NULL CHECK (status IN ('pending','subscribed','unsubscribed')),
            status_source TEXT NOT NULL DEFAULT 'import',
            suppressed TEXT CHECK (suppressed IN ('bounced','complained')),
            labels TEXT NOT NULL DEFAULT '[]', flags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, note TEXT,
            external_id TEXT, external_uuid TEXT,
            email_count INTEGER NOT NULL DEFAULT 0, opened_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_emailed_at TEXT)`,
        `CREATE INDEX members_status ON members (status, suppressed)`,
        `CREATE INDEX members_uuid ON members (external_uuid)`,
        `CREATE TABLE member_events (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL, data TEXT)`,
        `CREATE INDEX member_events_member ON member_events (member_id, at)`,
        `CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
        `CREATE TABLE login_tokens (token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)`,
        `CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_by TEXT, created_at TEXT NOT NULL, last_used_at TEXT)`,
        `CREATE TABLE sends (
            id TEXT PRIMARY KEY, post_id TEXT NOT NULL, subject TEXT NOT NULL, segment TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('queued','sending','sent','failed','cancelled')),
            total INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
            delivered INTEGER NOT NULL DEFAULT 0, opened INTEGER NOT NULL DEFAULT 0, clicked INTEGER NOT NULL DEFAULT 0,
            bounced INTEGER NOT NULL DEFAULT 0, complained INTEGER NOT NULL DEFAULT 0,
            test_mode INTEGER NOT NULL DEFAULT 0, error TEXT, created_by TEXT,
            created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)`,
        `CREATE TABLE send_recipients (
            send_id TEXT NOT NULL, member_id TEXT NOT NULL, email TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
            provider_id TEXT, error TEXT, updated_at TEXT, PRIMARY KEY (send_id, member_id))`,
        `CREATE INDEX send_recipients_pending ON send_recipients (send_id, status)`,
        `CREATE INDEX send_recipients_provider ON send_recipients (provider_id)`,
        `CREATE TABLE email_events (id INTEGER PRIMARY KEY AUTOINCREMENT, send_id TEXT, member_id TEXT, type TEXT NOT NULL, provider_id TEXT, at TEXT NOT NULL)`,
        `CREATE TABLE media (key TEXT PRIMARY KEY, content_type TEXT, size INTEGER, source_url TEXT, created_at TEXT NOT NULL)`,
        `CREATE TABLE site_files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, content_type TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE TABLE ideas (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, angle TEXT, series TEXT, sources TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','drafted','dismissed')),
            score REAL, post_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
    ],
    // v2: one worker at a time per send (the cron and a manual "process now" can overlap).
    [`ALTER TABLE sends ADD COLUMN lease_until TEXT`],
    // v3: the members list is newest first.
    [`CREATE INDEX members_created ON members (created_at)`],
    // v4: what the editor's AI knows, and long-running AI jobs (video).
    [
        `CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, title TEXT NOT NULL, url TEXT, chunk TEXT NOT NULL, hash TEXT NOT NULL, vector TEXT, updated_at TEXT NOT NULL)`,
        `CREATE INDEX knowledge_source ON knowledge (source, hash)`,
        `CREATE INDEX knowledge_pending ON knowledge (id) WHERE vector IS NULL`,
        `CREATE TABLE ai_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, provider_id TEXT, status TEXT NOT NULL, prompt TEXT, model TEXT, url TEXT, error TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
    ]
];

let migrated: Promise<void> | null = null;

/** Applies pending migrations once per isolate. */
export function migrate(db: D1Database): Promise<void> {
    migrated ??= (async () => {
        await db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)').run();
        const { results } = await db.prepare('SELECT version FROM schema_migrations').all<{ version: number }>();
        const done = new Set(results.map(r => r.version));
        for (let i = 0; i < MIGRATIONS.length; i++) {
            const version = i + 1;
            if (done.has(version)) continue;
            await db.batch([
                ...MIGRATIONS[i].map(sql => db.prepare(sql.replace(/\s+/g, ' '))),
                db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').bind(version, new Date().toISOString())
            ]);
        }
    })().catch(err => {
        migrated = null;
        throw err;
    });
    return migrated;
}

/** Runs statements in D1 batches of a safe size. */
export async function batched(db: D1Database, statements: D1PreparedStatement[], size = 100): Promise<void> {
    for (let i = 0; i < statements.length; i += size) await db.batch(statements.slice(i, i + size));
}
