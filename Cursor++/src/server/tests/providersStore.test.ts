import type { ProviderEntry, ProviderModel, ProvidersConfig } from '../data/defaults'
import { afterEach, describe, expect, it } from 'vitest'
import { flattenModels, lookupModel, resetProvidersCacheForTests, setProvidersForTests } from '../config/providersStore'
import { RELAY_BRANDING } from '../relay/branding'

function createModel(id: string, apiModel: string): ProviderModel {
  return {
    id,
    apiModel,
    displayName: id,
    thinking: false,
  }
}

function createProvider(id: string, models: ProviderModel[], baseUrl = 'https://generic.example/v1'): ProviderEntry {
  return {
    id,
    name: id,
    type: 'openai-chat',
    baseUrl,
    auth: { kind: 'apiKey', value: 'test-key' },
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
