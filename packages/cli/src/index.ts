#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { predevAI } from '@masthead/ai-predev';
import type { AspectRatio, MastheadConfig, ModelKind, StreamEnd } from '@masthead/core';
import { loadConfig, snapshotFile } from '@masthead/core/node';
import { exportGhostAudience, importGhost } from '@masthead/import-ghost';
import { buildSite } from '@masthead/render';
import { defaultTheme } from '@masthead/theme-default';
import { webFs } from '@masthead/web-fs';
import { altText } from './alt';
import { backup, restore } from './backup';
import { compare } from './compare';
import { push } from './push';
import { seed } from './seed';
import { collectSignals, generateIdeas, printSignals } from './studio';
import { serve } from './serve';

const HELP = `masthead <command>

  models [--kind text|image|video|embedding] [--search <text>] [--limit <n>]
                                   List models available on your AI key
  ask <prompt> [--model <id>] [--system <text>]
                                   Generate text
  image <prompt> --out <file> [--model <id>] [--aspect 16:9]
                                   Generate an image
  import ghost --out <file> [--members <file>] [--url <admin url>] [--key <admin key>] [--no-drafts]
                                   Copy a Ghost site (posts, pages, drafts, tags, staff and
                                   newsletter settings) into a snapshot file; --members also
                                   exports subscribers and their history (personal data)
  build [--snapshot <file>] [--out <dir>]
                                   Render the site
  compare --live <origin> (--dist <dir> | --ours <url>) [--limit <n>]
                                   Check a build or a running server against the live
                                   site, page by page
  serve [--dir <dir>] [--port <n>] Preview a build locally
  settings --server <url> --file <settings.json>
                                   Apply site, newsletter, AI, style-check, review and email
                                   sequence (welcome series) settings and add AI memory
                                   entries, then rebuild
  studio signals [--days 14]       Show what the configured sources see
  studio ideas [--days 14] [--count 8] [--server <url>] [--dry-run] [--model <id>]
                                   Suggest posts from the sources and save them to the
                                   server's Ideas page (token from MASTHEAD_TOKEN)
  push --server <url> [--snapshot <file>] [--members <file>] [--media]
                                   Load an import into a running server and publish
                                   (token from MASTHEAD_TOKEN or --token)
  alt-text --server <url> [--dry-run] [--slug <post>] [--model <id>]
                                   Write alt text (vision model) into every published
                                   image and cover that has none; --dry-run prints the
                                   table and changes nothing (token from MASTHEAD_TOKEN)
  seed [--server <url>] [--dir <folder>] [--force]
                                   Load the sample Acme blog (examples/demo) into an
                                   empty server and publish it. Default server
                                   http://localhost:8787/blog/; a local server's token
                                   is read from apps/worker/.dev.vars
  backup --server <url> [--out <dir>] [--date <YYYY-MM-DD>] [--list]
                                   Back up the database now (the server also does
                                   every night); --out downloads it, or the one from
                                   --date, and reads every file back; --list shows
                                   the copies the server keeps
  restore --server <url> --from <YYYY-MM-DD | dir>
                                   Load a backup (from the server's storage, or a
                                   folder saved with backup --out) into an empty
                                   database, then compare row counts

  --config <file>   Config file (default: masthead.config.ts if present)`;

function parseArgs(argv: string[]) {
    const positional: string[] = [];
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const [k, v] = a.slice(2).split('=', 2);
            if (v !== undefined) flags[k] = v;
            else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
            else flags[k] = true;
        } else positional.push(a);
    }
    return { positional, flags };
}

async function config(flags: Record<string, string | boolean>): Promise<MastheadConfig> {
    const file = typeof flags.config === 'string' ? flags.config : 'masthead.config.ts';
    if (typeof flags.config === 'string' || existsSync(resolve(file))) return loadConfig(file);
    return {};
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);

/** For a server on this machine: the BOOTSTRAP_TOKEN in apps/worker/.dev.vars (or .env), which `bun run dev` creates. */
function localToken(server: string): string | undefined {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(server).hostname)) return undefined;
    for (const name of ['.dev.vars', '.env']) {
        const file = join(import.meta.dir, '../../../apps/worker', name);
        const found = existsSync(file) ? readFileSync(file, 'utf8').match(/^BOOTSTRAP_TOKEN\s*=\s*"?([^"\s]+)"?/m)?.[1] : undefined;
        if (found) return found;
    }
    return undefined;
}

async function main() {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const [command, ...rest] = positional;
    const cfg = await config(flags);
    const ai = cfg.ai ?? predevAI();

    switch (command) {
        case 'models': {
            const kind = str(flags.kind) as ModelKind | undefined;
            const search = str(flags.search)?.toLowerCase();
            let models = await ai.listModels(kind);
            if (search) models = models.filter(m => m.id.toLowerCase().includes(search) || m.name.toLowerCase().includes(search));
            const limit = Number(str(flags.limit) ?? 50);
            const counts = models.reduce<Record<string, number>>((acc, m) => ((acc[m.kind] = (acc[m.kind] ?? 0) + 1), acc), {});
            for (const m of models.slice(0, limit)) {
                const price = m.price ? Object.entries(m.price).map(([k, v]) => `${k.replace(/^credits_per_/, '')}=${v}`).join(' ') : '';
                console.log(`${m.kind.padEnd(9)} ${m.id.padEnd(48)} ${price}`);
            }
            console.log(`\n${models.length} models (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')})${models.length > limit ? `, showing ${limit}` : ''}`);
            return;
        }
        case 'ask': {
            const prompt = rest.join(' ');
            if (!prompt) throw new Error('Usage: masthead ask <prompt> --model <id>');
            const request = { model: str(flags.model), system: str(flags.system), messages: [{ role: 'user' as const, content: prompt }] };
            if (!ai.stream) {
                const res = await ai.text(request);
                console.log(res.text);
                console.error(`\n${res.model} · ${res.usage.inputTokens ?? '?'} in / ${res.usage.outputTokens ?? '?'} out · ${res.usage.charged ?? '?'} credits`);
                return;
            }
            // The answer prints as it is written; its charge settles a moment after it ends.
            const pieces = ai.stream(request)[Symbol.asyncIterator]();
            let step = await pieces.next();
            for (; !step.done; step = await pieces.next()) process.stdout.write(step.value);
            process.stdout.write('\n');
            const end = step.value as StreamEnd | undefined;
            let charged = end?.usage.charged;
            for (const wait of [1000, 1500, 2500]) {
                if (charged != null || !ai.usage || !end?.usage.requestId) break;
                await new Promise(r => setTimeout(r, wait));
                charged = (await ai.usage(end.usage.requestId).catch(() => null))?.charged;
            }
            console.error(`\n${end?.model ?? '?'} · ${end?.usage.inputTokens ?? '?'} in / ${end?.usage.outputTokens ?? '?'} out · ${charged ?? '?'} credits`);
            return;
        }
        case 'image': {
            const prompt = rest.join(' ');
            const out = str(flags.out);
            if (!prompt || !out) throw new Error('Usage: masthead image <prompt> --out <file> --model <id>');
            const res = await ai.image({ model: str(flags.model), prompt, aspectRatio: (str(flags.aspect) as AspectRatio) ?? '16:9' });
            await mkdir(dirname(resolve(out)), { recursive: true });
            await writeFile(out, res.bytes);
            console.log(`${out} · ${res.mimeType} · ${(res.bytes.length / 1024).toFixed(0)} KB · ${res.model} · ${res.usage.charged ?? '?'} credits`);
            return;
        }
        case 'import': {
            if (rest[0] !== 'ghost') throw new Error('Supported importers: ghost');
            const out = str(flags.out) ?? 'snapshot.json';
            const url = str(flags.url) ?? process.env.GHOST_ADMIN_URL;
            const key = str(flags.key) ?? process.env.GHOST_ADMIN_API_KEY;
            if (!url || !key) throw new Error('Set GHOST_ADMIN_URL and GHOST_ADMIN_API_KEY, or pass --url and --key.');
            const t0 = performance.now();
            const snapshot = await importGhost({ url, adminKey: key, includeDrafts: flags['no-drafts'] !== true });
            await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
            const posts = snapshot.posts.filter(p => p.type === 'post');
            const drafts = posts.filter(p => p.status !== 'published').length;
            const staff = snapshot.staff ?? [];
            console.log(
                `${out} · ${posts.length} posts (${drafts} unpublished), ${snapshot.posts.length - posts.length} pages, ${snapshot.tags.length} tags, ${staff.length} staff (${[...new Set(staff.map(s => s.role))].join(', ')}) · ${Math.round(performance.now() - t0)} ms`
            );
            const membersOut = str(flags.members);
            if (membersOut) {
                const t1 = performance.now();
                const audience = await exportGhostAudience({ url, adminKey: key, onProgress: msg => process.stdout.isTTY && process.stdout.write(`\r${msg}          `) });
                if (process.stdout.isTTY) process.stdout.write('\n');
                await writeFile(membersOut, JSON.stringify(audience), { mode: 0o600 });
                const by = audience.members.reduce<Record<string, number>>((acc, m) => ((acc[m.suppressed ? `suppressed` : m.status] = (acc[m.suppressed ? 'suppressed' : m.status] ?? 0) + 1), acc), {});
                console.log(`${membersOut} · ${audience.members.length} members (${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ')}), ${audience.events.length} history events · ${Math.round(performance.now() - t1)} ms`);
            }
            return;
        }
        case 'build': {
            const t0 = performance.now();
            const content = str(flags.snapshot) ? snapshotFile(str(flags.snapshot)!) : cfg.content;
            if (!content) throw new Error('Nothing to build. Pass --snapshot <file> or set content in the config.');
            const snapshot = await content.load();
            const result = await buildSite(snapshot, { theme: cfg.theme ?? defaultTheme, site: cfg.site, render: cfg.render });
            const out = str(flags.out) ? webFs(str(flags.out)!) : (cfg.output ?? webFs('dist'));
            await out.write(result.files);
            const bytes = result.files.reduce((n, f) => n + (typeof f.contents === 'string' ? Buffer.byteLength(f.contents) : f.contents.length), 0);
            const s = result.stats;
            console.log(
                `built ${s.files} files (${(bytes / 1024 / 1024).toFixed(2)} MB): ${s.posts} posts, ${s.pages} pages, ${s.tags} tags, ${s.authors} authors · ${Math.round(performance.now() - t0)} ms`
            );
            return;
        }
        case 'compare': {
            const live = str(flags.live);
            if (!live) throw new Error('Usage: masthead compare --live <origin> (--dist <dir> | --ours <url>)');
            await compare({ dist: str(flags.dist) ?? 'dist', ours: str(flags.ours), live, limit: Number(str(flags.limit) ?? 1000) });
            return;
        }
        case 'push': {
            const server = str(flags.server);
            const token = str(flags.token) ?? process.env.MASTHEAD_TOKEN;
            if (!server || !token) throw new Error('Usage: masthead push --server <url> --snapshot <file> [--members <file>] [--media], with MASTHEAD_TOKEN set');
            const readJson = async (f: string | undefined) => (f ? JSON.parse(await readFile(f, 'utf8')) : undefined);
            await push({ server, token, snapshot: await readJson(str(flags.snapshot)), audience: await readJson(str(flags.members)), media: flags.media === true });
            return;
        }
        case 'alt-text': {
            const server = str(flags.server);
            const token = str(flags.token) ?? process.env.MASTHEAD_TOKEN;
            if (!server || !token) throw new Error('Usage: masthead alt-text --server <url> [--dry-run] [--slug <post>], with MASTHEAD_TOKEN set');
            await altText({ server, token, dryRun: flags['dry-run'] === true, slug: str(flags.slug), model: str(flags.model) });
            return;
        }
        case 'seed': {
            const server = str(flags.server) ?? 'http://localhost:8787/blog/';
            const token = str(flags.token) ?? process.env.MASTHEAD_TOKEN ?? localToken(server);
            if (!token) throw new Error('Set MASTHEAD_TOKEN to the server BOOTSTRAP_TOKEN, or pass --token.');
            await seed({ server, token, dir: resolve(str(flags.dir) ?? join(import.meta.dir, '../../../examples/demo')), force: flags.force === true });
            return;
        }
        case 'backup': {
            const server = str(flags.server);
            const token = str(flags.token) ?? process.env.MASTHEAD_TOKEN;
            if (!server || !token) throw new Error('Usage: masthead backup --server <url> [--out <dir>] [--date <YYYY-MM-DD>] [--list], with MASTHEAD_TOKEN set');
            await backup({ server, token, out: str(flags.out), date: str(flags.date), list: flags.list === true });
            return;
        }
        case 'restore': {
            const server = str(flags.server);
            const token = str(flags.token) ?? process.env.MASTHEAD_TOKEN;
            const from = str(flags.from);
            if (!server || !token || !from) throw new Error('Usage: masthead restore --server <url> --from <YYYY-MM-DD | dir>, with MASTHEAD_TOKEN set');
            await restore({ server, token, from });
            return;
        }
        case 'studio': {
            if (!cfg.sources?.length) throw new Error('No sources in the config. Add sources: [...] to masthead.config.ts.');
            const days = Number(str(flags.days) ?? 14);
            if (rest[0] === 'signals') {
                const { signals, report } = await collectSignals(cfg, days);
                printSignals(signals, report);
                return;
            }
            if (rest[0] === 'ideas') {
                await generateIdeas(cfg, ai, {
                    days,
                    count: Number(str(flags.count) ?? 8),
                    server: str(flags.server),
                    token: str(flags.token) ?? process.env.MASTHEAD_TOKEN,
                    dryRun: flags['dry-run'] === true,
                    model: str(flags.model)
                });
                return;
            }
            throw new Error('Usage: masthead studio signals|ideas');
        }
        case 'settings': {
            const server = str(flags.server);
            const token = str(flags.token) ?? process.env.MASTHEAD_TOKEN;
            const file = str(flags.file);
            if (!server || !token || !file) throw new Error('Usage: masthead settings --server <url> --file <settings.json>, with MASTHEAD_TOKEN set');
            const input = JSON.parse(await readFile(file, 'utf8'));
            const base = server.replace(/\/?$/, '/');
            const res = await fetch(`${base}admin/api/settings`, {
                method: 'PUT',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ site: input.site, newsletter: input.newsletter, ai: input.ai, style: input.style, sequences: input.sequences, workflow: input.workflow })
            });
            if (!res.ok) throw new Error(`Settings were not saved: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
            // AI memory: add the file's entries that aren't there yet; entries added in the editor stay.
            if (Array.isArray(input.memory)) {
                const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
                const have = (await fetch(`${base}admin/api/ai/memory`, { headers: auth }).then(r => r.json())) as { text: string }[];
                const add = (input.memory as string[]).filter(text => !have.some(m => m.text === text.trim()));
                for (const text of add) await fetch(`${base}admin/api/ai/memory`, { method: 'POST', headers: auth, body: JSON.stringify({ text }) });
                if (add.length) console.log(`AI memory: added ${add.length}`);
            }
            const pub = await fetch(`${base}admin/api/publish`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
            console.log(`settings saved; site rebuilt: ${pub.written} of ${pub.total} files in ${pub.ms} ms`);
            return;
        }
        case 'serve': {
            await serve({ dir: str(flags.dir) ?? 'dist', port: Number(str(flags.port) ?? 4321) });
            return;
        }
        default:
            console.log(HELP);
    }
}

main().catch(err => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
