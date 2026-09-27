/**
 * Fails when the repo contains credentials or anything on a private denylist.
 *
 * The denylist (internal hostnames, account ids, partner names) never lives
 * in this repo: pass it through MASTHEAD_DENYLIST (newline or comma separated,
 * e.g. from a CI secret) or MASTHEAD_DENYLIST_FILE (a path outside the repo).
 * Findings name the file, the line and the term's position in the list,
 * never the term itself, so CI logs don't leak it either.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SECRET_PATTERNS: [string, RegExp][] = [
    ['pre.dev API key', /\bpdk_[A-Za-z0-9_-]{16,}/],
    ['Ghost Admin API key', /\b[0-9a-f]{24}:[0-9a-f]{64}\b/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['API secret key', /\bsk-[A-Za-z0-9_-]{24,}/],
    ['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
    ['Slack webhook', /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/],
    ['JSON web token', /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/],
    ['connection string with password', /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s:/@]+:[^\s@/]+@/i]
];

const SKIP = /\.(png|jpe?g|gif|webp|avif|ico|mp4|webm|woff2?|pdf|zip|lockb)$/i;

function denylist(): string[] {
    const raw = [process.env.MASTHEAD_DENYLIST ?? '', process.env.MASTHEAD_DENYLIST_FILE ? readFileSync(process.env.MASTHEAD_DENYLIST_FILE, 'utf8') : '']
        .join('\n')
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('#'));
    return [...new Set(raw)];
}

function termRegex(term: string): RegExp {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Whole-word match for plain words so short names don't match inside other words.
    return /^[A-Za-z0-9]+$/.test(term) ? new RegExp(`\\b${escaped}\\b`, 'i') : new RegExp(escaped, 'i');
}

const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(f => f && !SKIP.test(f));
const terms = denylist();
const termRes = terms.map(termRegex);
const findings: string[] = [];

for (const file of files) {
    let text: string;
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        continue;
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
        for (const [label, re] of SECRET_PATTERNS) if (re.test(line)) findings.push(`${file}:${i + 1}  ${label}`);
        termRes.forEach((re, n) => {
            if (re.test(line)) findings.push(`${file}:${i + 1}  private denylist term #${n + 1}`);
        });
    });
}

if (!terms.length) console.log('No private denylist given (set MASTHEAD_DENYLIST or MASTHEAD_DENYLIST_FILE); checked credential patterns only.');
if (findings.length) {
    console.error(findings.join('\n'));
    console.error(`\n${findings.length} finding(s). Remove them before committing.`);
    process.exit(1);
}
console.log(`Clean: ${files.length} files checked against ${SECRET_PATTERNS.length} credential patterns and ${terms.length} private terms.`);
