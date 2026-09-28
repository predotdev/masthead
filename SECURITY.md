# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's private reporting: on this repository's **Security** tab, choose **Report a vulnerability**. Include what an attacker can do, the steps to reproduce it, and the commit you tested.

We will acknowledge your report, keep you updated while we fix it, and credit you in the release notes if you would like. Please give us a reasonable time to ship a fix before you share details.

The latest commit on `main` is the supported version.

## What Masthead protects, and how

- **Secrets live in the Worker's environment.** Nothing sensitive is read from the repository or written to logs, and the admin shows whether a key is set, never its value.
- **Staff sign in with single-use links** that expire in an hour. Only a click in the browser uses a link, so mail scanners that fetch it cannot. Sessions are `HttpOnly`, `Secure`, `SameSite=Lax` cookies.
- **The owner token** (`BOOTSTRAP_TOKEN`) must be at least 32 characters and is compared in constant time. Integrations use API keys, stored only as hashes, with a role.
- **Cross-site requests cannot change anything.** State-changing admin calls need a bearer token or a header only the admin app sends.
- **Subscriber links are signed** with `SECRET` (HMAC), and delivery webhooks are verified with the provider's signing secret.
- **Readers get static files** rendered at publish time, and the theme adds no third-party scripts unless you configure analytics.
- **Staging does not leak into search.** Every host other than the canonical one answers with `noindex`.

## Running it safely

- Keep `wrangler.toml`, `.dev.vars`, `.env.production`, Ghost exports and `members.json` out of public repositories. The repository's `.gitignore` covers the default names.
- Use a long random `SECRET` and do not rotate it casually: links in emails already sent are signed with it.
- Treat the owner token like a root password, and give teammates their own accounts with the smallest role that works.
- Keep `EMAIL_TEST_MODE = "true"` until you are ready to email your list.
- `bun run check:leaks` scans for credential patterns and an optional private denylist (`MASTHEAD_DENYLIST` or `MASTHEAD_DENYLIST_FILE`) of names you never want committed. Findings name the file, line and term number, never the term.
