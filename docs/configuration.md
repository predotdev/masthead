# Configuration

Masthead reads two kinds of configuration:

- **The Worker's environment**: addresses, bindings, keys and switches. Plain values go under `[vars]` in `apps/worker/wrangler.toml`; keys are secrets (`wrangler secret put NAME`, or `--secrets-file` on deploy). Locally, `apps/worker/.dev.vars` holds the secrets.
- **Site settings**: title, menus, footer, look, newsletter sender, house style and AI sources. They live in D1 and are edited in the admin (Settings), or applied from a JSON file with `masthead settings`.

## Worker environment

### Required

| Name | Kind | What it does |
| --- | --- | --- |
| `SITE_URL` | var | The blog's public address including its path, e.g. `https://example.com/blog/`. The Worker serves everything under that path. Only this host, reached directly or through a proxy that passes it as `x-forwarded-host`, is indexable; every other host gets `noindex`. |
| `SECRET` | secret | Signs subscriber links (confirm, unsubscribe). Long and random. Changing it breaks the unsubscribe links in emails already sent. |
| `BOOTSTRAP_TOKEN` | secret | The owner token, at least 32 characters: the first sign-in (which creates the owner account) and the CLI (`MASTHEAD_TOKEN`). |
| `DB` | D1 binding | The database. The schema is created and migrated on the first request. |
| `BUCKET` | R2 binding | The published site and all media. |
| `ASSETS` | assets binding | The admin app, built into `packages/admin/dist` by `bun run build`. |

### Addresses

| Name | Kind | What it does |
| --- | --- | --- |
| `APP_URL` | var | Where this Worker is reachable when that differs from `SITE_URL`, such as a workers.dev address before you switch traffic. Sign-in and confirmation links use it. Same path as `SITE_URL`. |
| `PREVIEW_PATH` | var | A second path the whole site answers on, e.g. `/blog-new/`, to try Masthead on your real domain while an old blog still has `SITE_URL`'s path. Links stay on the preview path, canonical URLs keep naming `SITE_URL`, pages are `noindex`, and the admin stays on the main path. |

### Email

| Name | Kind | What it does |
| --- | --- | --- |
| `EMAIL_FROM` | var | The sender, e.g. `Acme <news@acme.example>`, on a domain your email provider has verified. Wins over the sender in Settings. |
| `EMAIL_REPLY_TO` | var | Reply-to address, when Settings has none. |
| `POSTAL_ADDRESS` | var | The postal address in every newsletter footer, which US law requires. Settings can override it. |
| `RESEND_API_KEY` | secret | Sending through Resend. Without an email connector, nothing is sent. |
| `RESEND_WEBHOOK_SECRET` | secret | Verifies delivery, open, click, bounce and complaint events posted to `<blog>/api/webhooks/email`. |
| `EMAIL_TEST_MODE` | var | `"true"`: email reaches only the team (the `EMAIL_TEST_ALLOW` entries, staff, and the provider's test addresses). Newsletters go only to the team members of a segment; confirmations and test sends to anyone else are not sent. Staff sign-in and invites work as usual. Keep it on until you switch traffic. |
| `EMAIL_TEST_ALLOW` | var | The team in test mode: comma-separated addresses or `@domains`, e.g. `@acme.example`. |
| `EMAIL_TEST_ADDRESS` | var | Where anything that slips past the team check goes in test mode. Default `delivered@resend.dev`. |

### AI

| Name | Kind | What it does |
| --- | --- | --- |
| `PREDEV_API_KEY` | secret | Turns on the AI: drafting, editing, the assistant, images, video, embeddings, auto tags and ideas, through the pre.dev connector. Everything else works without it. |
| `TEXT_MODEL`, `IMAGE_MODEL`, `VIDEO_MODEL` | var | Default models for everyone. Settings, AI can change them, and each writer can pick their own in the editor. |
| `EMBEDDING_MODEL` | var | Lets the AI search your posts and knowledge sources. Choosing another embedding model in Settings re-reads everything. |
| `DENYLIST` | secret | Names the studio never mentions in ideas and drafts (customers, partners, vendors), newline or comma separated. Settings, Ideas adds more; the admin shows only how many this variable holds. |

### Links, search engines and images

| Name | Kind | What it does |
| --- | --- | --- |
| `LINK_TAG` | var | `param=value` added to outbound links in posts, e.g. `ref=example.com`. |
| `INDEXNOW` | var | `"true"`: tell search engines (IndexNow: Bing, Yandex and others) about changed pages on publish. Turn it on once `SITE_URL` serves this blog. |
| `INDEXNOW_KEY` | var | The IndexNow key, 32 hex characters. Generated and kept in settings when unset. |
| `IMAGES` | Images binding | Optional. Makes resized WebP copies of stored images for `srcset`, the way Ghost's `size/wN/` addresses work. |

### Analytics (PostHog, optional)

| Name | Kind | What it does |
| --- | --- | --- |
| `POSTHOG_KEY` | var | Your project key (`phc_…`, public by design). Pages then load PostHog after they settle, and the server records subscriptions. |
| `POSTHOG_HOST` | var | Where events go. Default `https://us.i.posthog.com`; use `https://eu.i.posthog.com` or your own proxy. |
| `POSTHOG_TRACK_PREVIEW` | var | `"true"`: also track previews (other hosts, and the site at `PREVIEW_PATH`), tagged `environment=preview`. |
| `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` | secret, var | Traffic in the admin's Analytics: a personal API key with query read access to that project. Newsletter and growth numbers need neither. |
| `GOOGLE_SERVICE_ACCOUNT`, `GSC_PROPERTY` | secret, var | Search in the admin's Analytics: a Google Cloud service account's JSON key (as is, or base64) with the Search Console API turned on in its project, added as a Restricted user on the property; and the property to read, e.g. `sc-domain:example.com` or `https://example.com/`. Shows searches, pages, positions and ranked opportunities; the Search tab explains any missing step. |
| `POSTHOG_API_HOST` | var | Where those queries go when `POSTHOG_HOST` is a proxy. Default: the app host for `POSTHOG_HOST`, such as `https://us.posthog.com`. |
| `POSTHOG_SIGNUP_EVENT` | var | Your product's signup event, for "signups after reading". It carries the `blog_ref_post_slug` property the blog registers. Default `auth_signup_success`. |

### Scheduled work

`[triggers] crons = ["* * * * *"]` in `wrangler.toml` runs the Worker every minute: it publishes scheduled posts, works through newsletter batches, embeds new knowledge, re-reads knowledge sources once a day at 03:17 UTC, and checks hourly whether the daily ideas refresh is due. Remove it and scheduling and sending stop. Local `wrangler dev` does not run crons; trigger one with `curl "http://localhost:8787/cdn-cgi/local/scheduled"`.

## Site settings

Everything in Settings is also one JSON file you can keep in your own repository and apply with:

```bash
MASTHEAD_TOKEN=<owner token> bun run masthead settings --server https://example.com/blog/ --file site-settings.json
```

It saves `site`, `newsletter`, `ai`, `style` and `workflow`, adds `memory` entries the server does not have yet (entries added in the admin stay), then rebuilds the site. Fields you leave out keep their current values. An example:

```json
{
  "site": {
    "title": "Acme",
    "description": "Product news, engineering notes and guides from the team building Acme.",
    "logo": "https://acme.example/logo.svg",
    "icon": "https://acme.example/favicon.png",
    "shareImage": "https://acme.example/blog-card.png",
    "accentColor": "#6d5efc",
    "navigation": [
      { "label": "Product", "url": "https://acme.example/", "items": [
        { "label": "Flow", "url": "https://acme.example/flow", "description": "Plan, ship and review", "icon": "workflow" }
      ] },
      { "label": "Docs", "url": "https://acme.example/docs" },
      { "label": "About", "url": "/about/" }
    ],
    "footer": {
      "tagline": "The calm way to ship software.",
      "columns": [{ "title": "Company", "links": [{ "label": "About", "url": "/about/" }] }],
      "legal": [{ "label": "Privacy", "url": "https://acme.example/privacy" }],
      "social": [{ "network": "github", "url": "https://github.com/example" }]
    },
    "appearance": {
      "colorScheme": "system",
      "logoText": true,
      "headerCta": { "label": "Try Acme", "url": "https://acme.example/signup" },
      "subscribe": { "title": "Get the Acme Journal", "text": "New posts by email." }
    }
  },
  "newsletter": { "senderName": "Acme Journal", "replyTo": "hello@acme.example" },
  "ai": {
    "voice": "Plain, specific and warm. Short sentences. Numbers when we have them.",
    "knowledgeSources": ["https://acme.example/llms.txt", "https://acme.example/changelog.json"]
  },
  "memory": ["Acme Flow is available on every plan, including Free."]
}
```

### `site`

| Field | What it does |
| --- | --- |
| `title`, `description`, `locale` | The publication's name, one-line description and language (default `en`). |
| `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription` | Title, description and share card for the front page, when they differ from the above. |
| `logo`, `icon`, `shareImage` | Logo in the header and footer, favicon, and the default share image for pages without their own. |
| `accentColor` | Brand color for links and buttons. |
| `twitter` | The publication's X handle, for share cards. |
| `navigation` | Header menu. An item with `items` becomes a dropdown; items take `description`, `badge`, `icon` (`terminal`, `window`, `workflow`, `pointer`, `flask`, `book`, `rss`, `mail`) and `group`. Links starting with `/` are relative to the blog. |
| `footer` | `tagline`, `columns` of links, `legal` links, `copyright` (`{year}` becomes the year) and `social` links (`x`, `linkedin`, `youtube`, `instagram`, `discord`, `github`, `facebook`, `threads`, `bluesky`, `mastodon`, `tiktok`). |
| `appearance.colorScheme` | `system` (default), `light` or `dark`, before a reader chooses. |
| `appearance.logoText`, `appearance.invertLogoInLight`, `appearance.brandUrl` | Show the title next to the logo, invert a light logo in the light scheme, and where the brand links. |
| `appearance.hero` | A front-page masthead: a big `title` after the logo and an optional `text` tagline. Without it, the newest post leads the page. |
| `appearance.backdrop` | A backdrop behind the header: an `image`, an optional `mobileImage` and twinkling `sparkles`. Inverted in the light scheme. |
| `appearance.headerCta` | A button at the end of the header, with an optional `signedIn` variant chosen by a cookie your product sets. |
| `appearance.subscribe` | Title and text of the signup band. |
| `publisher` | The organization in structured data: `name`, `url`, `logo`, `sameAs`. Defaults to the site. |

### `newsletter`

`senderName`, `senderEmail` and `replyTo`. `EMAIL_FROM` wins over the sender when it is set; a `postalAddress` here wins over `POSTAL_ADDRESS`.

### `ai`

`textModel`, `imageModel`, `videoModel` and `embeddingModel` override the variables of the same names. `knowledgeSources` are pages the AI reads besides the blog itself (an `llms.txt`, docs, a changelog feed). `voice` is the house style every draft follows.

### `workflow`

`requireApproval`: `true` means a draft is published or scheduled only once its review is approved (Settings, Review). The owner can always publish. Off by default.

### Ideas

Settings, Ideas controls the daily refresh: whether it runs, the hour (UTC), how many ideas per run, your guidance for the studio, extra public pages or feeds to read, and names never to mention (on top of `DENYLIST`). A refresh skips the day when nothing is new or 30 ideas are already waiting.

## The CLI

Run it from the repository with `bun run masthead <command>`. Commands that talk to a server take `--server <blog address>` and read the owner token (or an admin API key from Settings) from `MASTHEAD_TOKEN`.

| Command | What it does |
| --- | --- |
| `seed [--server <url>] [--force]` | Load the Acme sample into an empty server and publish it. On a local server it reads the token from `apps/worker/.dev.vars`. |
| `import ghost --out <file> [--members <file>]` | Copy a Ghost site into a snapshot file, and optionally its members and their history (personal data: keep that file private). Reads `GHOST_ADMIN_URL` and `GHOST_ADMIN_API_KEY`. |
| `push --server <url> --snapshot <file> [--members <file>] [--media]` | Load a snapshot (and members) into a running server, copy media into R2, publish, and print counts to check. Safe to repeat. |
| `compare --live <origin> --ours <url>` | Check titles, canonicals, share tags and bodies page by page against the live site. |
| `settings --server <url> --file <file>` | Apply site settings from a file, as above. |
| `build [--snapshot <file>] [--out dir]`, `serve [--dir dir]` | Render a snapshot to static files and preview them, no server needed. |
| `studio signals`, `studio ideas [--server <url>]` | What the configured sources see, and post ideas from them (needs a `masthead.config.ts` with `sources`). |
| `models`, `ask <prompt>`, `image <prompt> --out <file>` | List models and try text or images with your AI key (`PREDEV_API_KEY`). |

`bun run masthead` with no command prints every option.

## `masthead.config.ts`

The CLI reads an optional `masthead.config.ts` for things that are code rather than settings: the studio's sources and policies, an AI provider, or a content source and output for static builds. Keep yours in a private repository; secrets still come from the environment.

```ts
import { predevAI } from '@masthead/ai-predev';
import { defineConfig, denylist } from '@masthead/core';
import { github } from '@masthead/source-github';
import { jsonFeed } from '@masthead/source-json';

export default defineConfig({
    site: { url: 'https://example.com/blog/' },
    ai: predevAI({ textModel: '<model id>' }),
    sources: [
        github({ repos: ['acme/app', 'acme/docs'], skipLabels: ['security'] }), // GITHUB_TOKEN from the environment
        jsonFeed({ id: 'changelog', url: 'https://example.com/changelog.json', map: json => [] /* your mapping */ })
    ],
    policies: [denylist(['names', 'you', 'never', 'publish'])]
});
```

`examples/basic` is a minimal config for static builds.
