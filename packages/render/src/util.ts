export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** CDATA cannot contain "]]>"; split it across two sections. */
export function cdata(s: string): string {
    return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function plainText(html: string): string {
    return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

export function wordCount(html: string): number {
    const text = plainText(html);
    return text ? text.split(' ').length : 0;
}

/** Reading time at 265 words a minute plus 12 seconds per image, as most publishers count it. */
export function readingMinutes(html: string): number {
    const images = (html.match(/<img\b/gi) ?? []).length;
    const seconds = (wordCount(html) / 265) * 60 + images * 12;
    return Math.max(1, Math.round(seconds / 60));
}

/** First sentences of the body, cut at a word boundary. */
export function autoExcerpt(html: string, max = 200): string {
    const text = plainText(html);
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 0)).replace(/[,;:.\s]+$/, '')}…`;
}

/** True for a description a tool cut short (it ends in an ellipsis). */
export function isTruncated(s: string): boolean {
    return /(…|\.\.\.)\s*$/.test(s.trim());
}

/**
 * A description that reads as whole sentences: the opening sentences that fit in `max`
 * characters, or a word-boundary cut when the first sentence alone is longer.
 */
export function sentenceSummary(html: string, max = 200): string {
    const text = plainText(html);
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    return end >= 60 ? cut.slice(0, end + 1) : autoExcerpt(html, max);
}

export function rfc822(iso: string): string {
    return new Date(iso).toUTCString();
}

/** "/blog/my-post/" -> "blog/my-post/index.html" */
export function fileFor(urlPath: string, index = 'index.html'): string {
    const clean = urlPath.replace(/^\/+/, '');
    return clean.endsWith('/') || clean === '' ? `${clean}${index}` : clean;
}

/**
 * Adds ?param=value to outbound links in a rendered body. Links into the blog
 * itself, and links that already carry ref, source or utm_source, are left alone.
 */
/**
 * Links to the site's own pages open in place and pass on their value. The editor used to save every link
 * with target="_blank" and rel="noopener noreferrer nofollow", which tells search engines not to follow them.
 */
export function ownLinks(html: string, siteUrl: string): string {
    const origin = new URL(siteUrl).origin;
    return html.replace(/<a\b[^>]*>/gi, tag => {
        const href = /\bhref="([^"]*)"/i.exec(tag)?.[1] ?? '';
        const own = (href.startsWith('/') && !href.startsWith('//')) || href.startsWith('#') || href === origin || href.startsWith(`${origin}/`);
        return own ? tag.replace(/\s+target="_blank"/i, '').replace(/\s+rel="[^"]*"/i, '') : tag;
    });
}

export function tagLinks(html: string, siteUrl: string, tag?: { param: string; value: string }): string {
    if (!tag) return html;
    return html.replace(/(<a\b[^>]*?\bhref=")(https?:\/\/[^"]+)(")/gi, (whole, pre: string, href: string, post: string) => {
        const raw = href.replace(/&amp;/g, '&');
        if (raw.startsWith(siteUrl)) return whole;
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            return whole;
        }
        if (['ref', 'source', 'utm_source'].some(k => url.searchParams.has(k))) return whole;
        // Append to the query as written, so existing parameters keep their exact encoding.
        const pair = `${encodeURIComponent(tag.param)}=${encodeURIComponent(tag.value)}`;
        url.search = url.search ? `${url.search}&${pair}` : `?${pair}`;
        return `${pre}${url.href}${post}`;
    });
}

/** A short content hash (FNV-1a), used to version asset URLs so they can be cached for good. */
export function shortHash(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}
