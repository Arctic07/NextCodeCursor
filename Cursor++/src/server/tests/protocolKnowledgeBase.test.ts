import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock knowledgeBaseStore 里 listKnowledgeItems 让 parseRunRequest 看到可控的 items。
// 必须在 import parseRunRequest 之前就 mock,否则模块级引用拿到的是真实实现。
let currentItems: Array<{ id: string, knowledge: string, title: string, createdAt: string, isGenerated: boolean }> = []
vi.mock('../config/knowledgeBaseStore', () => ({
  listKnowledgeItems: () => currentItems.slice(),
  addKnowledgeItem: vi.fn(),
  updateKnowledgeItem: vi.fn(),
  removeKnowledgeItem: vi.fn(),
}))

async function loadParse() {
  return (await import('../handlers/agent/protocol')).parseRunRequest
}

function makeRun(rules: Array<Record<string, unknown>> = []) {
  return {
    runRequest: {
      conversationId: 'kb-test',
      action: {
        userMessageAction: {
          userMessage: { text: 'hi' },
          requestContext: { rules },
        },
      },
      modelDetails: { modelId: 'm' },
    },
  }
}

function kbItem(knowledge: string, title = 'K'): { id: string, knowledge: string, title: string, createdAt: string, isGenerated: boolean } {
  return { id: `id-${knowledge}`, knowledge, title, createdAt: '2024-01-01T00:00:00.000Z', isGenerated: false }
}

describe('parseRunRequest — knowledge-base injection into userRules', () => {
  beforeEach(() => {
    currentItems = []
  })
  afterEach(() => {
    currentItems = []
  })

  it('does nothing when knowledge-base is empty', async () => {
    const parseRunRequest = await loadParse()
    const parsed = parseRunRequest(makeRun([]))
    expect(parsed.userRules).toEqual([])
  })

  it('appends knowledge-base items into userRules when no file rules exist', async () => {
    currentItems = [kbItem('Always reply in Chinese'), kbItem('Prefer TypeScript')]
    const parseRunRequest = await loadParse()
    const parsed = parseRunRequest(makeRun([]))
    expect(parsed.userRules).toEqual([
      'Always reply in Chinese',
      'Prefer TypeScript',
    ])
  })

  it('dedupes against existing file-based global rules by trimmed content', async () => {
    // kb item's content is semantically the same as the file rule (differs only in surrounding
    // whitespace) → should be skipped to avoid double-injection in the preamble.
    currentItems = [
      kbItem('  Always reply in Chinese  '),
      kbItem('Unique rule from settings'),
    ]
    const parseRunRequest = await loadParse()
    const parsed = parseRunRequest(makeRun([
      { fullPath: '/CLAUDE.md', content: 'Always reply in Chinese', type: { global: {} } },
    ]))
    expect(parsed.alwaysRules.map(rule => rule.content)).toEqual(['Always reply in Chinese'])
    expect(parsed.userRules).toEqual([
      'Unique rule from settings', // duplicate KB item is skipped against the eager workspace rule
    ])
  })

  it('skips empty/whitespace-only knowledge entries', async () => {
    currentItems = [kbItem('   '), kbItem(''), kbItem('real rule')]
    const parseRunRequest = await loadParse()
    const parsed = parseRunRequest(makeRun([]))
    expect(parsed.userRules).toEqual(['real rule'])
  })

  it('keeps workspace rules separate from account knowledge-base rules', async () => {
    currentItems = [kbItem('kb-one'), kbItem('kb-two')]
    const parseRunRequest = await loadParse()
    const parsed = parseRunRequest(makeRun([
      { fullPath: '/x.md', content: 'file-one', type: { global: {} } },
      { fullPath: '/y.md', content: 'file-two', type: { global: {} } },
    ]))
    expect(parsed.alwaysRules.map(rule => rule.content)).toEqual(['file-one', 'file-two'])
    expect(parsed.userRules).toEqual(['kb-one', 'kb-two'])
  })
})
