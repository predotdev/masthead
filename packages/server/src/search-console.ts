/**
 * Google Search Console, for the admin's Analytics: the searches that bring
 * readers to the blog's pages (only pages under SITE_URL), in total and per
 * post, and the posts worth working on. A service account signs its own token
 * (RS256 with WebCrypto) and reads the property's Search Analytics. Answers
 * are kept like PostHog's (posthog.ts): shown at once, refreshed behind the
 * scenes. Search Console finalizes a day two to three days late, so every
 * range ends on the last final day, in Google's time zone (Pacific).
 */
import { siteRoot } from './channels';
import { siteSettings } from './content';
import type { Ctx, Env } from './env';
import { cached, type Cached } from './posthog';
import { basePath } from './publish';
import { makeRange, type Range, type RangeKey } from './stats';
import { b64url } from './util';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://searchconsole.googleapis.com/';
/** Search Console changes once a day at most: an answer is fresh for an hour. */
const FRESH_MS = 60 * 60_000;
/** Search Console keeps 16 months. */
const KEEP_DAYS = 486;
const DAY = 86_400_000;

// ---------------------------------------------------------------- setup

interface ServiceAccount {
    client_email: string;
    private_key: string;
    private_key_id?: string;
    project_id?: string;
}

export interface SearchSetup {
    /** GOOGLE_SERVICE_ACCOUNT is set. */
    key: boolean;
    /** Why it could not be read, when it is set but is not a service account key. */
    keyError: string | null;
    /** The service account's address: the user to add in Search Console. */
    email: string | null;
    /** The Google Cloud project the key belongs to, where the API is turned on. */
    project: string | null;
    /** GSC_PROPERTY. */
    property: string | null;
    /** GSC_PROPERTY for SITE_URL's domain. */
    suggested: string;
    /** Where to turn the Search Console API on for that project. */
    enableUrl: string | null;
    /** Requests go to a local stand-in (GSC_API_BASE). */
    local: boolean;
}

type KeyRead = { account?: ServiceAccount; error?: string };
let parsed: { raw: string; read: KeyRead } | null = null;

/** The key as raw JSON, or base64 of it (either alphabet, any line breaks). Read once per value. */
function readKey(raw: string | undefined): KeyRead {
    const text = (raw ?? '').trim();
    if (!text) return {};
    if (parsed?.raw !== text) parsed = { raw: text, read: parseKey(text) };
    return parsed.read;
}

function parseKey(text: string): KeyRead {
    let json = text;
    if (!text.startsWith('{')) {
        try {
            const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
            json = new TextDecoder().decode(Uint8Array.from(atob(clean + '='.repeat((4 - (clean.length % 4)) % 4)), c => c.charCodeAt(0)));
        } catch {
            return { error: 'GOOGLE_SERVICE_ACCOUNT is neither JSON nor base64 of it.' };
        }
    }
    let data: any;
    try {
        data = JSON.parse(json);
    } catch {
        return { error: 'GOOGLE_SERVICE_ACCOUNT is not valid JSON.' };
    }
    if (data?.type !== 'service_account' || typeof data.client_email !== 'string' || typeof data.private_key !== 'string')
        return { error: 'GOOGLE_SERVICE_ACCOUNT is not a service account key: it needs the JSON key file, with client_email and private_key.' };
    return { account: data as ServiceAccount };
}

/** GSC_API_BASE, only when it points at this machine: a real token is never sent to another host. */
function localBase(env: Env): string | null {
    const v = env.GSC_API_BASE?.trim();
    if (!v) return null;
    try {
        const u = new URL(v);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
        return u.href.endsWith('/') ? u.href : `${u.href}/`;
    } catch {
        return null;
    }
}

export function searchSetup(env: Env): SearchSetup {
    const { account, error } = readKey(env.GOOGLE_SERVICE_ACCOUNT);
    return {
        key: Boolean(env.GOOGLE_SERVICE_ACCOUNT?.trim()),
        keyError: error ?? null,
        email: account?.client_email ?? null,
        project: account?.project_id ?? null,
        property: env.GSC_PROPERTY?.trim() || null,
        suggested: `sc-domain:${siteRoot(new URL(env.SITE_URL).hostname)}`,
        enableUrl: account?.project_id ? enableUrl(account.project_id) : null,
        local: Boolean(localBase(env))
    };
}

export const searchReady = (s: SearchSetup) => s.key && !s.keyError && Boolean(s.property);

/** A failure as the admin shows it: blocked (Google refuses, and why) or error (try again later). */
export function searchFailure(err: unknown, setup: SearchSetup): { status: 'blocked'; setup: SearchSetup; problem: SearchProblem } | { status: 'error'; setup: SearchSetup; error: string } {
    if (err instanceof SearchError && err.problem.kind !== 'quota' && err.problem.kind !== 'unavailable') return { status: 'blocked', setup, problem: err.problem };
    if (!(err instanceof SearchError)) console.error('search console', err);
    return { status: 'error', setup, error: err instanceof SearchError ? err.problem.message : 'Search Console did not answer.' };
}

// ---------------------------------------------------------------- when Google says no

export interface SearchProblem {
    /**
     * key: the secret cannot be used; token: Google refused the key; api: the Search Console API
     * is off in the key's project; access: the account is not a user on the property (or the
     * property is wrong); quota, unavailable: try again later.
     */
    kind: 'key' | 'token' | 'api' | 'access' | 'quota' | 'unavailable';
    /** Google's own words. */
    message: string;
    /** The project Google named (its number), or the key's project id. */
    project?: string;
    /** Where to turn the API on. */
    enableUrl?: string;
}

export class SearchError extends Error {
    constructor(readonly problem: SearchProblem) {
        super(problem.message);
    }
}

/** The Google Cloud page with the API's Enable button, for a project id or number. */
export const enableUrl = (project: string) => `https://console.cloud.google.com/apis/library/searchconsole.googleapis.com?project=${encodeURIComponent(project)}`;

function explain(status: number, text: string, project: string | undefined): SearchProblem {
    let e: any = {};
    try {
        e = JSON.parse(text)?.error ?? {};
    } catch {
        // Not JSON: a proxy or an outage page.
    }
    const message = (typeof e === 'string' ? e : String(e.message ?? text ?? '')).replace(/\s+/g, ' ').trim().slice(0, 500) || `HTTP ${status}`;
    const details: any[] = Array.isArray(e.details) ? e.details : [];
    const info = details.find(d => String(d?.['@type'] ?? '').endsWith('google.rpc.ErrorInfo'));
    const reasons = [info?.reason, ...(Array.isArray(e.errors) ? e.errors.map((x: any) => x?.reason) : [])].filter(Boolean).map(String);
    if (reasons.includes('SERVICE_DISABLED') || reasons.includes('accessNotConfigured') || /API has not been used in project/i.test(message)) {
        const named = String(info?.metadata?.consumer ?? '').replace(/^projects\//, '') || message.match(/in project (\d+)/)?.[1] || project;
        return { kind: 'api', message, project: named, enableUrl: named ? enableUrl(named) : undefined };
    }
    if (status === 429 || reasons.some(r => /rate|quota/i.test(r))) return { kind: 'quota', message: `It is limiting requests for a few minutes (${message.replace(/\.$/, '')}).` };
    if (status === 401) return { kind: 'token', message };
    // 403 "User does not have sufficient permission for site": not a user yet, or no such property.
    if (status === 403 || status === 404 || (status === 400 && /site|property|url/i.test(message))) return { kind: 'access', message };
    return { kind: 'unavailable', message: `Search Console answered ${status}: ${message}` };
}

// ---------------------------------------------------------------- the token

const signers = new Map<string, Promise<CryptoKey>>();
const tokens = new Map<string, { token: string; until: number }>();

function signer(sa: ServiceAccount): Promise<CryptoKey> {
    const id = `${sa.client_email}|${sa.private_key_id ?? ''}|${sa.private_key.length}`;
    let key = signers.get(id);
    if (!key) {
        const body = sa.private_key.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
        key = Promise.resolve()
            .then(() => crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(body), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']))
            .catch(() => {
                signers.delete(id);
                throw new SearchError({ kind: 'key', message: 'The private key in GOOGLE_SERVICE_ACCOUNT could not be read. Download a new JSON key for the service account.' });
            });
        signers.set(id, key);
    }
    return key;
}

/** An access token for the service account, kept until a minute before it expires. */
async function accessToken(env: Env, fresh = false): Promise<string> {
    const { account: sa, error } = readKey(env.GOOGLE_SERVICE_ACCOUNT);
    if (!sa) throw new SearchError({ kind: 'key', message: error ?? 'GOOGLE_SERVICE_ACCOUNT is not set.' });
    const local = localBase(env);
    const url = local ? `${local}token` : TOKEN_URL;
    const id = `${sa.client_email}|${url}`;
    const hit = tokens.get(id);
    if (hit && !fresh && hit.until > Date.now() + 60_000) return hit.token;
    const now = Math.floor(Date.now() / 1000);
    const enc = new TextEncoder();
    const part = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) })}.${part({ iss: sa.client_email, scope: SCOPE, aud: url, iat: now, exp: now + 3600 })}`;
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signer(sa), enc.encode(unsigned)));
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }),
        signal: AbortSignal.timeout(15_000)
    }).catch(err => {
        throw new SearchError({ kind: 'unavailable', message: `Could not reach Google to sign in: ${err?.message ?? err}` });
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
        if (res.status >= 500) throw new SearchError({ kind: 'unavailable', message: `Google's sign-in answered ${res.status}. Try again in a few minutes.` });
        // invalid_grant: the key was deleted or the account disabled; a clock far off also lands here.
        throw new SearchError({ kind: 'token', message: `Google refused the service account key: ${String(data.error_description || data.error || `HTTP ${res.status}`).replace(/\.$/, '')}.` });
    }
    tokens.set(id, { token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 });
    return data.access_token;
}

// ---------------------------------------------------------------- Search Analytics

type Dimension = 'date' | 'query' | 'page' | 'country' | 'device';

interface Row {
    keys?: string[];
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
}

interface Client {
    env: Env;
    api: string;
    property: string;
    project?: string;
    /** Pages under SITE_URL: its host, with or without www, over http or https. */
    pages: string;
}

async function client(env: Env): Promise<Client> {
    const property = env.GSC_PROPERTY?.trim();
    if (!property) throw new SearchError({ kind: 'key', message: 'GSC_PROPERTY is not set.' });
    await accessToken(env);
    const site = new URL(env.SITE_URL);
    return {
        env,
        api: localBase(env) ?? API,
        property,
        project: readKey(env.GOOGLE_SERVICE_ACCOUNT).account?.project_id,
        pages: `^https?://(www\\.)?${escapeRe(site.hostname.replace(/^www\./, ''))}${escapeRe(basePath(env))}`
    };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One Search Analytics query: web search, final data, pages under the blog (or `page`, a pattern for one post). */
async function query(c: Client, dimensions: Dimension[], from: string, to: string, opts: { page?: string; rows?: number } = {}): Promise<Row[]> {
    const body = JSON.stringify({
        startDate: from,
        endDate: to,
        dimensions,
        type: 'web',
        dataState: 'final',
        dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'includingRegex', expression: opts.page ?? c.pages }] }],
        rowLimit: opts.rows ?? 1000
    });
    const url = `${c.api}webmasters/v3/sites/${encodeURIComponent(c.property)}/searchAnalytics/query`;
    let expired = false;
    for (let attempt = 0; ; attempt++) {
        const token = await accessToken(c.env, expired);
        const res = await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(25_000)
        }).catch(err => {
            throw new SearchError({ kind: 'unavailable', message: `Could not reach Search Console: ${err?.message ?? err}` });
        });
        if (res.ok) return (((await res.json()) as { rows?: Row[] }).rows ?? []).filter(r => r.impressions > 0 || r.clicks > 0);
        const problem = explain(res.status, await res.text(), c.project);
        // One more try: a token that expired early, a busy minute, a hiccup.
        if (attempt === 0 && (res.status === 401 || problem.kind === 'quota' || res.status >= 500)) {
            expired = res.status === 401;
            if (!expired) await new Promise(r => setTimeout(r, 1200));
            continue;
        }
        throw new SearchError(problem);
    }
}

// ---------------------------------------------------------------- numbers

export interface Metrics {
    clicks: number;
    impressions: number;
    /** Clicks per impression; null without impressions. */
    ctr: number | null;
    /** Average position of the top result from the blog, weighted by impressions (1 is the top). */
    position: number | null;
}

interface Sum {
    clicks: number;
    impressions: number;
    /** Position times impressions, so averages over rows stay exact. */
    weighted: number;
}

const zero = (): Sum => ({ clicks: 0, impressions: 0, weighted: 0 });
function add(s: Sum, r: { clicks: number; impressions: number; position: number }): Sum {
    s.clicks += r.clicks;
    s.impressions += r.impressions;
    s.weighted += r.position * r.impressions;
    return s;
}
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
function metrics(s: Sum): Metrics {
    return { clicks: s.clicks, impressions: s.impressions, ctr: s.impressions ? round(s.clicks / s.impressions, 5) : null, position: s.impressions ? round(s.weighted / s.impressions, 2) : null };
}

/**
 * The share of searchers who click a result at each position, 1 to 20: a
 * middle-of-the-road curve for articles. Estimates of clicks to gain use it.
 */
const CURVE = [0.27, 0.15, 0.1, 0.07, 0.052, 0.04, 0.031, 0.025, 0.021, 0.018, 0.013, 0.011, 0.01, 0.009, 0.008, 0.0072, 0.0065, 0.006, 0.0055, 0.005];
export function typicalCtr(position: number): number {
    if (!(position > 1)) return CURVE[0];
    if (position >= 20) return Math.max(0.001, (0.005 * 20) / position);
    const i = Math.floor(position) - 1;
    return CURVE[i] + (CURVE[i + 1] - CURVE[i]) * (position - Math.floor(position));
}

// ---------------------------------------------------------------- days

const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Search Console's days are Pacific time. */
const today = () => pacific.format(new Date());
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export interface SearchRange extends Range {
    /** The first and last day shown, and the period before (Search Console's days). */
    first: string;
    last: string;
    prevFirst: string | null;
    prevLast: string | null;
}

/**
 * The last final day: the newest day with data, normally two or three days ago. A small site
 * with no rows lately gets three days ago, so a quiet week never pulls the range back.
 */
function lastFinal(dayRows: Row[], now: string): string {
    const newest = dayRows.reduce((m, r) => (r.keys?.[0] && r.keys[0] > m ? r.keys[0] : m), '');
    if (newest && newest >= addDays(now, -5)) return newest < addDays(now, -1) ? newest : addDays(now, -1);
    return addDays(now, -3);
}

/** The same shapes as the rest of Analytics (stats.ts), ending on `last`. All time is what Search Console keeps, from the first day with data. */
function rangeFor(key: RangeKey, last: string, first: string | null): SearchRange {
    const oldest = addDays(last, -(KEEP_DAYS - 1));
    const r = makeRange(key, key === 'all' ? (first && first > oldest ? first : oldest) : null, new Date(`${last}T12:00:00Z`));
    const firstDay = key === 'all' ? (first && first > oldest ? first : oldest) : r.buckets[0];
    const prevLast = r.days ? addDays(firstDay, -1) : null;
    return {
        ...r,
        start: `${firstDay}T00:00:00.000Z`,
        end: `${addDays(last, 1)}T00:00:00.000Z`,
        prevStart: prevLast && r.days ? `${addDays(prevLast, -(r.days - 1))}T00:00:00.000Z` : null,
        prevEnd: r.days ? `${firstDay}T00:00:00.000Z` : null,
        first: firstDay,
        last,
        prevFirst: prevLast && r.days ? addDays(prevLast, -(r.days - 1)) : null,
        prevLast
    };
}

/** Daily rows summed into the range's buckets (days, weeks or months). */
function series(dayRows: Row[], buckets: string[] | null, unit: Range['unit'], from: string | null, to: string | null): (Metrics & { bucket: string })[] | null {
    if (!buckets || !from || !to) return null;
    const at = new Map(buckets.map((b, i) => [b, i]));
    const sums = buckets.map(zero);
    for (const r of dayRows) {
        const day = r.keys?.[0] ?? '';
        if (day < from || day > to) continue;
        const i = at.get(bucketStart(day, unit));
        if (i !== undefined) add(sums[i], r);
    }
    return buckets.map((bucket, i) => ({ bucket, ...metrics(sums[i]) }));
}

function bucketStart(day: string, unit: Range['unit']): string {
    if (unit === 'day') return day;
    if (unit === 'month') return `${day.slice(0, 7)}-01`;
    const d = new Date(`${day}T00:00:00Z`);
    return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
}

function totals(dayRows: Row[], from: string | null, to: string | null): Metrics | null {
    if (!from || !to) return null;
    const s = zero();
    for (const r of dayRows) if (r.keys?.[0] && r.keys[0] >= from && r.keys[0] <= to) add(s, r);
    return metrics(s);
}

// ---------------------------------------------------------------- pages and posts

/** A result's address as the blog knows it: no jump-to-section fragment, query string or Ghost's /amp/ copy. */
function pathOf(url: string, base: string): string | null {
    let path: string;
    try {
        path = new URL(url).pathname;
    } catch {
        return null;
    }
    if (!path.startsWith(base)) return null;
    let rest = path.slice(base.length);
    const amp = rest.match(/^([^/]+)\/amp\/?$/);
    if (amp) rest = `${amp[1]}/`;
    if (rest && !rest.endsWith('/') && !/\.[a-z0-9]+$/i.test(rest)) rest += '/';
    return base + rest;
}

/** The slug of a post or page address ("<base><slug>/"), else null (the front page, tags, authors). */
function slugOf(path: string, base: string): string | null {
    const rest = path.slice(base.length).replace(/\/$/, '');
    return rest && !rest.includes('/') && !/\.[a-z0-9]+$/i.test(rest) ? decodeURIComponent(rest) : null;
}

export interface PostRef {
    id: string;
    slug: string;
    title: string;
    type: string;
    status: string;
    metaTitle: string | null;
    metaDescription: string | null;
    excerpt: string | null;
    authors: string[];
}

/** Posts and pages by slug, with what a search result shows of them. */
export async function postRefs(db: D1Database, slugs: string[]): Promise<Record<string, PostRef>> {
    const out: Record<string, PostRef> = {};
    const unique = [...new Set(slugs)];
    // D1 allows 100 bound values per statement.
    for (let i = 0; i < unique.length; i += 90) {
        const chunk = unique.slice(i, i + 90);
        const { results } = await db
            .prepare(
                `SELECT p.id, p.slug, p.title, p.type, p.status, p.meta_title, p.meta_description, p.custom_excerpt,
                   (SELECT group_concat(a.staff_id) FROM post_authors a WHERE a.post_id = p.id) AS authors
                 FROM posts p WHERE p.slug IN (${chunk.map(() => '?').join(',')})`
            )
            .bind(...chunk)
            .all<any>();
        for (const r of results)
            out[r.slug] = {
                id: r.id,
                slug: r.slug,
                title: r.title,
                type: r.type,
                status: r.status,
                metaTitle: r.meta_title ?? null,
                metaDescription: r.meta_description ?? null,
                excerpt: r.custom_excerpt ?? null,
                authors: r.authors ? String(r.authors).split(',') : []
            };
    }
    return out;
}

// ---------------------------------------------------------------- countries

// ISO 3166-1 alpha-3 (what Search Console names) to alpha-2 (flags, Intl.DisplayNames): five letters per country.
const ISO3 =
    'AFGAF ALAAX ALBAL DZADZ ASMAS ANDAD AGOAO AIAAI ATAAQ ATGAG ARGAR ARMAM ABWAW AUSAU AUTAT AZEAZ BHSBS BHRBH BGDBD BRBBB BLRBY BELBE BLZBZ BENBJ BMUBM BTNBT BOLBO BESBQ BIHBA BWABW BVTBV BRABR IOTIO BRNBN BGRBG BFABF BDIBI CPVCV KHMKH CMRCM CANCA CYMKY CAFCF TCDTD CHLCL CHNCN CXRCX CCKCC COLCO COMKM COGCG CODCD COKCK CRICR CIVCI HRVHR CUBCU CUWCW CYPCY CZECZ DNKDK DJIDJ DMADM DOMDO ECUEC EGYEG SLVSV GNQGQ ERIER ESTEE SWZSZ ETHET FLKFK FROFO FJIFJ FINFI FRAFR GUFGF PYFPF ATFTF GABGA GMBGM GEOGE DEUDE GHAGH GIBGI GRCGR GRLGL GRDGD GLPGP GUMGU GTMGT GGYGG GINGN GNBGW GUYGY HTIHT HMDHM VATVA HNDHN HKGHK HUNHU ISLIS INDIN IDNID IRNIR IRQIQ IRLIE IMNIM ISRIL ITAIT JAMJM JPNJP JEYJE JORJO KAZKZ KENKE KIRKI PRKKP KORKR KWTKW KGZKG LAOLA LVALV LBNLB LSOLS LBRLR LBYLY LIELI LTULT LUXLU MACMO MDGMG MWIMW MYSMY MDVMV MLIML MLTMT MHLMH MTQMQ MRTMR MUSMU MYTYT MEXMX FSMFM MDAMD MCOMC MNGMN MNEME MSRMS MARMA MOZMZ MMRMM NAMNA NRUNR NPLNP NLDNL NCLNC NZLNZ NICNI NERNE NGANG NIUNU NFKNF MKDMK MNPMP NORNO OMNOM PAKPK PLWPW PSEPS PANPA PNGPG PRYPY PERPE PHLPH PCNPN POLPL PRTPT PRIPR QATQA REURE ROURO RUSRU RWARW BLMBL SHNSH KNAKN LCALC MAFMF SPMPM VCTVC WSMWS SMRSM STPST SAUSA SENSN SRBRS SYCSC SLESL SGPSG SXMSX SVKSK SVNSI SLBSB SOMSO ZAFZA SGSGS SSDSS ESPES LKALK SDNSD SURSR SJMSJ SWESE CHECH SYRSY TWNTW TJKTJ TZATZ THATH TLSTL TGOTG TKLTK TONTO TTOTT TUNTN TURTR TKMTM TCATC TUVTV UGAUG UKRUA AREAE GBRGB USAUS UMIUM URYUY UZBUZ VUTVU VENVE VNMVN VGBVG VIRVI WLFWF ESHEH YEMYE ZMBZM ZWEZW XKXXK';
let alpha2: Map<string, string> | null = null;
function country(code: string): string {
    alpha2 ??= new Map(ISO3.split(' ').map(p => [p.slice(0, 3), p.slice(3)]));
    return alpha2.get(code.toUpperCase()) ?? '';
}

// ---------------------------------------------------------------- opportunities

export interface Opportunity {
    /**
     * rank: a post on positions 5 to 20 for searches with real demand ("almost page one");
     * snippet: few clicks for its position, so the title and description need work;
     * drop: fewer clicks than the period before; gap: a search no post ranks for.
     */
    kind: 'rank' | 'snippet' | 'drop' | 'gap';
    /** Estimated extra clicks a month. */
    gain: number;
    /** The post (rank, snippet, drop). */
    slug?: string;
    /** The search (gap). */
    query?: string;
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
    /** snippet: what a result at this position usually gets. */
    typicalCtr?: number;
    /** rank: the position the estimate assumes it reaches. */
    target?: number;
    /** drop: the period before, and what changed most. */
    before?: Metrics;
    cause?: 'position' | 'demand' | 'ctr';
    /** The searches behind it, most promising first (the top five), and how many there are. */
    queries?: { query: string; clicks: number; impressions: number; position: number }[];
    searches?: number;
    /** gap: the blog page that ranks best for it today. */
    best?: { path: string; slug: string | null; position: number } | null;
    /** gap: an idea with this title is already waiting. */
    idea?: boolean;
}

const compact = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** Words that make a search about the site itself (for example.com: "example", "example com"): people want the product, not a post. */
function brandTerms(env: Env, title: string): string[] {
    const root = siteRoot(new URL(env.SITE_URL).hostname);
    const terms = new Set([compact(root)]);
    const label = root.split('.')[0];
    if (label.length >= 5) terms.add(compact(label));
    if (compact(title).length >= 5) terms.add(compact(title));
    return [...terms].filter(t => t.length >= 4);
}

/** A search's words without case, punctuation or plural endings, so near-duplicates group together. */
const queryKey = (q: string) =>
    q
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .split(' ')
        .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
        .join(' ');

interface Pair {
    query: string;
    path: string;
    slug: string | null;
    clicks: number;
    impressions: number;
    position: number;
}

function opportunities(o: {
    pairs: Pair[];
    pages: Map<string, { now: Sum; before: Sum | null }>;
    posts: Set<string>;
    base: string;
    brand: string[];
    days: number;
    comparing: boolean;
}): Opportunity[] {
    const perMonth = (n: number) => (n * 30) / o.days;
    const scale = o.days / 30;
    const isBrand = (q: string) => o.brand.some(t => compact(q).includes(t));
    const pureBrand = (q: string) => o.brand.includes(compact(q));
    const byPost = new Map<string, Pair[]>();
    for (const p of o.pairs) {
        if (!p.slug || !o.posts.has(p.slug)) continue;
        const rows = byPost.get(p.slug);
        if (rows) rows.push(p);
        else byPost.set(p.slug, [p]);
    }
    const out: Opportunity[] = [];
    const top = (rows: { p: Pair; score: number }[]) =>
        rows
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map(({ p }) => ({ query: p.query, clicks: p.clicks, impressions: p.impressions, position: round(p.position, 1) }));

    for (const [slug, rows] of byPost) {
        // Almost page one: five to twenty. From the bottom half of page one the estimate assumes the top 3; from page two, the bottom of page one.
        const near = rows.filter(p => p.position >= 5 && p.position < 21 && !pureBrand(p.query));
        const nearSum = near.reduce(add, zero());
        const scored = near.map(p => {
            const target = p.position <= 10.5 ? 3 : 8;
            return { p, target, score: Math.max(0, p.impressions * typicalCtr(target) - p.clicks) };
        });
        const nearGain = perMonth(scored.reduce((n, s) => n + s.score, 0));
        if (nearSum.impressions >= Math.max(30, 40 * scale) && nearGain >= 1) {
            const onPageOne = scored.filter(s => s.target === 3).reduce((n, s) => n + s.score, 0);
            out.push({ kind: 'rank', slug, gain: Math.round(nearGain), ...metrics(nearSum), target: onPageOne >= nearGain / 2 ? 3 : 8, queries: top(scored), searches: near.length });
        }

        // Few clicks for the position: page-one searches that are not about the site itself.
        const shown = rows.filter(p => p.position < 10.5 && !isBrand(p.query));
        const shownSum = shown.reduce(add, zero());
        const expected = shown.reduce((n, p) => n + p.impressions * typicalCtr(p.position), 0);
        if (shownSum.impressions >= Math.max(80, 100 * scale) && expected >= Math.max(5, 6 * scale) && shownSum.clicks < 0.55 * expected) {
            out.push({
                kind: 'snippet',
                slug,
                gain: Math.round(perMonth(expected - shownSum.clicks)),
                ...metrics(shownSum),
                typicalCtr: round(expected / shownSum.impressions, 5),
                queries: top(shown.map(p => ({ p, score: p.impressions * typicalCtr(p.position) - p.clicks }))),
                searches: shown.length
            });
        }
    }

    // Losing clicks: against the period before, with what changed most.
    if (o.comparing)
        for (const [path, { now, before }] of o.pages) {
            const slug = slugOf(path, o.base);
            if (!slug || !o.posts.has(slug) || !before) continue;
            const lost = before.clicks - now.clicks;
            if (before.clicks < Math.max(8, 10 * scale) || now.clicks > 0.75 * before.clicks || lost < Math.max(4, 5 * scale)) continue;
            const was = metrics(before);
            const is = metrics(now);
            const cause = is.position !== null && was.position !== null && is.position - was.position >= 1.5 ? 'position' : now.impressions <= 0.7 * before.impressions ? 'demand' : 'ctr';
            out.push({ kind: 'drop', slug, gain: Math.round(perMonth(lost)), ...is, before: was, cause });
        }

    // Content gaps: searches with demand where no post is in the top 20 and nothing from the blog is on page one.
    const bySearch = new Map<string, { query: string; shown: number; sum: Sum; bestPost: Pair | null; best: Pair | null }>();
    for (const p of o.pairs) {
        if (isBrand(p.query)) continue;
        const k = queryKey(p.query);
        const g = bySearch.get(k) ?? { query: p.query, shown: 0, sum: zero(), bestPost: null, best: null };
        // The version with the most impressions names the group.
        if (p.impressions > g.shown) (g.query = p.query), (g.shown = p.impressions);
        add(g.sum, p);
        if (!g.best || p.position < g.best.position) g.best = p;
        if (p.slug && o.posts.has(p.slug) && (!g.bestPost || p.position < g.bestPost.position)) g.bestPost = p;
        bySearch.set(k, g);
    }
    for (const g of bySearch.values()) {
        if (g.sum.impressions < Math.max(20, 30 * scale)) continue;
        if (g.bestPost && g.bestPost.position <= 20) continue;
        if (g.best && g.best.position <= 10) continue;
        const gain = perMonth(g.sum.impressions * typicalCtr(5) - g.sum.clicks);
        if (gain < 1) continue;
        out.push({
            kind: 'gap',
            query: g.query,
            gain: Math.round(gain),
            ...metrics(g.sum),
            best: g.best ? { path: g.best.path, slug: g.best.slug, position: round(g.best.position, 1) } : null
        });
    }

    // A post that slipped down the page is one story, not two: the drop keeps the searches and the larger estimate.
    for (const drop of out.filter(x => x.kind === 'drop' && x.cause === 'position')) {
        const i = out.findIndex(x => x.kind === 'rank' && x.slug === drop.slug);
        if (i < 0) continue;
        const [rank] = out.splice(i, 1);
        Object.assign(drop, { gain: Math.max(drop.gain, rank.gain), queries: rank.queries, searches: rank.searches });
    }

    // Each kind gets room on the list, then the biggest wins lead.
    const kept: Opportunity[] = [];
    for (const kind of ['rank', 'snippet', 'drop', 'gap'] as const)
        kept.push(
            ...out
                .filter(x => x.kind === kind)
                .sort((a, b) => b.gain - a.gain)
                .slice(0, 15)
        );
    return kept.sort((a, b) => b.gain - a.gain);
}

/** Marks content gaps that already have an idea waiting (added from here, or written by hand). Read fresh, never cached. */
export async function markIdeas(db: D1Database, list: Opportunity[]): Promise<Opportunity[]> {
    if (!list.some(o => o.kind === 'gap')) return list;
    const { results } = await db.prepare("SELECT title FROM ideas WHERE status IN ('new', 'drafted')").all<{ title: string }>();
    const waiting = new Set(results.map(i => queryKey(i.title)));
    return list.map(o => (o.kind === 'gap' && o.query ? { ...o, idea: waiting.has(queryKey(o.query)) } : o));
}

// ---------------------------------------------------------------- the whole blog

export interface SearchData {
    range: SearchRange;
    totals: Metrics;
    prevTotals: Metrics | null;
    series: (Metrics & { bucket: string })[];
    prevSeries: (Metrics & { bucket: string })[] | null;
    queries: (Metrics & { query: string; prevClicks: number | null })[];
    pages: (Metrics & { path: string; slug: string | null; prevClicks: number | null })[];
    countries: (Metrics & { code: string })[];
    devices: (Metrics & { device: string })[];
    opportunities: Opportunity[];
    /** Clicks and impressions from searches Google keeps private (rare or personal ones); null when the list is cut short. */
    hidden: { clicks: number; impressions: number } | null;
}

// A local stand-in's answers never pass for Google's.
const cacheKey = (env: Env, ...parts: string[]) => ['gsc', 'v1', localBase(env) ? 'local' : 'google', env.GSC_PROPERTY?.trim() ?? '', new URL(env.SITE_URL).host, basePath(env), ...parts].join('|');

/** The last final day, per property, for views that cannot tell it from their own rows (one post). */
const lastSeen = new Map<string, { at: number; day: string }>();

async function lastDay(ctx: Ctx, c: Client): Promise<string> {
    const k = cacheKey(ctx.env, 'last');
    const hit = lastSeen.get(k);
    if (hit && Date.now() - hit.at < FRESH_MS) return hit.day;
    const now = today();
    const day = lastFinal(await query(c, ['date'], addDays(now, -8), now, { rows: 20 }), now);
    lastSeen.set(k, { at: Date.now(), day });
    return day;
}

export async function searchStats(ctx: Ctx, key: RangeKey, force = false): Promise<Cached<SearchData>> {
    const env = ctx.env;
    return cached(
        ctx,
        cacheKey(env, 'site', key),
        force,
        async () => {
            const c = await client(env);
            const now = today();
            // Days first: they tell which day is the last final one, and so the range.
            const dayRows = await query(c, ['date'], addDays(now, key === 'all' ? -(KEEP_DAYS + 6) : -(2 * Number(key) + 6)), now, { rows: 1000 });
            const last = lastFinal(dayRows, now);
            lastSeen.set(cacheKey(env, 'last'), { at: Date.now(), day: last });
            const first = dayRows.reduce((m, r) => (r.keys?.[0] && (!m || r.keys[0] < m) ? r.keys[0] : m), '') || null;
            const range = rangeFor(key, last, first);
            const prev = range.prevFirst && range.prevLast ? [range.prevFirst, range.prevLast] : null;
            const base = basePath(env);
            const [queries, prevQueries, pageRows, prevPageRows, countryRows, deviceRows, pairRows, site] = await Promise.all([
                query(c, ['query'], range.first, last, { rows: 1000 }),
                prev ? query(c, ['query'], prev[0], prev[1], { rows: 1000 }) : Promise.resolve(null),
                query(c, ['page'], range.first, last, { rows: 5000 }),
                prev ? query(c, ['page'], prev[0], prev[1], { rows: 5000 }) : Promise.resolve(null),
                query(c, ['country'], range.first, last, { rows: 300 }),
                query(c, ['device'], range.first, last, { rows: 10 }),
                query(c, ['query', 'page'], range.first, last, { rows: 25_000 }),
                siteSettings(env, ctx.db)
            ]);

            // Pages merge under the address the blog knows (jump links and /amp/ copies join their post).
            const pages = new Map<string, { now: Sum; before: Sum | null }>();
            for (const r of pageRows) {
                const path = pathOf(r.keys?.[0] ?? '', base);
                if (!path) continue;
                const p = pages.get(path) ?? { now: zero(), before: null };
                add(p.now, r);
                pages.set(path, p);
            }
            for (const r of prevPageRows ?? []) {
                const path = pathOf(r.keys?.[0] ?? '', base);
                if (!path) continue;
                const p = pages.get(path) ?? { now: zero(), before: null };
                p.before = add(p.before ?? zero(), r);
                pages.set(path, p);
            }
            const pairs: Pair[] = [];
            const merged = new Map<string, Pair>();
            for (const r of pairRows) {
                const path = pathOf(r.keys?.[1] ?? '', base);
                if (!path) continue;
                const k = `${r.keys![0]}\u0000${path}`;
                const m = merged.get(k);
                if (m) {
                    // Averages over rows stay exact: weight positions by impressions.
                    const impressions = m.impressions + r.impressions;
                    m.position = impressions ? (m.position * m.impressions + r.position * r.impressions) / impressions : m.position;
                    m.clicks += r.clicks;
                    m.impressions = impressions;
                } else {
                    const p = { query: r.keys![0], path, slug: slugOf(path, base), clicks: r.clicks, impressions: r.impressions, position: r.position };
                    merged.set(k, p);
                    pairs.push(p);
                }
            }
            const slugs = [...new Set([...pages.keys()].map(p => slugOf(p, base)).filter((s): s is string => Boolean(s)))];
            const known = await postRefs(ctx.db, slugs);
            const tot = totals(dayRows, range.first, last)!;
            const listed = pairRows.reduce((s, r) => add(s, r), zero());
            const prevByQuery = new Map((prevQueries ?? []).map(r => [r.keys?.[0] ?? '', r.clicks]));
            const pageList = [...pages]
                .filter(([, p]) => p.now.impressions > 0)
                .sort((a, b) => b[1].now.clicks - a[1].now.clicks || b[1].now.impressions - a[1].now.impressions)
                .slice(0, 200);
            return {
                range,
                totals: tot,
                prevTotals: totals(dayRows, range.prevFirst, range.prevLast),
                series: series(dayRows, range.buckets, range.unit, range.first, last)!,
                prevSeries: series(dayRows, range.prevBuckets, range.unit, range.prevFirst, range.prevLast),
                queries: queries.slice(0, 200).map(r => ({ query: r.keys?.[0] ?? '', ...metrics(add(zero(), r)), prevClicks: prevQueries ? (prevByQuery.get(r.keys?.[0] ?? '') ?? 0) : null })),
                pages: pageList.map(([path, p]) => ({ path, slug: slugOf(path, base), ...metrics(p.now), prevClicks: prevPageRows ? (p.before?.clicks ?? 0) : null })),
                countries: countryRows.slice(0, 40).map(r => ({ code: country(r.keys?.[0] ?? ''), ...metrics(add(zero(), r)) })),
                devices: deviceRows.map(r => ({ device: (r.keys?.[0] ?? '').toLowerCase(), ...metrics(add(zero(), r)) })),
                opportunities: opportunities({
                    pairs,
                    pages,
                    posts: new Set(Object.values(known).filter(p => p.type === 'post' && p.status === 'published').map(p => p.slug)),
                    base,
                    brand: brandTerms(env, site.title),
                    days: range.days ?? Math.max(1, Math.round((Date.parse(last) - Date.parse(range.first)) / DAY) + 1),
                    comparing: Boolean(prev)
                }),
                hidden: pairRows.length < 25_000 ? { clicks: Math.max(0, tot.clicks - listed.clicks), impressions: Math.max(0, tot.impressions - listed.impressions) } : null
            };
        },
        FRESH_MS
    );
}

// ---------------------------------------------------------------- one post

export interface PostSearchData {
    range: SearchRange;
    totals: Metrics;
    prevTotals: Metrics | null;
    series: (Metrics & { bucket: string })[];
    prevSeries: (Metrics & { bucket: string })[] | null;
    queries: (Metrics & { query: string; prev: Metrics | null })[];
    /** Page-one searches (not about the site itself) and the clicks a result there usually gets. */
    shown: { impressions: number; clicks: number; typicalCtr: number } | null;
}

export async function postSearchStats(ctx: Ctx, post: { slug: string; publishedAt: string | null }, key: RangeKey, force = false): Promise<Cached<PostSearchData>> {
    const env = ctx.env;
    return cached(
        ctx,
        cacheKey(env, 'post', post.slug, key),
        force,
        async () => {
            const c = await client(env);
            const last = await lastDay(ctx, c);
            const published = post.publishedAt ? new Date(post.publishedAt).toISOString().slice(0, 10) : null;
            const range = rangeFor(key, last, published && published < last ? published : null);
            const site = new URL(env.SITE_URL);
            const page = `^https?://(www\\.)?${escapeRe(site.hostname.replace(/^www\./, ''))}${escapeRe(basePath(env))}${escapeRe(post.slug)}(/|/amp/?)?([?#].*)?$`;
            const prev = range.prevFirst && range.prevLast ? [range.prevFirst, range.prevLast] : null;
            const [dayRows, queries, prevQueries, settings] = await Promise.all([
                query(c, ['date'], range.prevFirst ?? range.first, last, { page, rows: 1000 }),
                query(c, ['query'], range.first, last, { page, rows: 500 }),
                prev ? query(c, ['query'], prev[0], prev[1], { page, rows: 500 }) : Promise.resolve(null),
                siteSettings(env, ctx.db)
            ]);
            const before = new Map((prevQueries ?? []).map(r => [r.keys?.[0] ?? '', r]));
            const brand = brandTerms(env, settings.title);
            const shown = queries.filter(r => r.position < 10.5 && !brand.some(t => compact(r.keys?.[0] ?? '').includes(t)));
            const shownSum = shown.reduce(add, zero());
            return {
                range,
                totals: totals(dayRows, range.first, last)!,
                prevTotals: totals(dayRows, range.prevFirst, range.prevLast),
                series: series(dayRows, range.buckets, range.unit, range.first, last)!,
                prevSeries: series(dayRows, range.prevBuckets, range.unit, range.prevFirst, range.prevLast),
                queries: queries.map(r => {
                    const b = before.get(r.keys?.[0] ?? '');
                    return { query: r.keys?.[0] ?? '', ...metrics(add(zero(), r)), prev: prevQueries ? metrics(b ? add(zero(), b) : zero()) : null };
                }),
                shown: shownSum.impressions ? { impressions: shownSum.impressions, clicks: shownSum.clicks, typicalCtr: round(shown.reduce((n, r) => n + r.impressions * typicalCtr(r.position), 0) / shownSum.impressions, 5) } : null
            };
        },
        FRESH_MS
    );
}
