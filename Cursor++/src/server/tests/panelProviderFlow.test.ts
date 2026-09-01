import type { Alpine as AlpineType } from 'alpinejs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MessageListener = (event: MessageEvent) => void

interface AppStore {
  onboarding: { error: string }
  onboardingPid: string | null
  toasts: Array<{ id: number, text: string, level: string }>
  fetchAndApplyModels: (pid: string) => void
}

interface Harness {
  store: AppStore
  postedMessages: unknown[]
  provider: {
    id: string
    name: string
    type: 'openai-chat'
    baseUrl: string
    auth: { kind: 'apiKey', value: string }
    models: unknown[]
  }
  dispatch: (data: unknown) => void
}

async function createHarness(): Promise<Harness> {
  vi.resetModules()

  const postedMessages: unknown[] = []
  let messageListener: MessageListener | undefined
  const stores = new Map<string, unknown>()

  const vscodeApi = {
    postMessage: vi.fn((message: unknown) => {
      postedMessages.push(message)
    }),
    getState: vi.fn(() => null),
    setState: vi.fn((_state: unknown) => undefined),
  }

  const windowStub = {
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== 'message')
        return
      messageListener = typeof listener === 'function'
        ? listener as MessageListener
        : event => listener.handleEvent(event)
    }),
  }

  const documentStub = {
    querySelector: vi.fn((_selector: string) => null),
  }

  vi.stubGlobal('acquireVsCodeApi', vi.fn(() => vscodeApi))
  vi.stubGlobal('document', documentStub)
  vi.stubGlobal('window', windowStub)

  const { initApp, RELAY_BASE_URL } = await import('../../ui/webview/app')
  const fakeAlpine = {
    store(name: string, value?: unknown) {
      if (value !== undefined)
        stores.set(name, value)
      return stores.get(name)
    },
  } as unknown as AlpineType

  initApp(fakeAlpine)

  const provider = {
    id: 'saved-relay-provider',
    name: 'Saved relay',
    type: 'openai-chat' as const,
    baseUrl: RELAY_BASE_URL,
    auth: { kind: 'apiKey' as const, value: 'relay-key' },
    models: [],
  }
  const store = stores.get('app') as AppStore

  return {
    store,
    postedMessages,
    provider,
    dispatch(data: unknown) {
      if (!messageListener)
        throw new Error('message listener was not registered')
      messageListener({ data } as MessageEvent)
    },
  }
}

describe('panel provider model fetching', () => {
  let harness: Harness

  beforeEach(async () => {
    vi.useFakeTimers()
    harness = await createHarness()
    harness.dispatch({
      type: 'state',
      state: { providers: [harness.provider] },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('fetches models for an existing provider without treating it as onboarding', () => {
    harness.store.fetchAndApplyModels(harness.provider.id)

    expect(harness.postedMessages).toContainEqual(expect.objectContaining({
      type: 'fetchRemoteModels',
      pid: harness.provider.id,
      autoApply: true,
    }))
    expect(harness.store.onboardingPid).toBeNull()
  })

  it('shows an existing provider 401 model-fetch failure in a visible toast', () => {
    harness.store.fetchAndApplyModels(harness.provider.id)
    harness.dispatch({
      type: 'remoteModelsResult',
      pid: harness.provider.id,
      error: '401 Unauthorized',
    })

    expect(harness.store.toasts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: expect.stringContaining('401 Unauthorized'),
        level: 'error',
      }),
    ]))
    expect(harness.store.onboarding.error).toBe('')
  })
})
