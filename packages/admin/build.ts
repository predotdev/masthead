/** Builds the admin into dist/admin: one hashed script, one hashed stylesheet, an index.html. */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = import.meta.dir;
const out = join(root, 'dist', 'admin');
// Files are replaced in place (a running dev server keeps watching the folder); stale ones are pruned at the end.
await mkdir(out, { recursive: true });
const before = new Set(await readdir(out));

const result = await Bun.build({
    entrypoints: [join(root, 'src/main.tsx')],
    outdir: out,
    target: 'browser',
    minify: true,
    splitting: true,
    naming: { entry: 'app-[hash].[ext]', chunk: 'chunk-[hash].[ext]', asset: 'asset-[hash].[ext]' },
    define: { 'process.env.NODE_ENV': '"production"' }
});
if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}
const script = result.outputs.find(o => o.kind === 'entry-point')!;
const css = await readFile(join(root, 'src/style.css'), 'utf8');
const hash = new Bun.CryptoHasher('sha256').update(css).digest('hex').slice(0, 10);
await writeFile(join(out, `style-${hash}.css`), css);
const scriptName = script.path.split('/').pop();
await writeFile(
    join(out, 'index.html'),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Admin</title>
<link rel="stylesheet" href="style-${hash}.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="${scriptName}"></script>
</body>
</html>
`
);
const fresh = new Set([...result.outputs.map(o => o.path.split('/').pop()!), `style-${hash}.css`, 'index.html']);
for (const f of before) if (!fresh.has(f)) await rm(join(out, f), { force: true });

for (const o of result.outputs) {
    const bytes = await Bun.file(o.path).bytes();
    console.log(`${o.kind.padEnd(12)} ${o.path.split('/').pop()}  ${(bytes.length / 1024).toFixed(0)} KB, ${(Bun.gzipSync(bytes).length / 1024).toFixed(0)} KB gzipped`);
}
console.log(`stylesheet   style-${hash}.css  ${(css.length / 1024).toFixed(0)} KB`);
