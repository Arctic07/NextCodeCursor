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
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/\/+$/, '')
}

/** Return whether a provider points at the configured OpenAI-compatible relay. */
export function isRelayProvider(provider: { type?: unknown; baseUrl?: unknown }): boolean {
  if (provider === null || typeof provider !== 'object') return false
  return provider.type === 'openai-chat'
    && normalizeRelayBaseUrl(provider.baseUrl) === normalizeRelayBaseUrl(RELAY_BRANDING.apiBaseUrl)
}
