import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE_REDIRECT, buildRedirectForMode, normalizeByokMode, normalizeRoutes } from '../config/routesStore'
import { RELAY_BRANDING } from '../relay/branding'
import { isRelayProvider, normalizeRelayBaseUrl } from '../relay/modelIdentity'
import { RELAY_EXTRA_REDIRECT } from '../relay/preset'

function normalizeRelayRedirects(): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of RELAY_EXTRA_REDIRECT) {
    const value = entry.trim()
    if (value && !seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result
}

describe('routes normalization', () => {
  it('only enables BYOK for the explicit supported values', () => {
    for (const value of [1, true, '1', 'on'])
      expect(normalizeByokMode(value)).toBe(1)

    for (const value of [0, false, '0', 'true', 'ON', 'off', '', null, undefined, {}])
      expect(normalizeByokMode(value)).toBe(0)
  })

  it('trims, filters, and stably deduplicates redirects while managing relay entries', () => {
    const relayEntries = normalizeRelayRedirects()
    const enabled = normalizeRoutes({
      byokMode: 'on',
      redirect: ['  user/custom  ', '', 42, 'user/custom', null, '\tsecond\t'],
    })
    expect(enabled.redirect).toEqual(['user/custom', 'second', ...relayEntries])

    const disabled = normalizeRoutes({
      byokMode: 'off',
      redirect: ['  user/custom  ', ...relayEntries, 'user/custom', ''],
    })
    expect(disabled.byokMode).toBe(0)
    expect(disabled.redirect).toEqual(['user/custom'])

    expect(buildRedirectForMode(0)).toEqual(BASE_REDIRECT)
  })

  it('does not throw for malformed route containers', () => {
    expect(() => normalizeRoutes(null)).not.toThrow()
    expect(() => normalizeRoutes({ server: null, collector: 1, redirect: {} })).not.toThrow()
  })
})

describe('relay model identity', () => {
  it('normalizes protocol, host, default port, path slash, query, and hash', () => {
    expect(normalizeRelayBaseUrl(' HTTPS://EXAMPLE.COM:443/v1///?mode=relay#stable '))
      .toBe('https://example.com/v1?mode=relay#stable')
    expect(normalizeRelayBaseUrl('https://example.com/v1?mode=relay#stable'))
      .toBe('https://example.com/v1?mode=relay#stable')
  })

  it('keeps materially different relay URLs distinct and safely handles parse failures', () => {
    expect(normalizeRelayBaseUrl('http://example.com/v1')).not.toBe(normalizeRelayBaseUrl('https://example.com/v1'))
    expect(normalizeRelayBaseUrl('https://other.example.com/v1')).not.toBe(normalizeRelayBaseUrl('https://example.com/v1'))
    expect(normalizeRelayBaseUrl('https://example.com/v2')).not.toBe(normalizeRelayBaseUrl('https://example.com/v1'))
    expect(normalizeRelayBaseUrl('not a url///')).toBe('not a url')
    expect(isRelayProvider({ baseUrl: `${RELAY_BRANDING.apiBaseUrl}/` })).toBe(true)
    expect(isRelayProvider({ baseUrl: 'https://other.example.com/v1' })).toBe(false)
    expect(isRelayProvider({ baseUrl: undefined })).toBe(false)
  })
})

describe('nextcode registry cache isolation', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns copies so callers cannot mutate the cached models', async () => {
    const payload = [{
      id: 'vendor/model-a',
      displayName: 'Model A',
      contextTokenLimit: 128000,
      maxOutputTokens: 4096,
      supportsImages: true,
      supportsThinking: false,
      supportsMaxMode: false,
    }]
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => payload,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { loadNextcodeRegistry } = await import('../relay/nextcodeRegistry')

    const first = await loadNextcodeRegistry({ force: true })
    first.models[0].displayName = 'caller mutation'
    first.models.push({ ...first.models[0], id: 'caller-added' })

    const cached = await loadNextcodeRegistry()
    expect(cached.models).toEqual([payload[0]])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
