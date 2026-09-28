/**
 * Where a visit came from, in the groups writers think in. PostHog traffic and
 * the signups recorded here are sorted by the same rules, so the numbers line up.
 */
export type Channel = 'search' | 'ai' | 'social' | 'email' | 'site' | 'blog' | 'direct' | 'other';

export interface Origin {
    /** The referring domain; empty or "$direct" when there was none. */
    referrer?: string | null;
    /** The referrer was another page of the blog itself. */
    internal?: boolean;
    utmSource?: string | null;
    utmMedium?: string | null;
}

const AI = [
    'chatgpt.com',
    'chat.openai.com',
    'openai.com',
    'perplexity.ai',
    'claude.ai',
    'gemini.google.com',
    'bard.google.com',
    'copilot.microsoft.com',
    'copilot.cloud.microsoft',
    'm365.cloud.microsoft',
    'you.com',
    'phind.com',
    'poe.com',
    'deepseek.com',
    'grok.com',
    'meta.ai',
    'chat.mistral.ai',
    'duck.ai',
    'pi.ai',
    'character.ai',
    'kimi.com',
    'chat.qwen.ai'
];
const AI_TAGS = ['chatgpt', 'chatgpt.com', 'openai', 'perplexity', 'perplexity.ai', 'claude', 'claude.ai', 'gemini', 'copilot', 'you.com', 'phind', 'grok', 'deepseek', 'mistral', 'meta.ai'];

const SEARCH = [
    'bing.com',
    'duckduckgo.com',
    'search.yahoo.com',
    'yahoo.com',
    'yandex.ru',
    'yandex.com',
    'ya.ru',
    'baidu.com',
    'ecosia.org',
    'search.brave.com',
    'startpage.com',
    'qwant.com',
    'naver.com',
    'seznam.cz',
    'kagi.com',
    'search.aol.com',
    'ask.com',
    'sogou.com',
    'so.com',
    'yep.com',
    'mojeek.com',
    'com.google.android.googlequicksearchbox'
];
// Google's other products are not search.
const GOOGLE_NOT_SEARCH = /^(mail|accounts|docs|drive|gemini|bard|calendar|meet|chat|groups|sites|play|support|developers|cloud|console|photos|translate|workspace|analytics)\./;
const SEARCH_TAGS = ['google', 'bing', 'duckduckgo', 'yahoo', 'yandex', 'baidu', 'ecosia', 'brave', 'kagi'];

const SOCIAL = [
    'x.com',
    'twitter.com',
    't.co',
    'com.twitter.android',
    'linkedin.com',
    'lnkd.in',
    'com.linkedin.android',
    'facebook.com',
    'fb.com',
    'instagram.com',
    'reddit.com',
    'com.reddit.frontpage',
    'news.ycombinator.com',
    'youtube.com',
    'youtu.be',
    'threads.net',
    'threads.com',
    'bsky.app',
    'mastodon.social',
    'tiktok.com',
    'pinterest.com',
    'discord.com',
    'discord.gg',
    'discordapp.com',
    'slack.com',
    't.me',
    'telegram.org',
    'org.telegram.messenger',
    'whatsapp.com',
    'producthunt.com',
    'quora.com',
    'lobste.rs',
    'weibo.com',
    'vk.com',
    'tumblr.com'
];
const SOCIAL_TAGS = [
    'x',
    'twitter',
    'linkedin',
    'facebook',
    'fb',
    'instagram',
    'ig',
    'reddit',
    'hn',
    'hackernews',
    'youtube',
    'threads',
    'bluesky',
    'bsky',
    'mastodon',
    'tiktok',
    'discord',
    'slack',
    'telegram',
    'whatsapp',
    'producthunt'
];

const MAIL = [
    'mail.google.com',
    'com.google.android.gm',
    'outlook.live.com',
    'outlook.office.com',
    'outlook.office365.com',
    'com.microsoft.office.outlook',
    'mail.yahoo.com',
    'com.yahoo.mobile.client.android.mail',
    'mail.aol.com',
    'mail.proton.me',
    'app.hey.com',
    'fastmail.com',
    'mail.zoho.com',
    'mail.yandex.ru',
    'e.mail.ru',
    'superhuman.com'
];
const MAIL_TAGS = ['email', 'e-mail', 'mail', 'newsletter'];

/** Friendlier names for the sources people see most, and the app ids mobile apps send. */
const NAMES: Record<string, string> = {
    'com.google.android.gm': 'Gmail app',
    'mail.google.com': 'Gmail',
    'com.google.android.googlequicksearchbox': 'Google app',
    't.co': 'x.com',
    'twitter.com': 'x.com',
    'com.twitter.android': 'x.com',
    'lnkd.in': 'linkedin.com',
    'com.linkedin.android': 'linkedin.com',
    'com.reddit.frontpage': 'reddit.com',
    'org.telegram.messenger': 'telegram',
    't.me': 'telegram',
    'news.ycombinator.com': 'Hacker News',
    'com.microsoft.office.outlook': 'Outlook',
    'outlook.live.com': 'Outlook',
    'outlook.office.com': 'Outlook',
    'outlook.office365.com': 'Outlook',
    'com.yahoo.mobile.client.android.mail': 'Yahoo Mail',
    'mail.yahoo.com': 'Yahoo Mail',
    'chat.openai.com': 'chatgpt.com',
    'bing.com': 'Bing',
    'duckduckgo.com': 'DuckDuckGo'
};

const within = (domain: string, list: string[]) => list.some(d => domain === d || domain.endsWith(`.${d}`));

/** "www.Example.com" and "$direct" become "example.com" and "". */
export function cleanDomain(v: string | null | undefined): string {
    const d = String(v ?? '')
        .trim()
        .toLowerCase();
    return d === '$direct' ? '' : d.replace(/^(www|m|l|lm|out|old|mobile)\./, '');
}

/**
 * The domain your own site lives under, e.g. "example.com" for a blog at
 * example.com/blog or blog.example.com: visits from its other pages (your
 * product) are their own group.
 */
export function siteRoot(host: string): string {
    const parts = host
        .toLowerCase()
        .replace(/^www\./, '')
        .split('.');
    if (parts.length <= 2) return parts.join('.');
    // example.co.uk and the like keep three labels.
    const short = parts[parts.length - 1].length === 2 && /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2]);
    return parts.slice(short ? -3 : -2).join('.');
}

/** The group a visit belongs to and the name to show for its source. */
export function classify(origin: Origin, root: string): { channel: Channel; source: string } {
    if (origin.internal) return { channel: 'blog', source: 'Blog pages' };
    const domain = cleanDomain(origin.referrer);
    const tag = String(origin.utmSource ?? '')
        .trim()
        .toLowerCase();
    const medium = String(origin.utmMedium ?? '')
        .trim()
        .toLowerCase();
    const name = NAMES[domain] ?? domain;

    // Links in this blog's own newsletters carry these tags.
    if (tag === 'email' && medium === 'newsletter') return { channel: 'email', source: 'Your newsletter' };
    if (MAIL_TAGS.includes(medium) || MAIL_TAGS.includes(tag) || within(domain, MAIL) || domain.startsWith('newsletter.')) return { channel: 'email', source: domain ? name : tag || medium };
    if (within(domain, AI) || AI_TAGS.includes(tag)) return { channel: 'ai', source: domain ? name : tag };
    if (/(^|\.)google\.[a-z.]{2,6}$/.test(domain) && !GOOGLE_NOT_SEARCH.test(domain)) return { channel: 'search', source: 'Google' };
    if (within(domain, SEARCH)) return { channel: 'search', source: name };
    if (within(domain, SOCIAL)) return { channel: 'social', source: name };
    if (root && (domain === root || domain.endsWith(`.${root}`))) return { channel: 'site', source: domain };
    if (!domain && SEARCH_TAGS.includes(tag)) return { channel: 'search', source: tag === 'google' ? 'Google' : tag };
    if (!domain && SOCIAL_TAGS.includes(tag)) return { channel: 'social', source: tag === 'twitter' || tag === 'x' ? 'x.com' : tag };
    if (!domain) return tag ? { channel: 'other', source: tag } : { channel: 'direct', source: 'Direct' };
    return { channel: 'other', source: name };
}

export interface ChannelRow {
    channel: Channel;
    visits: number;
    visitors: number;
    sources: { source: string; visits: number; visitors: number }[];
}

/**
 * Sums classified rows into groups, biggest first, each with its top sources.
 * Visitors add up per row, so someone who came twice, two ways, counts in both.
 */
export function groupChannels(rows: { origin: Origin; visits: number; visitors: number }[], root: string): ChannelRow[] {
    const groups = new Map<Channel, Map<string, { visits: number; visitors: number }>>();
    for (const r of rows) {
        const { channel, source } = classify(r.origin, root);
        const sources = groups.get(channel) ?? new Map<string, { visits: number; visitors: number }>();
        const s = sources.get(source) ?? { visits: 0, visitors: 0 };
        s.visits += r.visits;
        s.visitors += r.visitors;
        sources.set(source, s);
        groups.set(channel, sources);
    }
    return [...groups]
        .map(([channel, sources]) => {
            const list = [...sources].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.visits - a.visits);
            return { channel, visits: list.reduce((n, s) => n + s.visits, 0), visitors: list.reduce((n, s) => n + s.visitors, 0), sources: list.slice(0, 25) };
        })
        .sort((a, b) => b.visits - a.visits);
}
