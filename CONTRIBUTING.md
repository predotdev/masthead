# Contributing

Thanks for helping. Bug reports, fixes, connectors and docs are all welcome. For anything large, open an issue first so we can agree on the shape before you build it.

## Set up

You need [Bun](https://bun.sh) and Node.js 22 or newer.

```bash
bun install
bun run dev      # the Worker with local D1 and R2 at http://localhost:8787/blog/
bun run seed     # in another terminal: the Acme sample blog
```

`bun run dev` rebuilds the admin once at start. After changing `packages/admin`, run `bun run build` and reload. Changes to the server, renderer and theme reload by themselves; publish again (Settings, Rebuild site) to see theme changes on existing pages.

[docs/architecture.md](docs/architecture.md) explains how the pieces fit.

## Before you open a pull request

Run what CI runs:

```bash
bun run typecheck
bun run build
bun scripts/leak-guard.ts
```

CI also scans the full git history with [gitleaks](https://github.com/gitleaks/gitleaks). With gitleaks installed, `bun run check:leaks` runs both scans locally.

For changes to reading, writing, members or sending, run the end-to-end check against your local server. It creates what it needs and removes it afterwards:

```bash
MASTHEAD_TOKEN=<BOOTSTRAP_TOKEN from apps/worker/.dev.vars> bun scripts/smoke.ts --server http://localhost:8787/blog/
```

A few of its checks assume imported content, `LINK_TAG` and a configured email connector, so they fail on a bare local server. Everything else should pass.

## Conventions

- **TypeScript everywhere**, four-space indent, single quotes. Match the file you are in.
- **Readers stay fast.** Nothing on the read path may query D1, and the theme stays free of third-party scripts unless a setting turns them on.
- **Vendors live in connectors.** `packages/core` has the interfaces and no vendor code; a new AI model host, email provider or studio source is a package in `connectors/` that implements one of them. Wire it up in `apps/worker/src/index.ts` or a `masthead.config.ts`.
- **Migrations only append.** Add a new entry at the end of `MIGRATIONS` in `packages/server/src/db.ts`; never edit one that has shipped.
- **Secrets come from the environment**, never from code, config files in the repository, or logs.
- **Words matter.** Interface text and docs use plain words and short sentences, and say what happens rather than what something "enables".
- **Commits** have a short imperative subject ("Keep drafts out of the sitemap") and a body that says why.

## Adding a connector

1. Create `connectors/<name>` with a `package.json` that depends on `@masthead/core` (`"workspace:*"`).
2. Implement the interface from `packages/core/src/types.ts`: `AIProvider`, `EmailTransport`, `Source`, `ContentSource` or `WebTarget`.
3. Read keys from options or the environment, and keep error messages free of them.
4. Document the options in a comment at the top of `src/index.ts`, and add a row to the connectors table in the README.

## Reporting bugs

Open an issue with what you did, what you expected and what happened, plus your Masthead commit, where it runs (local or Workers) and any error from the browser console or `wrangler tail`. Leave out subscriber data and keys.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
