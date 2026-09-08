import type { ProviderEntry, ProviderModel, ProvidersConfig } from '../data/defaults'
import { afterEach, describe, expect, it } from 'vitest'
import { flattenModels, lookupModel, normalizeProvidersConfig, resetProvidersCacheForTests, sanitizeProvidersConfig, setProvidersForTests } from '../config/providersStore'
import { buildByokAvailableModels } from '../handlers/models/byokModelBuilder'
import { RELAY_BRANDING } from '../relay/branding'

function createModel(id: string, apiModel: string): ProviderModel {
  return {
    id,
    apiModel,
    displayName: id,
    thinking: false,
  }
}

function createProvider(
  id: string,
  models: ProviderModel[],
  baseUrl = 'https://generic.example/v1',
  authValue = 'test-key',
): ProviderEntry {
  return {
    id,
    name: id,
    type: 'openai-chat',
    baseUrl,
    auth: { kind: 'apiKey', value: authValue },
    models,
  }
}

function createConfig(providers: ProviderEntry[]): ProvidersConfig {
  return { $schemaVersion: 1, providers }
}

afterEach(() => {
  resetProvidersCacheForTests()
})

describe('providersStore model identity deduplication', () => {
  it('prefers the relay model for normalized apiModel lookups while preserving a generic exact id', () => {
    const genericModel = createModel('generic-gpt-5', 'OpenAI/GPT-5')
    const relayModel = createModel('relay-gpt-5', 'gpt-5')
    setProvidersForTests(createConfig([
      createProvider('generic', [genericModel]),
      createProvider('relay', [relayModel], RELAY_BRANDING.apiBaseUrl),
    ]))

    const flattened = flattenModels()
    expect(flattened).toHaveLength(1)
    expect(flattened[0]).toMatchObject({
      provider: { id: 'relay' },
      model: { id: 'relay-gpt-5', apiModel: 'gpt-5' },
    })

    for (const requestedId of ['gpt-5', 'OpenAI/GPT-5', 'gateway/gPt-5']) {
      expect(lookupModel(requestedId)).toMatchObject({
        provider: { id: 'relay' },
        model: { id: 'relay-gpt-5' },
      })
    }

    expect(lookupModel('generic-gpt-5')).toMatchObject({
      provider: { id: 'generic' },
      model: { id: 'generic-gpt-5' },
    })
  })

  it('prefers the relay provider for an exact model id conflict without duplicating the flattened result', () => {
    const sharedModelId = 'shared-model'
    setProvidersForTests(createConfig([
      createProvider('generic', [createModel(sharedModelId, 'generic-api-model')]),
      createProvider('relay', [createModel(sharedModelId, 'relay-api-model')], RELAY_BRANDING.apiBaseUrl),
    ]))

    const flattened = flattenModels()
    expect(flattened).toHaveLength(1)
    expect(flattened[0]).toMatchObject({
      provider: { id: 'relay' },
      model: { id: sharedModelId, apiModel: 'relay-api-model' },
    })

    expect(lookupModel(sharedModelId)).toMatchObject({
      provider: { id: 'relay' },
      model: { id: sharedModelId, apiModel: 'relay-api-model' },
    })
  })

  it('keeps one first-wins model when one provider exposes apiModel case and path-prefix variants', () => {
    const firstModel = createModel('first-gpt-5', 'Vendor/GPT-5')
    setProvidersForTests(createConfig([
      createProvider('generic', [
        firstModel,
        createModel('second-gpt-5', 'gpt-5'),
        createModel('third-gpt-5', 'Gateway/GpT-5'),
      ]),
    ]))

    const flattened = flattenModels()
    expect(flattened).toHaveLength(1)
    expect(flattened[0]).toMatchObject({
      provider: { id: 'generic' },
      model: { id: 'first-gpt-5', apiModel: 'Vendor/GPT-5' },
    })

    for (const requestedId of ['gpt-5', 'vendor/GPT-5', 'gateway/GpT-5']) {
      expect(lookupModel(requestedId)).toMatchObject({
        provider: { id: 'generic' },
        model: { id: 'first-gpt-5' },
      })
    }
  })
})

describe('byok available model credentials', () => {
  it('excludes empty or whitespace credentials while retaining configured providers', () => {
    setProvidersForTests(createConfig([
      createProvider('empty-key', [createModel('empty-key-model', 'empty-key-model')], 'https://empty.example/v1', ''),
      createProvider('blank-key', [createModel('blank-key-model', 'blank-key-model')], 'https://blank.example/v1', ' \t'),
      createProvider('configured', [createModel('configured-model', 'configured-model')], 'https://configured.example/v1', ' configured-key '),
    ]))

    expect(buildByokAvailableModels().map(model => model.name)).toEqual(['configured-model'])
  })
})

describe('providersStore save sanitization', () => {
  it('removes providers without credentials and trims retained string fields', () => {
    const configuredModels = [createModel('configured-model', 'configured-api-model')]
    const configured = {
      ...createProvider('configured', configuredModels, 'https://configured.example/v1', ' configured-key '),
      name: '  Configured provider  ',
      proxyUrl: 'http://proxy.example:8080',
      headers: { 'x-test': 'keep' },
    }
    const empty = createProvider('empty', [createModel('orphaned-model', 'orphaned-api-model')], 'https://empty.example/v1', ' \t')
    const input = createConfig([empty, configured])

    const sanitized = sanitizeProvidersConfig(input)

    expect(sanitized.providers).toHaveLength(1)
    expect(sanitized.providers[0]).toMatchObject({
      id: 'configured',
      name: 'Configured provider',
      auth: { value: 'configured-key' },
      proxyUrl: 'http://proxy.example:8080',
      headers: { 'x-test': 'keep' },
    })
    expect(sanitized.providers[0].models).toBe(configuredModels)
    expect(sanitized.providers.map(provider => provider.id)).not.toContain('empty')
    expect(input.providers).toEqual([empty, configured])
  })
})
describe('providersStore malformed config normalization', () => {
  it('skips malformed providers, keeps the first duplicate, and normalizes nested values', () => {
    const normalized = normalizeProvidersConfig({
      $schemaVersion: 1,
      providers: [
        null,
        [],
        { id: 'missing-type' },
        { id: 'unknown-type', type: 'unsupported' },
        {
          id: 'duplicate',
          name: 'first duplicate',
          type: 'openai-chat',
          baseUrl: 'https://first.example/v1',
          auth: { kind: 'apiKey', value: 'first-key' },
          models: [{ id: 'first-model', apiModel: 'first-api-model', displayName: 'First model', thinking: true }],
        },
        {
          id: 'duplicate',
          name: 'second duplicate',
          type: 'anthropic',
          baseUrl: 'https://second.example/v1',
          auth: { kind: 'token', value: 'second-token' },
          models: [{ id: 'second-model', apiModel: 'second-api-model', displayName: 'Second model', thinking: true }],
        },
        {
          id: 'bad-nested-values',
          type: 'openai-chat',
          baseUrl: 42,
          auth: { kind: 'invalid', value: 42 },
          models: [
            null,
            { id: '', apiModel: 'missing-id', displayName: 'Invalid model' },
            { id: 'missing-api-model', apiModel: '', displayName: 'Invalid model' },
            { id: 'missing-display-name', apiModel: 'missing-display-name', displayName: null },
            { id: 'kept-model', apiModel: 'kept-api-model', displayName: 'Kept model', thinking: 'yes' },
          ],
          headers: ['not', 'a', 'record'],
        },
        {
          id: 'valid',
          name: 'Valid provider',
          type: 'openai-responses',
          baseUrl: 'https://valid.example/v1',
          auth: { kind: 'token', value: 'valid-token' },
          models: [
            { id: 'valid-model', apiModel: 'valid-api-model', displayName: 'Valid model' },
            { id: 'valid-thinking-model', apiModel: 'valid-thinking-api-model', displayName: 'Thinking model', thinking: true },
          ],
          proxyUrl: 'http://proxy.example:8080',
          headers: { 'x-valid': 'kept', 'x-invalid': 123, 'nested': { ignored: true } },
        },
      ],
    })

    expect(normalized.providers.map(provider => provider.id)).toEqual(['duplicate', 'bad-nested-values', 'valid'])
    expect(normalized.providers[0]).toMatchObject({
      id: 'duplicate',
      name: 'first duplicate',
      type: 'openai-chat',
      baseUrl: 'https://first.example/v1',
    })

    const badNested = normalized.providers.find(provider => provider.id === 'bad-nested-values')
    expect(badNested).toMatchObject({
      baseUrl: '',
      auth: { kind: 'apiKey', value: '' },
      models: [{ id: 'kept-model', thinking: false }],
    })
    expect(badNested).not.toHaveProperty('headers')

    const valid = normalized.providers.find(provider => provider.id === 'valid')
    expect(valid).toMatchObject({
      auth: { kind: 'token', value: 'valid-token' },
      proxyUrl: 'http://proxy.example:8080',
      headers: { 'x-valid': 'kept' },
      models: [
        { id: 'valid-model', thinking: false },
        { id: 'valid-thinking-model', thinking: true },
      ],
    })

    setProvidersForTests(normalized)
    expect(flattenModels().map(resolved => resolved.model.id)).toEqual([
      'first-model',
      'kept-model',
      'valid-model',
      'valid-thinking-model',
    ])
    expect(flattenModels().every(resolved => typeof resolved.model.id === 'string')).toBe(true)
  })

  it('returns safe defaults for malformed top-level shapes without throwing', () => {
    for (const input of [null, [], { providers: null }, { providers: 'not-an-array' }]) {
      expect(() => normalizeProvidersConfig(input)).not.toThrow()
      expect(normalizeProvidersConfig(input).providers).toEqual(expect.any(Array))
    }
  })
})
