import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock paths.ts 让 store 指向临时目录,避免污染 ~/.ccursor/knowledge-base.json
let tmpDir: string
vi.mock('../config/paths', async () => {
  return {
    getKnowledgeBaseFilePath: () => join(tmpDir, 'knowledge-base.json'),
  }
})

// 动态 import 以保证 mock 已就位
async function loadStore() {
  return await import('../config/knowledgeBaseStore')
}

describe('knowledgeBaseStore — local CRUD', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'byok-kb-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('listKnowledgeItems returns [] when the file does not exist', async () => {
    const store = await loadStore()
    expect(store.listKnowledgeItems()).toEqual([])
  })

  it('addKnowledgeItem writes and prepends; list reflects new-first order', async () => {
    const store = await loadStore()
    const a = await store.addKnowledgeItem({ knowledge: 'first', title: 'A' })
    const b = await store.addKnowledgeItem({ knowledge: 'second', title: 'B' })

    expect(a.id).toBeTruthy()
    expect(b.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)

    const listed = store.listKnowledgeItems()
    expect(listed).toHaveLength(2)
    expect(listed[0].id).toBe(b.id) // newest first
    expect(listed[1].id).toBe(a.id)
  })

  it('addKnowledgeItem falls back to [Untitled] on empty title', async () => {
    const store = await loadStore()
    const item = await store.addKnowledgeItem({ knowledge: 'x', title: '   ' })
    expect(item.title).toBe('[Untitled]')
  })

  it('updateKnowledgeItem changes knowledge/title when id matches, returns false otherwise', async () => {
    const store = await loadStore()
    const { id } = await store.addKnowledgeItem({ knowledge: 'old', title: 'A' })

    const ok = await store.updateKnowledgeItem(id, { knowledge: 'new', title: 'B' })
    expect(ok).toBe(true)
    const listed = store.listKnowledgeItems()
    expect(listed[0]).toMatchObject({ id, knowledge: 'new', title: 'B' })

    const miss = await store.updateKnowledgeItem('unknown-id', { knowledge: 'x' })
    expect(miss).toBe(false)
  })

  it('removeKnowledgeItem deletes and returns a hit flag', async () => {
    const store = await loadStore()
    const { id } = await store.addKnowledgeItem({ knowledge: 'x', title: 'A' })

    const ok = await store.removeKnowledgeItem(id)
    expect(ok).toBe(true)
    expect(store.listKnowledgeItems()).toEqual([])

    const miss = await store.removeKnowledgeItem(id)
    expect(miss).toBe(false)
  })

  it('normalize salvages partial / malformed entries on disk', async () => {
    const store = await loadStore()
    // Simulate a hand-edited file with missing/wrong-typed fields
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(tmpDir, 'knowledge-base.json'),
      JSON.stringify({
        items: [
          { knowledge: 'no-id present' }, // missing id → new one generated
          { id: 42, knowledge: 'bad id type', title: 'X' }, // wrong id type → regenerated
          null, // skipped
          'not-an-object', // skipped
          { id: 'keep', knowledge: 'ok', title: 'Y', createdAt: '2024-01-01T00:00:00.000Z', isGenerated: true },
        ],
      }),
    )
    const items = store.listKnowledgeItems()
    expect(items).toHaveLength(3)
    expect(items.map(i => i.knowledge)).toEqual(['no-id present', 'bad id type', 'ok'])
    expect(items.every(i => typeof i.id === 'string' && i.id.length > 0)).toBe(true)
    expect(items[2].id).toBe('keep')
  })
})
