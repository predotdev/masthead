/**
 * GitHub as a studio source. It reads only the repositories you list:
 *
 *   github({ repos: ['acme/app', 'acme/docs'] })          merged pull requests and releases
 *   githubFiles({ repo: 'acme/catalog', match, map })    structured files, through your own mapping
 *
 * The token needs read access to those repositories and nothing else; a
 * fine-grained token scoped to the list is the right shape.
 */
import type { Evidence, Signal, Source } from '@masthead/core';

export interface GitHubOptions {
    /** owner/name of every repository the studio may read. */
    repos: string[];
    /** Defaults to the GITHUB_TOKEN environment variable. */
    token?: string;
    /** Default: both. */
    include?: ('pulls' | 'releases')[];
    /** Pull requests carrying any of these labels are never read, e.g. "internal" or "security". */
    skipLabels?: string[];
    /** Return false to drop a signal before anything else sees it, e.g. by title prefix. */
    filter?: (signal: Signal) => boolean;
    /** Defaults to https://api.github.com */
    api?: string;
}

export function github(options: GitHubOptions): Source {
    const call = client(options.token, options.api);
    const include = new Set(options.include ?? ['pulls', 'releases']);
    const skip = new Set((options.skipLabels ?? []).map(l => l.toLowerCase()));

    return {
        id: 'github',
        async *pull(since) {
            for (const repo of options.repos) {
                if (include.has('pulls')) {
                    for (let page = 1; page <= 10; page++) {
                        const pulls: any[] = await call(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
                        for (const p of pulls) {
                            if (!p.merged_at || new Date(p.merged_at) < since) continue;
                            const labels: string[] = (p.labels ?? []).map((l: any) => l.name);
                            if (labels.some(l => skip.has(l.toLowerCase()))) continue;
                            const signal: Signal = {
                                ref: `github:${repo}#${p.number}`,
                                source: 'github',
                                kind: 'pull',
                                title: p.title,
                                summary: clean(p.body).slice(0, 600),
                                at: p.merged_at,
                                url: p.html_url,
                                tags: [repo, ...labels]
                            };
                            if (!options.filter || options.filter(signal)) yield signal;
                        }
                        // Sorted by last update: once a page ends before the window, older pages can't hold merges inside it.
                        if (pulls.length < 100 || new Date(pulls[pulls.length - 1].updated_at) < since) break;
                    }
                }
                if (include.has('releases')) {
                    const releases: any[] = await call(`/repos/${repo}/releases?per_page=30`);
                    for (const r of releases) {
                        if (r.draft || !r.published_at || new Date(r.published_at) < since) continue;
                        const signal: Signal = {
                            ref: `github:${repo}@${r.tag_name}`,
                            source: 'github',
                            kind: 'release',
                            title: r.name || r.tag_name,
                            summary: clean(r.body).slice(0, 600),
                            at: r.published_at,
                            url: r.html_url,
                            tags: [repo]
                        };
                        if (!options.filter || options.filter(signal)) yield signal;
                    }
                }
            }
        },
        async expand(ref) {
            const pull = ref.match(/^github:(.+?)#(\d+)$/);
            if (pull) {
                const [, repo, number] = pull;
                if (!options.repos.includes(repo)) throw new Error(`${repo} is not in the access list.`);
                const p = await call(`/repos/${repo}/pulls/${number}`);
                return {
                    ref,
                    title: p.title,
                    body: clean(p.body),
                    fields: { mergedAt: p.merged_at, additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files, url: p.html_url }
                };
            }
            const release = ref.match(/^github:(.+?)@(.+)$/);
            if (release) {
                const [, repo, tag] = release;
                if (!options.repos.includes(repo)) throw new Error(`${repo} is not in the access list.`);
                const r = await call(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
                return { ref, title: r.name || r.tag_name, body: clean(r.body), fields: { publishedAt: r.published_at, url: r.html_url } };
            }
            throw new Error(`Not a GitHub reference: ${ref}`);
        }
    };
}

export interface GitHubFilesOptions {
    /** owner/name */
    repo: string;
    /** Which files to read, e.g. /(^|\/)manifest\.json$/ */
    match: RegExp;
    /**
     * Turns one file into a signal, or null to skip it. Only what this returns
     * ever leaves the file, so drop anything private here.
     */
    map: (file: { path: string; text: string }) => Signal | null;
    /** Defaults to the GITHUB_TOKEN environment variable. */
    token?: string;
    /** Branch; defaults to the repository's default branch. */
    branch?: string;
    /** Most files read in one pull. Default 500. */
    limit?: number;
    id?: string;
    api?: string;
}

export function githubFiles(options: GitHubFilesOptions): Source {
    const call = client(options.token, options.api);
    const seen = new Map<string, Signal>();
    return {
        id: options.id ?? `github-files:${options.repo}`,
        async *pull(since) {
            const branch = options.branch ?? (await call(`/repos/${options.repo}`)).default_branch;
            const tree = await call(`/repos/${options.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
            const paths: string[] = (tree.tree as any[])
                .filter(t => t.type === 'blob' && options.match.test(t.path))
                .map(t => t.path)
                .slice(0, options.limit ?? 500);
            const out: Signal[] = [];
            const queue = [...paths];
            await Promise.all(
                Array.from({ length: 8 }, async () => {
                    for (let path = queue.shift(); path; path = queue.shift()) {
                        const text: string = await call(`/repos/${options.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, 'raw');
                        const signal = options.map({ path, text });
                        if (signal && new Date(signal.at) >= since) out.push(signal);
                    }
                })
            );
            for (const s of out.sort((a, b) => b.at.localeCompare(a.at))) {
                seen.set(s.ref, s);
                yield s;
            }
        },
        async expand(ref): Promise<Evidence> {
            const s = seen.get(ref);
            if (!s) throw new Error(`Pull first: ${ref} has not been read.`);
            return { ref, title: s.title, body: s.summary, fields: s.metrics };
        }
    };
}

function client(token?: string, api = 'https://api.github.com') {
    return async (path: string, format: 'json' | 'raw' = 'json'): Promise<any> => {
        const auth = token ?? (globalThis as any).process?.env?.GITHUB_TOKEN;
        if (!auth) throw new Error('No GitHub token. Set GITHUB_TOKEN to a token that can read the listed repositories.');
        for (let attempt = 0; ; attempt++) {
            const res = await fetch(`${api}${path}`, {
                headers: {
                    authorization: `Bearer ${auth}`,
                    accept: format === 'raw' ? 'application/vnd.github.raw' : 'application/vnd.github+json',
                    'x-github-api-version': '2022-11-28',
                    'user-agent': 'masthead-studio'
                }
            });
            if (res.ok) return format === 'raw' ? res.text() : res.json();
            const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
            if ((limited || res.status >= 500) && attempt < 3) {
                const reset = Number(res.headers.get('retry-after') ?? 0) * 1000 || 2000 * 2 ** attempt;
                await new Promise(r => setTimeout(r, Math.min(reset, 60_000)));
                continue;
            }
            throw new Error(`GitHub ${res.status} for ${path.split('?')[0]}`);
        }
    };
}

/** Pull request bodies without template comments, checklists or images. */
function clean(body: string | null | undefined): string {
    return (body ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<img[^>]*>/gi, '')
        .replace(/^\s*- \[[ x]\].*$/gim, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
