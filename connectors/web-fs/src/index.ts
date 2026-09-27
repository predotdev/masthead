import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { OutputFile, WebTarget } from '@masthead/core';

/** Writes the rendered site into a folder you can serve with any static host. */
export function webFs(dir: string): WebTarget {
    const root = resolve(dir);
    const inside = (p: string) => {
        const full = resolve(root, p);
        if (full !== root && !full.startsWith(root + sep)) throw new Error(`Refusing to write outside ${root}: ${p}`);
        return full;
    };
    return {
        id: 'fs',
        async write(files: OutputFile[]) {
            for (const f of files) {
                const full = inside(f.path);
                await mkdir(dirname(full), { recursive: true });
                await writeFile(full, f.contents);
            }
        },
        async remove(paths: string[]) {
            for (const p of paths) await rm(inside(p), { force: true });
        }
    };
}
