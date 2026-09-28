# Masthead

An open-source blog and newsletter with an AI writing studio, built to replace Ghost.

Readers get static pages with no JavaScript, served from the edge. Writers get Markdown, a fast editor that stays out of the way, and a studio that proposes and drafts posts from your own sources. Subscribers get double opt-in, one-click unsubscribe and a history that is never overwritten. Everything outside the core (models, storage, email, where ideas come from) is a small connector you can swap.

## What you get

- **Fast for readers, at any size.** A post page is about 10 KB compressed plus one 5 KB script (search, theme toggle); analytics load only after the page settles. Pages are rendered at publish time and served from storage, revalidated with ETags and Last-Modified. One Worker sustained 3,200 requests a second in a load test with no errors, and publishing streams: 10,000 posts publish in about 6 seconds within 30 MB of memory (`bun scripts/bench-build.ts <snapshot> 1000 10000` measures yours).
- **Found by search and by AI.** Canonical links, share cards with real image sizes, BlogPosting and breadcrumb structured data with author profiles, image sitemaps, a full-content RSS feed, `llms.txt` and `llms-full.txt`, a Markdown copy of every post, section anchors on every heading, IndexNow pings on publish, responsive images, and redirects for the address shapes Ghost used.
- **A newsletter you can trust with a list.** Recipients are frozen when a send is queued, batches carry idempotency keys, one worker at a time holds a send, every email has RFC 8058 one-click unsubscribe, and adding an existing person (a product signup, an import) never re-subscribes someone who opted out.
- **A theme that looks like your product.** Header menu with described dropdowns, a footer with columns, legal links and social icons, search (⌘K or /, and a no-JavaScript search page), light and dark with a remembered toggle, and an optional night-sky backdrop with twinkling sparkles. All of it is settings, editable in the admin or applied from a file with `masthead settings`.
- **An editor that writes with you.** Blocks (images, video, embeds, link cards, callouts, buttons, tables, raw HTML kept byte for byte), a slash menu, paste or drop media, autosave, scheduling and version history. AI rewrites a selection or writes at the cursor, grounded in your posts and knowledge sources (docs, `llms.txt`, a changelog) and in team memory, and cites what it used; an assistant panel sees the whole post. Generate or edit images and short videos in place. A search and AI readiness checklist and the link card people will see sit next to the post.
- **Analytics that join up with your product.** Newsletters and growth come from Masthead's own records, so they work from day one: opens, clicks, unsubscribes and the links people clicked for every send (and the numbers Ghost kept for older ones), subscribers over time, and where each signup came from (the post, the spot on the page, and whether the reader arrived from search, an AI assistant, social, email or your product). With PostHog connected, the same page adds visitors, sources, countries, devices, campaigns, read-through, clicks into your product and product signups after reading, all compared with the period before; every post has its own page too. PostHog is asked at most every ten minutes per view, and only production pages count.
- **A studio that reads only what you allow.** Sources (repositories, a changelog, product data) turn into post ideas grounded in real work; a denylist policy keeps private names out of every signal and draft; anyone on the team drafts an idea with one click.
- **One key for AI.** The pre.dev connector lists hundreds of text, image, video and embedding models and calls any of them with a single pre.dev API key.
- **Easy to leave Ghost.** Posts, pages, drafts, tags, staff with roles, newsletter settings, members with their full subscription history, and every image come across with their URLs intact, and old Ghost unsubscribe links keep working.

## Run it on Cloudflare

The server is one Worker with D1 (the database), R2 (pages and media) and a cron trigger. Everything lives under your blog's path, so putting it on an existing site is one route.

```bash
bun install
bun run --cwd packages/admin build

cd apps/worker
cp wrangler.example.toml wrangler.toml          # fill in ids; keep this file out of git
npx wrangler d1 create masthead
npx wrangler r2 bucket create masthead
npx wrangler deploy
npx wrangler secret put SECRET                  # 32+ random characters: signs member links
npx wrangler secret put BOOTSTRAP_TOKEN         # 32+ random characters: first sign-in and the CLI
npx wrangler secret put RESEND_API_KEY          # email
npx wrangler secret put PREDEV_API_KEY          # AI drafting, editing and images
```

Everything else is configuration; see [Configuration](#configuration).

Keep `EMAIL_TEST_MODE = "true"` until you switch traffic: every newsletter and member email then goes to the provider's test inbox. Pages served from any host other than `SITE_URL` answer with `noindex`, so a staging copy never competes with your live site.

| Path under the blog | What it serves |
|---|---|
| `/` and every page | the published site, from R2 (and Cloudflare's edge cache on a custom domain) |
| `content/…` | images and media, with range requests |
| `api/…` | subscribe, confirm, unsubscribe, delivery webhooks |
| `admin/` | the admin app; `admin/api/…` is its API |

## Configuration

All of it comes from the Worker's environment: `[vars]` in `wrangler.toml` for plain values, `wrangler secret put` for secrets. Site settings (title, menu, footer, look, house style, AI knowledge sources) are edited in the admin or applied from a file with `masthead settings`.

| Name | Kind | What it does |
|---|---|---|
| `SITE_URL` | var | Canonical address of the blog, e.g. `https://example.com/blog/`. Only this host (directly, or through a proxy passing it as `x-forwarded-host`) is indexable. |
| `APP_URL` | var | Where this Worker is reachable when that differs from `SITE_URL` (a preview host); used in email and admin links. |
| `PREVIEW_PATH` | var | A second path the whole site answers on, e.g. `/blog-new/`, to try Masthead on your real domain while an old blog still has `SITE_URL`'s path. Links stay on it, canonical URLs keep naming `SITE_URL`, pages are `noindex`, and the admin stays on the main path. |
| `SECRET` | secret | Signs member links. Long and random; never rotate casually (old unsubscribe links stop working). |
| `BOOTSTRAP_TOKEN` | secret | Owner access for the first sign-in and the CLI. |
| `EMAIL_FROM`, `EMAIL_REPLY_TO`, `POSTAL_ADDRESS` | var | Newsletter sender, reply address, and the postal address US law requires in the footer. |
| `EMAIL_TEST_MODE`, `EMAIL_TEST_ADDRESS` | var | `"true"`: newsletters go only to the test address (sign-in and confirmation mail still reach people). |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | secret | Sending, and delivery/open/click events from Resend. |
| `PREDEV_API_KEY` | secret | AI: text, images, video and embeddings through one key. |
| `TEXT_MODEL`, `IMAGE_MODEL`, `VIDEO_MODEL`, `EMBEDDING_MODEL` | var | Default models (editable in Settings). The embedding model lets the AI search your posts and knowledge sources. |
| `LINK_TAG` | var | `param=value` added to outbound links in posts, e.g. `ref=example.com`. |
| `POSTHOG_KEY`, `POSTHOG_HOST` | var | Analytics: the project key (public) and host (default `https://us.i.posthog.com`). |
| `POSTHOG_TRACK_PREVIEW` | var | `"true"`: also track previews (other hosts, and the site at `PREVIEW_PATH`), tagged `environment=preview`. |
| `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` | secret, var | Traffic in the admin's Analytics: a personal API key with query read access to that project. Newsletter and growth numbers need neither. |
| `POSTHOG_API_HOST` | var | Where those queries go, when `POSTHOG_HOST` is a proxy (default: its app host, `https://us.posthog.com`). |
| `POSTHOG_SIGNUP_EVENT` | var | Your product's signup event, for "signups after reading" (it carries the `blog_ref_post_slug` the blog registers). Default `auth_signup_success`. |
| `INDEXNOW`, `INDEXNOW_KEY` | var | `"true"`: ping IndexNow with changed pages on publish (turn on once `SITE_URL` serves this blog). The key is generated when unset. |
| `DB`, `BUCKET`, `ASSETS` | binding | D1 database, R2 bucket, the admin's static files. |
| `IMAGES` | binding | Optional Cloudflare Images binding: WebP copies of new images at srcset widths. |

## Switch traffic

When the blog is ready, point its path at the Worker: a Worker route for `example.com/blog*`, or a proxy (another Worker via a service binding, or any reverse proxy) that keeps your host in the request or passes it as `x-forwarded-host`. Then turn `EMAIL_TEST_MODE` off, `INDEXNOW` on, re-run `push` to pick up anything new, and point your email provider's webhook at `<blog>/api/webhooks/email`. The old system can stay wired as the fallback until you are sure.

## Move from Ghost

```bash
export GHOST_ADMIN_URL=https://your-site.ghost.io GHOST_ADMIN_API_KEY=<id>:<secret>
bun run masthead import ghost --out snapshot.json --members members.json   # members.json is personal data
MASTHEAD_TOKEN=<BOOTSTRAP_TOKEN> bun run masthead push --server https://<worker>/blog/ \
    --snapshot snapshot.json --members members.json --media
bun run masthead compare --ours https://<worker>/blog/ --live https://your-site.com
```

`push` loads content, staff, members and their history, copies every image into R2 and points content at it, publishes, then prints counts to check against Ghost. Every step is idempotent: run it again right before you switch to pick up anything new. `compare` checks titles, canonicals, share tags and post bodies page by page.

## Check a deployment

```bash
MASTHEAD_TOKEN=<BOOTSTRAP_TOKEN> bun scripts/smoke.ts --server https://<worker>/blog/ [--ai]
```

It exercises the site, feeds, media, sign-in, the full post lifecycle, double opt-in, a real newsletter send to one throwaway member in test mode, one-click unsubscribe, and (with `--ai`) drafting and images, then removes everything it created. It refuses to send unless the server is in email test mode.

## The studio

Sources and policies live in your private config:

```ts
// masthead.config.ts
import { predevAI } from '@masthead/ai-predev';
import { defineConfig, denylist } from '@masthead/core';
import { github } from '@masthead/source-github';
import { jsonFeed } from '@masthead/source-json';
import { predevProjects } from '@masthead/source-predev';

export default defineConfig({
    site: { url: 'https://example.com/blog/' },
    ai: predevAI({ textModel: '<model id>', imageModel: '<model id>' }),
    sources: [
        github({ repos: ['acme/app', 'acme/docs'], skipLabels: ['security'] }),
        jsonFeed({ id: 'changelog', url: 'https://example.com/changelog.json', map: json => [] /* your mapping */ }),
        predevProjects()
    ],
    policies: [denylist(['names', 'you', 'never', 'publish'])]
});
```

```bash
bun run masthead studio signals --days 14                  # what the sources see, after policies
MASTHEAD_TOKEN=<token> bun run masthead studio ideas --days 14 --count 8 --server https://<worker>/blog/
```

Ideas land on the admin's Ideas page with their sources; Draft turns one into a post in your house style (Settings, AI).

## Connectors

| Kind | Interface | Available |
|---|---|---|
| AI models | `AIProvider`: list models, text (and streamed), image, video, embeddings | `@masthead/ai-predev` |
| Content | `ContentSource`: load a snapshot | snapshot file, `@masthead/import-ghost` |
| Email | `EmailTransport`: send a batch, verify delivery events | `@masthead/email-resend` |
| Studio sources | `Source`: pull signals, expand evidence | `@masthead/source-github`, `@masthead/source-json`, `@masthead/source-predev` |
| Policies | `Policy`: admit, redact, review | `denylist` in `@masthead/core` |
| Static output | `WebTarget`: write files | `@masthead/web-fs` |

Writing a connector means implementing one small interface from `@masthead/core`.

## Keeping secrets out

- Secrets come from the environment only. Keep your real config, Worker settings, theme and house rules in a private repo that depends on these packages.
- `bun run check:leaks` scans for credential patterns and an optional private denylist (`MASTHEAD_DENYLIST` or `MASTHEAD_DENYLIST_FILE`). Findings name the file, line and term number, never the term.
- CI runs the same checks on every push, plus a full-history gitleaks scan.

## License

MIT
