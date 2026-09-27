#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { predevAI } from '@masthead/ai-predev';
import type { AspectRatio, MastheadConfig, ModelKind } from '@masthead/core';
import { loadConfig, snapshotFile } from '@masthead/core/node';
import { exportGhostAudience, importGhost } from '@masthead/import-ghost';
import { buildSite } from '@masthead/render';
import { defaultTheme } from '@masthead/theme-default';
import { webFs } from '@masthead/web-fs';
import { compare } from './compare';
import { push } from './push';
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
  studio signals [--days 14]       Show what the configured sources see
  studio ideas [--days 14] [--count 8] [--server <url>] [--dry-run] [--model <id>]
                                   Suggest posts from the sources and save them to the
                                   server's Ideas page (token from MASTHEAD_TOKEN)
  push --server <url> [--snapshot <file>] [--members <file>] [--media]
                                   Load an import into a running server and publish
                                   (token from MASTHEAD_TOKEN or --token)

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
            const res = await ai.text({ model: str(flags.model), system: str(flags.system), messages: [{ role: 'user', content: prompt }] });
            console.log(res.text);
            console.error(`\n${res.model} · ${res.usage.inputTokens ?? '?'} in / ${res.usage.outputTokens ?? '?'} out · ${res.usage.charged ?? '?'} credits`);
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
