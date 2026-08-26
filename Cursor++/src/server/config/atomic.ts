/**
 * 原子文件读写工具
 *
 * write 走 tmp + rename, 同文件系统下 POSIX 保证原子性。
 * 进程内并发调用通过简单的 Promise 链做串行化, 避免 read-modify-write 竞争。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJsonOrNull<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as T
  }
  catch (err) {
    // 不再静默 — 文件读取失败可能导致 ensureProvidersFile 用空种子覆盖用户配置。
    // macOS 26+ 上曾观测到因权限问题 readFileSync 失败但文件实际存在的情况。
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      // ENOENT (不存在) 是正常的 — 首次运行还没释放文件。其他错误需要记录。
      console.warn(`[CFG] readJsonOrNull failed: ${path} (${code ?? (err as Error).message})`)
    }
    return null
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  renameSync(tmp, path)
}

/**
 * 进程内串行化 mutator: 同一文件的并发 update 不会丢写。
 * 跨进程的并发不在保护范围内 — 我们的场景中 BYOK server 是单实例。
 */
const queues = new Map<string, Promise<unknown>>()

export async function withSerial<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  queues.set(key, next.catch(() => undefined))
  try {
    return await next
  }
  finally {
    if (queues.get(key) === next) {
      queues.delete(key)
    }
  }
}
