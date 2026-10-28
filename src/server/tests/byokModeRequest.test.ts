import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * BYOK 开关请求 (routesStore.requestByokMode) — 幂等与防抖。
 *
 * 回归点: 翻转语义「读当前 → 取反」在一次点击被处理两次时 (实测 9ms 内两次) 会「关了又开」。
 * UI 改为发送目标值后, 重复/并发请求结果不变; 旧翻转入口 500ms 内的重复请求被丢弃。
 *
 * routesStore 读写 ~/.ccursor/routes.json —— 测试把 HOME 指向临时目录, 并在首个用例断言
 * 路径确实位于临时目录内, 绝不触碰真实配置。
 */
const tmp = mkdtempSync(join(tmpdir(), 'ccursor-byok-mode-'))
const realHome = process.env.HOME
let store: typeof import('../config/routesStore')
let paths: typeof import('../config/paths')

beforeAll(async () => {
  process.env.HOME = tmp
  paths = await import('../config/paths')
  store = await import('../config/routesStore')
  await store.ensureRoutesFile()
})

afterAll(() => {
  process.env.HOME = realHome
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

describe('requestByokMode', () => {
  it('writes only inside the temporary HOME', () => {
    expect(paths.getRoutesFilePath().startsWith(tmp)).toBe(true)
  })

  it('sets a target mode idempotently', async () => {
    await store.setByokMode(0)
    const first = await store.requestByokMode(1, 'test')
    expect(first.changed).toBe(true)
    expect(store.getByokMode()).toBe(1)
    const again = await store.requestByokMode(1, 'test')
    expect(again.changed).toBe(false)
    expect(store.getByokMode()).toBe(1)
  })

  it('does not flip back when the same click is processed twice concurrently', async () => {
    await store.setByokMode(1)
    await Promise.all([store.requestByokMode(0, 'click#1'), store.requestByokMode(0, 'click#2')])
    expect(store.getByokMode()).toBe(0)
  })

  it('drops a repeated legacy toggle within the debounce window', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    await store.setByokMode(0)
    const first = await store.requestByokMode('toggle', 'legacy')
    now.mockReturnValue(1_000_009) // 实测间隔 9ms
    const second = await store.requestByokMode('toggle', 'legacy')
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(store.getByokMode()).toBe(1)

    now.mockReturnValue(1_000_600) // 超过 500ms 防抖窗口
    const third = await store.requestByokMode('toggle', 'legacy')
    expect(third.changed).toBe(true)
    expect(store.getByokMode()).toBe(0)
    now.mockRestore()
  })
})
