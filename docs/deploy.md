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

Set `SITE_URL` to the final address. If the Worker is also reached at another address during testing, set `APP_URL` to it so sign-in links point there.

## 7. Switch traffic

When the blog is ready:

1. Turn `EMAIL_TEST_MODE` off (and remove `EMAIL_TEST_ALLOW`), set `INDEXNOW = "true"`, and deploy.
2. Point the domain or path at the Worker (step 6).
3. Moving from Ghost? Run `push` once more to pick up anything new since the import, then follow the checklist in [ghost.md](ghost.md#switch-traffic).
4. Add `<SITE_URL>sitemap.xml` to your `robots.txt` and to Google Search Console.

## Analytics

Set `POSTHOG_KEY` (and `POSTHOG_HOST` for the EU cloud or a proxy) to load PostHog on every page after it settles and record signups on the server. For traffic in the admin's Analytics page, add a personal API key with query read access: `bunx wrangler secret put POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID = "<id>"`. Newsletter and growth numbers work without PostHog.

## Backups

D1 and R2 are durable, and D1 keeps 30 days of point-in-time history ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)). For a copy of your own:

```bash
bunx wrangler d1 export masthead --remote --output masthead.sql
```

The published site can always be rebuilt from D1 with one click (Settings) or `POST <SITE_URL>admin/api/publish`; media lives only in R2.
