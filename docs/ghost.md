# Move from Ghost

Masthead reads your Ghost site through the Admin API, loads it into your own Worker, and keeps every address working. Ghost stays live the whole time; you switch traffic when the copy checks out, and you can switch back.

## What comes across

| From Ghost | In Masthead |
| --- | --- |
| Posts, pages and drafts | Same slugs, dates, excerpts, share and SEO fields. Bodies keep Ghost's HTML byte for byte (callouts, buttons, bookmarks, galleries, embeds and video render as they did), with a Markdown copy you can switch to in the editor. |
| Tags | Public and internal, with descriptions. |
| Staff | Everyone with their role (owner, administrator, editor, author, contributor). They sign in with an emailed link; no passwords move. |
| Images and media | Every file the content references is copied into R2 under the same `content/images/...` path, with Ghost's resized copies for covers, and content is rewritten to point at it. |
| Members | Subscribed or not, bounces and spam complaints as suppressions, labels, email and open counts. Paid members come across as newsletter subscribers. |
| Member history | Every subscribe and unsubscribe event, with who made it. Nobody who opted out can be re-subscribed by a later import or signup. |
| Newsletter stats | Recipients, deliveries and opens for every post Ghost emailed, shown in Analytics next to new sends. |
| Settings | Title, description, logo, icon, accent color, navigation and the newsletter sender. |

Addresses stay the same: `/<slug>/`, `/tag/<slug>/`, `/author/<slug>/`, `/rss/`, `/sitemap.xml` and `/content/images/...`. Ghost's older shapes (`/amp/`, uppercase slugs, `index.html`, tag and author feeds) redirect to where those pages live now. Unsubscribe links in newsletters Ghost already sent (`/unsubscribe/?uuid=...`) keep working, tracked links from old emails (`/r/...`) land on the front page, and `/ghost/` answers `410 Gone`.

Not supported: paid tiers and Stripe checkout, comments, recommendations and Ghost themes. Masthead's theme is configured with settings instead.

## 1. Export from Ghost

In Ghost's admin, go to Settings, Integrations, **Add custom integration**, and copy the Admin API URL and key. Everything the importer does is a read.

```bash
export GHOST_ADMIN_URL=https://your-site.ghost.io
export GHOST_ADMIN_API_KEY=<id>:<secret>
bun run masthead import ghost --out snapshot.json --members members.json
```

`snapshot.json` is your content. `members.json` is your list and its history: personal data, written readable only by you. The repository's `.gitignore` keeps both out of git; delete `members.json` when you are done.

## 2. Load it into Masthead

[Deploy Masthead](deploy.md) with `EMAIL_TEST_MODE = "true"`, so nobody on the list gets email while you check. Then:

```bash
MASTHEAD_TOKEN=<owner token> bun run masthead push --server https://<worker>/blog/ \
    --snapshot snapshot.json --members members.json --media
```

`push` loads content and staff, copies media into R2 and points content at it, imports members and their history in batches, publishes, then prints what the server now holds next to what the export had. Every step is idempotent: run it again at any time to pick up what changed in Ghost.

## 3. Compare

```bash
bun run masthead compare --ours https://<worker>/blog/ --live https://your-site.com
```

`compare` walks every page and checks titles, canonical URLs, share tags and post bodies against the live Ghost site, and lists what differs.

## Switch traffic

1. Run `import` and `push` once more, right before the switch, to catch posts and members added since.
2. Turn `EMAIL_TEST_MODE` off (remove `EMAIL_TEST_ALLOW`), set `INDEXNOW = "true"`, and deploy.
3. Route the blog's address to the Worker: a route like `example.com/blog*`, a custom domain, or your proxy (see [deploy.md](deploy.md#6-your-domain)). Keep the old Ghost origin configured, so switching back is the same change in reverse.
4. Point your email provider's webhook at `<blog>/api/webhooks/email`.
5. If your product adds people to the list (a signup form, a backend job), send them to `POST <blog>/admin/api/members` with an API key from Settings. Adding someone who unsubscribed never re-subscribes them.
6. Watch a few days of traffic and one newsletter, then cancel Ghost.
