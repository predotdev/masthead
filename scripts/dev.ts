#!/usr/bin/env bun
/**
 * Masthead on your machine in one command: builds the admin, makes local secrets
 * on the first run, and starts the Worker with local D1 and R2.
 *
 *   bun run dev [--port 8787]
 *
 * Uses apps/worker/wrangler.toml when you have one; otherwise wrangler.example.toml
 * with SITE_URL pointed at localhost. Secrets live in apps/worker/.dev.vars, which
 * git ignores. Then `bun run seed` loads the sample blog.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const worker = join(root, 'apps/worker');
const at = process.argv.indexOf('--port');
const port = Number(at > 0 ? process.argv[at + 1] : 8787) || 8787;

const build = spawnSync('bun', ['build.ts'], { cwd: join(root, 'packages/admin'), stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

if (!existsSync(join(worker, '.dev.vars')) && !existsSync(join(worker, '.env'))) {
    const secret = () => randomBytes(32).toString('hex');
    writeFileSync(join(worker, '.dev.vars'), `# Local secrets for \`bun run dev\`. Not committed.\nSECRET=${secret()}\nBOOTSTRAP_TOKEN=${secret()}\n`, { mode: 0o600 });
    console.log('\nMade apps/worker/.dev.vars with a new SECRET and BOOTSTRAP_TOKEN (the owner token).');
}

const own = existsSync(join(worker, 'wrangler.toml'));
const args = ['dev', '--port', String(port)];
if (!own) args.push('--config', 'wrangler.example.toml', '--var', `SITE_URL:http://localhost:${port}/blog/`);

console.log(`
  Site    http://localhost:${port}/blog/
  Admin   http://localhost:${port}/blog/admin/   (owner token: BOOTSTRAP_TOKEN in apps/worker/.dev.vars)
  Sample  bun run seed${port === 8787 ? '' : ` --server http://localhost:${port}/blog/`}   (in another terminal)
  Config  ${own ? 'apps/worker/wrangler.toml' : 'apps/worker/wrangler.example.toml'}
`);

const child = spawn(join(worker, 'node_modules/.bin/wrangler'), args, { cwd: worker, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
