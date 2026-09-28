# Deploy

Masthead is one Cloudflare Worker with a D1 database, an R2 bucket and a cron trigger. This page takes you from a clone to a live blog, then onto your own domain.

You need:

- A Cloudflare account on the **Workers Paid** plan ($5 a month). The Free plan allows 10 ms of CPU per request, which is too little for publishing and sending.
- [Bun](https://bun.sh) and Node.js 22 or newer on your machine.
- Optional: a [Resend](https://resend.com) account for email, a [pre.dev](https://pre.dev) API key for AI, a [PostHog](https://posthog.com) project for traffic analytics.

## 1. Create the database and the bucket

```bash
git clone https://github.com/predotdev/masthead && cd masthead
bun install
cd apps/worker
bunx wrangler login
bunx wrangler d1 create masthead
bunx wrangler r2 bucket create masthead
cp wrangler.example.toml wrangler.toml
```

`wrangler d1 create` prints a `database_id`. In `wrangler.toml`:

- paste it as `database_id`,
- set `SITE_URL` to the blog's address, including its path: `https://example.com/blog/`. Without a domain yet, use the workers.dev address, `https://masthead.<your-subdomain>.workers.dev/blog/`,
- set `EMAIL_FROM` to the sender you will use, and leave `EMAIL_TEST_MODE = "true"` for now.

`wrangler.toml` names your account's resources, so git ignores it. Keep it, with your settings, in a private repository if you want it versioned.

## 2. Secrets and the first deploy

```bash
printf 'SECRET=%s\nBOOTSTRAP_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env.production
bun run --cwd ../.. build
bunx wrangler deploy --secrets-file .env.production
```

`.env.production` is ignored by git. `SECRET` signs subscriber links, so never change it casually: links in emails already sent would stop working. `BOOTSTRAP_TOKEN` is the owner token; store it in your password manager.

Open `<SITE_URL>admin/`, choose **Use the owner token**, and give your name and email. That creates the owner account and signs you in. From then on, `bun run deploy` from the repository root rebuilds the admin and deploys; secrets stay in place, and the database migrates itself on the first request after an update.

## 3. Email

1. Verify your sending domain in Resend, and set `EMAIL_FROM` (for example `Acme <news@acme.example>`) and `POSTAL_ADDRESS` in `wrangler.toml`.
2. `bunx wrangler secret put RESEND_API_KEY`
3. In Resend, add a webhook to `<SITE_URL>api/webhooks/email` for delivery, open, click, bounce and complaint events, then `bunx wrangler secret put RESEND_WEBHOOK_SECRET` with its signing secret.

While `EMAIL_TEST_MODE` is `"true"`, newsletters reach only your team: staff plus anyone matching `EMAIL_TEST_ALLOW` (for example `@acme.example`). Sign-in links and invites always work.

Then check the whole deployment. The smoke test reads pages, feeds and media, signs in, writes, schedules and publishes a post, signs up and confirms a subscriber, sends a test-mode newsletter to that one throwaway address, unsubscribes it with one click, and removes everything it created:

```bash
MASTHEAD_TOKEN=<owner token> bun scripts/smoke.ts --server <SITE_URL>
```

It is written for a working blog: on an empty one, the import and link-tagging checks fail until you have imported content and set `LINK_TAG`.

## 4. AI

`bunx wrangler secret put PREDEV_API_KEY` turns on drafting, editing, the assistant, covers, video, auto tags and ideas. Choose default models in Settings, AI (or with `TEXT_MODEL`, `IMAGE_MODEL`, `VIDEO_MODEL`), and set `EMBEDDING_MODEL` so the AI can search your posts and the knowledge sources you add. To use another provider, implement `AIProvider` from `@masthead/core` and pass it in `apps/worker/src/index.ts`.

## 5. Images

Uncomment `[images]` in `wrangler.toml` to bind Cloudflare Images. Uploads then get resized WebP copies for `srcset`, and older images get them on first request.

## 6. Your domain

Pick one:

- **A whole host**, such as `blog.example.com`, on a zone in your Cloudflare account. Cloudflare creates the DNS record and certificate. The blog can sit at the root (`SITE_URL = "https://blog.example.com/"`) or keep a path:

  ```toml
  [[routes]]
  pattern = "blog.example.com"
  custom_domain = true
  ```

- **A path on your existing site**, such as `example.com/blog`, when `example.com` is proxied by Cloudflare. The rest of the site keeps working as before:

  ```toml
  [[routes]]
  pattern = "example.com/blog*"
  zone_name = "example.com"
  ```

- **Behind your own proxy**, such as another Worker with a service binding, nginx or your app server: forward `/blog/*` to the Worker and pass your host in `x-forwarded-host` (or keep it in the request). Canonical URLs, feeds and `noindex` follow `SITE_URL`.

  If a Worker answers your whole domain and its DNS record points at a placeholder (such as `192.0.2.1`), add `compatibility_flags = ["global_fetch_strictly_public"]` to the blog's `wrangler.toml`. Without it, Cloudflare sends the blog's requests for other pages on your domain (your logo on a share card, a link preview, a knowledge source) straight to that placeholder, and they hang until they time out.

Set `SITE_URL` to the final address. If the Worker is also reached at another address during testing, set `APP_URL` to it so sign-in links point there.

## 7. Switch traffic

When the blog is ready:

1. Turn `EMAIL_TEST_MODE` off (and remove `EMAIL_TEST_ALLOW`), set `INDEXNOW = "true"`, and deploy.
2. Point the domain or path at the Worker (step 6).
3. Moving from Ghost? Run `push` once more to pick up anything new since the import, then follow the checklist in [ghost.md](ghost.md#switch-traffic).
4. Add `<SITE_URL>sitemap.xml` to your `robots.txt` and to Google Search Console.

## Analytics

Set `POSTHOG_KEY` (and `POSTHOG_HOST` for the EU cloud or a proxy) to load PostHog on every page after it settles and record signups on the server. For traffic in the admin's Analytics page, add a personal API key with query read access: `bunx wrangler secret put POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID = "<id>"`. Newsletter and growth numbers work without PostHog.

## Health checks

For uptime monitors, `GET <blog>/api/health` answers `200` while everything passes or only warns and `503` when a check fails. It is never cached, costs a few small reads, and shows only times, counts and short reasons:

```json
{ "status": "pass", "checks": { "database": { "status": "pass", "schemaVersion": 7 }, "storage": { "status": "pass" }, "cron": { "status": "pass", "lastRunAt": "…" }, "…": {} } }
```

| Check | Warns | Fails |
|---|---|---|
| `database`, `storage` | migrations pending | no answer, or the front page is missing from storage |
| `publish` | never published | a publish started 15 minutes ago and never finished |
| `cron` | last run 3 minutes ago | last run 10 minutes ago (scheduled posts and newsletters wait for it) |
| `newsletter` | | a send has made no progress for 15 minutes; `pendingBatches` counts what is left |
| `knowledge` | a passage has waited 3 hours for the AI to read it | |
| `backup` | none yet, or the last is 26 hours old | the last is 50 hours old (two missed nights) |

## Backups

Two layers, for two kinds of trouble.

**A mistake from the last 30 days: D1 Time Travel.** Cloudflare keeps every minute of the database for 30 days (7 on the free plan), and rolling back is one command. It replaces the database in place, so note the current bookmark first; restoring to it undoes the rollback.

```bash
bunx wrangler d1 time-travel info masthead                                        # the bookmark for now
bunx wrangler d1 time-travel restore masthead --timestamp=2026-09-28T09:00:00Z   # the database as it was then
```

**Anything older, or a database that is gone: the nightly export.** Every night at 02:30 UTC the Worker writes every table to R2 in pages, as gzipped JSON lines (`backups/YYYY-MM-DD/<table>.jsonl.gz`), then a `manifest.json` with each table's row count and the schema version. The manifest is written last, so a folder with one is complete. The newest 30 copies are kept, and the first copy of each month for a year. A night the Worker missed runs at the next cron minute, and a failed one is tried again every 15 minutes, four attempts in all; Settings, Backups shows the last copy (and any failure) and has **Back up now**. Media (images, video) lives in the same bucket and is not part of the export. Backups hold your members' data: keep the bucket private (no r2.dev URL or custom domain). The Worker serves only the site and media from it, and backup files only to the owner.

```bash
export MASTHEAD_TOKEN=<BOOTSTRAP_TOKEN>
bun run masthead backup --server https://<worker>/blog/ --list                  # the copies kept
bun run masthead backup --server https://<worker>/blog/ --out backups/          # back up now and keep a copy off Cloudflare
```

`--out` reads every downloaded file back and checks its row count against the manifest. To restore, create a new D1 database, point the Worker's `database_id` at it and deploy, then, before anyone signs in:

```bash
bun run masthead restore --server https://<worker>/blog/ --from 2026-09-28          # a copy in the bucket
bun run masthead restore --server https://<worker>/blog/ --from backups/2026-09-28  # or one saved with --out
```

Restore works only on an empty database (settings aside) and resumes where it stopped if you run it again. While it runs, the cron stays still; a newsletter that was going out when the backup was made comes back cancelled, never sent again. It then rebuilds the site and the AI's search index from the restored rows, removes pages the backup doesn't have, and compares every table's row count with the manifest. A backup from an older version restores into a newer one: the migrations' data changes run on its rows.
