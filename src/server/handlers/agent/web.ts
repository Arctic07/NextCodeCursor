import { convert } from '@vakra-dev/supermarkdown'
import { logger } from '../../logger'

const FETCH_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MARKDOWN_CHARS = 100_000
const CACHE_TTL_MS = 5 * 60_000
const BINARY_TYPES = /^(image|video|audio|application\/pdf|application\/octet-stream|application\/zip)/
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/3.4 Chrome/131.0.0.0 Safari/537.36'

const EXCLUDE_SELECTORS = [
  'nav', 'header', 'footer', 'aside',
  '.sidebar', '.navigation', '.menu', '.nav',
  '.advertisement', '.ads', '#ads', '.ad-container',
  '.related-posts', '.comments', '.social-share',
  'script', 'style', 'noscript', 'iframe',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
]

interface CacheEntry { markdown: string, url: string, expiresAt: number }
const fetchCache = new Map<string, CacheEntry>()

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      return false
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0')
      return false
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host))
      return false
    return true
  }
  catch {
    return false
  }
}

function htmlToMarkdown(html: string, sourceUrl: string): string {
  try {
    const md = convert(html, {
      excludeSelectors: EXCLUDE_SELECTORS,
      baseUrl: sourceUrl,
      headingStyle: 'atx',
      linkStyle: 'referenced',
    })
    return md.slice(0, MAX_MARKDOWN_CHARS)
  }
  catch (e) {
    logger.warn({ error: (e as Error).message }, '[WEB] supermarkdown convert failed, fallback to strip')
    return fallbackStripHtml(html, sourceUrl)
  }
}

function fallbackStripHtml(html: string, sourceUrl: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim() : sourceUrl
  const body = decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim(),
  ).slice(0, MAX_MARKDOWN_CHARS)
  return `# ${title}\n\nSource: ${sourceUrl}\n\n${body}`
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
}

export async function performWebFetch(url: string): Promise<{ url: string, markdown: string }> {
  if (!isValidUrl(url))
    throw new Error(`invalid or blocked URL: ${url}`)

  const cached = fetchCache.get(url)
  if (cached && cached.expiresAt > Date.now())
    return { url: cached.url, markdown: cached.markdown }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    })

    if (!response.ok)
      throw new Error(`HTTP ${response.status} ${response.statusText}`)

    const contentType = response.headers.get('content-type') ?? ''
    if (BINARY_TYPES.test(contentType))
      throw new Error(`binary content type not supported: ${contentType}`)

    const contentLength = response.headers.get('content-length')
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES)
      throw new Error(`response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`)

    const text = await response.text()
    if (text.length > MAX_RESPONSE_BYTES)
      throw new Error(`response body too large: ${text.length} bytes`)

    const finalUrl = response.url || url
    let markdown: string

    if (contentType.includes('text/html') || /^<!doctype html/i.test(text) || /<html[\s>]/i.test(text)) {
      markdown = htmlToMarkdown(text, finalUrl)
    }
    else if (contentType.includes('application/json')) {
      try {
        const pretty = JSON.stringify(JSON.parse(text), null, 2)
        markdown = `# ${finalUrl}\n\n\`\`\`json\n${pretty.slice(0, MAX_MARKDOWN_CHARS)}\n\`\`\``
      }
      catch {
        markdown = `# ${finalUrl}\n\n\`\`\`\n${text.slice(0, MAX_MARKDOWN_CHARS)}\n\`\`\``
      }
    }
    else {
      markdown = `# ${finalUrl}\n\n${text.slice(0, MAX_MARKDOWN_CHARS)}`
    }

    fetchCache.set(url, { markdown, url: finalUrl, expiresAt: Date.now() + CACHE_TTL_MS })
    logger.info({ url: finalUrl, mdLen: markdown.length, htmlLen: text.length }, '[WEB] fetch completed')
    return { url: finalUrl, markdown }
  }
  finally {
    clearTimeout(timer)
  }
}

function stripTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim(),
  )
}

function decodeDuckDuckGoHref(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com')
    const uddg = u.searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : u.toString()
  }
  catch {
    return href
  }
}

export async function performWebSearch(searchTerm: string): Promise<Array<{ title: string, url: string, chunk: string }>> {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchTerm)}`
  const response = await fetch(searchUrl, {
    headers: { 'user-agent': USER_AGENT, 'accept': 'text/html' },
    redirect: 'follow',
  })

  if (!response.ok)
    throw new Error(`search failed: ${response.status} ${response.statusText}`)

  const html = await response.text()
  const references: Array<{ title: string, url: string, chunk: string }> = []

  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,1200}?(?:<a[^>]+class="result__snippet"[^>]*>|<div[^>]+class="result__snippet"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi
  let match: RegExpExecArray | null
  while ((match = resultRegex.exec(html)) && references.length < 8) {
    const href = decodeDuckDuckGoHref(match[1])
    const title = stripTags(match[2])
    const chunk = stripTags(match[3]).slice(0, 400)
    if (title && href)
      references.push({ title, url: href, chunk })
  }

  if (references.length === 0) {
    const fallbackRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    while ((match = fallbackRegex.exec(html)) && references.length < 8) {
      const href = decodeDuckDuckGoHref(match[1])
      const title = stripTags(match[2])
      if (!href.startsWith('http') || !title || title.length < 3)
        continue
      references.push({ title, url: href, chunk: '' })
    }
  }

  logger.info({ searchTerm, results: references.length }, '[WEB] search completed')
  return references
}
