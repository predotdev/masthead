# Masthead

An open-source blog and newsletter with an AI writing studio, built to replace Ghost.

Readers get static pages with no JavaScript, served from the edge. Writers get Markdown, a fast editor that stays out of the way, and a studio that proposes and drafts posts from your own sources. Subscribers get double opt-in, one-click unsubscribe and a history that is never overwritten. Everything outside the core (models, storage, email, where ideas come from) is a small connector you can swap.

## What you get

- **Fast for readers.** A post page is about 10 KB compressed, with no scripts. Pages are rendered once at publish time and served from storage, revalidated with ETags and Last-Modified.
- **Found by search and by AI.** Canonical links, share cards, BlogPosting and breadcrumb structured data with author profiles, image sitemaps, a full-content RSS feed, `llms.txt`, and a Markdown copy of every post.
- **A newsletter you can trust with a list.** Recipients are frozen when a send is queued, batches carry idempotency keys, one worker at a time holds a send, every email has RFC 8058 one-click unsubscribe, and adding an existing person (a product signup, an import) never re-subscribes someone who opted out.
- **An editor for writing.** TipTap with Markdown shortcuts, a slash menu, paste-to-upload images, autosave, scheduled publishing, and imported posts kept byte-for-byte as HTML until you choose to convert them.
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

Keep `EMAIL_TEST_MODE = "true"` until you switch traffic: every newsletter and member email then goes to the provider's test inbox. Pages served from any host other than `SITE_URL` answer with `noindex`, so a staging copy never competes with your live site.

| Path under the blog | What it serves |
|---|---|
| `/` and every page | the published site, from R2 (and Cloudflare's edge cache on a custom domain) |
| `content/…` | images and media, with range requests |
| `api/…` | subscribe, confirm, unsubscribe, delivery webhooks |
| `admin/` | the admin app; `admin/api/…` is its API |

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
| AI models | `AIProvider`: list models, text, image | `@masthead/ai-predev` |
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
