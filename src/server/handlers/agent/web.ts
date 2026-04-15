import { logger } from '../../logger';

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
    return decodeHtmlEntities(
        html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\r/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim(),
    );
}

function htmlToMarkdown(html: string, sourceUrl: string): string {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripTags(titleMatch[1]) : sourceUrl;
    const body = stripTags(html).slice(0, 12000);
    return `# ${title}\n\nSource: ${sourceUrl}\n\n${body}`.trim();
}

function decodeDuckDuckGoHref(href: string): string {
    try {
        const url = new URL(href, 'https://duckduckgo.com');
        const uddg = url.searchParams.get('uddg');
        return uddg ? decodeURIComponent(uddg) : url.toString();
    } catch {
        return href;
    }
}

export async function performWebFetch(url: string): Promise<{ url: string; markdown: string }> {
    const response = await fetch(url, {
        headers: {
            'user-agent': 'ccursor-server/0.1 (+web_fetch)',
            'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
    });

    if (!response.ok) {
        throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
    }

    const finalUrl = response.url || url;
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    if (contentType.includes('text/html') || /^<!doctype html/i.test(text) || /<html[\s>]/i.test(text)) {
        return { url: finalUrl, markdown: htmlToMarkdown(text, finalUrl) };
    }

    return {
        url: finalUrl,
        markdown: `# ${finalUrl}\n\n\`\`\`\n${text.slice(0, 12000)}\n\`\`\``,
    };
}

export async function performWebSearch(searchTerm: string): Promise<Array<{ title: string; url: string; chunk: string }>> {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchTerm)}`;
    const response = await fetch(searchUrl, {
        headers: {
            'user-agent': 'ccursor-server/0.1 (+web_search)',
            'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
    });

    if (!response.ok) {
        throw new Error(`search failed: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const references: Array<{ title: string; url: string; chunk: string }> = [];

    const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,1200}?(?:<a[^>]+class="result__snippet"[^>]*>|<div[^>]+class="result__snippet"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi;
    let match: RegExpExecArray | null;
    while ((match = resultRegex.exec(html)) && references.length < 5) {
        const href = decodeDuckDuckGoHref(match[1]);
        const title = stripTags(match[2]);
        const chunk = stripTags(match[3]).slice(0, 400);
        if (title && href) {
            references.push({ title, url: href, chunk });
        }
    }

    if (references.length === 0) {
        const fallbackRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((match = fallbackRegex.exec(html)) && references.length < 5) {
            const href = decodeDuckDuckGoHref(match[1]);
            const title = stripTags(match[2]);
            if (!href.startsWith('http')) continue;
            if (!title || title.length < 3) continue;
            references.push({ title, url: href, chunk: '' });
        }
    }

    logger.info({ searchTerm, results: references.length }, '[TOOL] web search completed');
    return references;
}
