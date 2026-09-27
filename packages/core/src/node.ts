/** Node, Bun and Deno helpers. Not for Workers: they read the local filesystem. */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContentSource, MastheadConfig } from './config';
import type { Snapshot } from './types';

export async function loadConfig(file = 'masthead.config.ts'): Promise<MastheadConfig> {
    const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
    const mod = await import(pathToFileURL(path).href);
    const config = (mod.default ?? mod.config) as MastheadConfig | undefined;
    if (!config) throw new Error(`${file} must export a config as its default export.`);
    return config;
}

/** Loads content from a snapshot file written by an importer. */
export function snapshotFile(path: string): ContentSource {
    return {
        id: 'snapshot-file',
        async load() {
            const snapshot = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
            if (snapshot.format !== 'masthead.snapshot/1') {
                throw new Error(`${path} is not a Masthead snapshot (format ${String(snapshot.format)}).`);
            }
            return snapshot;
        }
    };
}
