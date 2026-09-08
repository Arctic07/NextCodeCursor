import { RELAY_BRANDING } from './branding'

/** Normalize a relay model id to its final, non-empty path segment. */
export function normalizeRelayModelId(raw: unknown): string {
  if (typeof raw !== 'string') return ''

  const segments = raw.trim().split('/')
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index].trim()
    if (segment) return segment.toLowerCase()
  }
  return ''
}

/** Normalize a relay API base URL for stable comparisons. */
export function normalizeRelayBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string')
    return ''
  const value = raw.trim()
  if (!value)
    return ''
  try {
    const parsed = new URL(value)
    const protocol = parsed.protocol.toLowerCase()
    const defaultPort = (protocol === 'http:' && parsed.port === '80')
      || (protocol === 'https:' && parsed.port === '443')
    const port = parsed.port && !defaultPort ? `:${parsed.port}` : ''
    const hostname = parsed.hostname.toLowerCase()
    const normalizedHostname = hostname.includes(':') && !hostname.startsWith('[')
      ? `[${hostname}]`
      : hostname
    const credentials = parsed.username || parsed.password
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
      : ''
    const pathname = parsed.pathname.replace(/\/+$/, '')
    return `${protocol}//${credentials}${normalizedHostname}${port}${pathname}${parsed.search}${parsed.hash}`
  } catch {
    // URL 解析失败时仍返回去空白、去尾斜杠的安全字符串，比较过程不抛异常。
    return value.replace(/\/+$/, '')
  }
}

/** Return whether a provider points at the configured OpenAI-compatible relay. */
export function isRelayProvider(provider: { type?: unknown; baseUrl?: unknown }): boolean {
  if (provider === null || typeof provider !== 'object')
    return false
  const providerBaseUrl = normalizeRelayBaseUrl(provider.baseUrl)
  const relayBaseUrl = normalizeRelayBaseUrl(RELAY_BRANDING.apiBaseUrl)
  return providerBaseUrl.length > 0 && relayBaseUrl.length > 0 && providerBaseUrl === relayBaseUrl
}
