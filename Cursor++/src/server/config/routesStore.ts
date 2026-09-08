/**
 * routes.json 单项原子读写
 *
 * 读: 文件不存在或损坏 → 返回内置 DEFAULT_ROUTES (深拷贝)
 * 写: tmp + rename, withSerial 保证进程内顺序
 *
 * Relay 叠加: RELAY_EXTRA_REDIRECT 会在 BYOK=on 时追加到白名单 (relay.config.json → relay/preset.ts)。
 */
import type { ByokMode, RoutesConfig } from '../data/defaults'
import { unwatchFile, watchFile } from 'node:fs'
import { BASE_REDIRECT, buildRedirectForMode as baseBuildRedirectForMode, BYOK_REDIRECT, DEFAULT_ROUTES } from '../data/defaults'
import { logger } from '../logger'
import { RELAY_EXTRA_REDIRECT } from '../relay/preset'
import { readJsonOrNull, withSerial, writeJsonAtomic } from './atomic'
import { getRoutesFilePath } from './paths'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeRedirectEntries(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string')
      continue
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed))
      continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

function mergeRelayRedirects(entries: unknown, mode: ByokMode): string[] {
  const normalized = normalizeRedirectEntries(entries)
  const relayEntries = normalizeRedirectEntries(RELAY_EXTRA_REDIRECT)
  if (!mode)
    return normalized.filter(entry => !relayEntries.includes(entry))
  const seen = new Set(normalized)
  for (const entry of relayEntries) {
    if (!seen.has(entry)) {
      seen.add(entry)
      normalized.push(entry)
    }
  }
  return normalized
}

/**
 * 带 relay 叠加的 redirect 构造器。
 * BYOK=on 时在官方白名单后追加 RELAY_EXTRA_REDIRECT（去重）。
 */
export function buildRedirectForMode(mode: ByokMode): string[] {
  const normalizedMode = normalizeByokMode(mode)
  return mergeRelayRedirects(baseBuildRedirectForMode(normalizedMode), normalizedMode)
}

// 供不经过 routesStore 的地方（如 installer 对照）查询纯官方白名单
export { BASE_REDIRECT, BYOK_REDIRECT }

/** 仅明确的启用值打开 BYOK，其余输入（包括缺省/非法值）均关闭。 */
export function normalizeByokMode(value: unknown): ByokMode {
  return value === 1 || value === true || value === '1' || value === 'on' ? 1 : 0
}

function normalizeRedirectForMode(value: unknown, mode: ByokMode): string[] {
  const entries = normalizeRedirectEntries(value)
  return entries.length > 0 ? mergeRelayRedirects(entries, mode) : buildRedirectForMode(mode)
}

/** 将外部 routes 数据收敛为安全、可写回的 RoutesConfig。 */
export function normalizeRoutes(loaded: unknown): RoutesConfig {
  const fallback = clone(DEFAULT_ROUTES)
  const source = loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded)
    ? loaded as Record<string, unknown>
    : null
  const byokMode = source !== null && Object.hasOwn(source, 'byokMode')
    ? normalizeByokMode(source.byokMode)
    : fallback.byokMode
  const server = source?.server !== null && typeof source?.server === 'object' && !Array.isArray(source.server)
    ? source.server as Record<string, unknown>
    : null
  const collector = source?.collector !== null && typeof source?.collector === 'object' && !Array.isArray(source.collector)
    ? source.collector as Record<string, unknown>
    : null
  const redirect = normalizeRedirectForMode(source?.redirect, byokMode)

  return {
    $schemaVersion: typeof source?.$schemaVersion === 'number'
      ? source.$schemaVersion
      : fallback.$schemaVersion,
    byokMode,
    server: {
      host: typeof server?.host === 'string' ? server.host : fallback.server.host,
      port: typeof server?.port === 'number' ? server.port : fallback.server.port,
    },
    collector: {
      host: typeof collector?.host === 'string' ? collector.host : fallback.collector.host,
      port: typeof collector?.port === 'number' ? collector.port : fallback.collector.port,
    },
    redirect,
  }
}

export function loadRoutes(): RoutesConfig {
  const loaded = readJsonOrNull<Partial<RoutesConfig>>(getRoutesFilePath())
  return normalizeRoutes(loaded)
}

/**
 * 首次启动 / 缺字段时把内置默认值补齐写回。
 * 已有字段一律保留, 不覆盖用户值。
 */
export async function ensureRoutesFile(): Promise<RoutesConfig> {
  const path = getRoutesFilePath()
  return withSerial(path, () => {
    const existing = readJsonOrNull<Partial<RoutesConfig>>(path)
    const merged = normalizeRoutes(existing)
    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      writeJsonAtomic(path, merged)
      logger.info({ path }, '[CFG] routes.json initialized/updated to defaults')
    }
    return merged
  })
}

/** 单项更新 (read → mutate → atomic write) */
export async function updateRoutes(updater: (draft: RoutesConfig) => void): Promise<RoutesConfig> {
  const path = getRoutesFilePath()
  return withSerial(path, () => {
    const current = normalizeRoutes(readJsonOrNull<Partial<RoutesConfig>>(path))
    updater(current)
    const normalized = normalizeRoutes(current)
    writeJsonAtomic(path, normalized)
    return normalized
  })
}

export function setServerHost(host: string): Promise<RoutesConfig> {
  return updateRoutes((draft) => {
    draft.server.host = host
  })
}

export function setServerPort(port: number): Promise<RoutesConfig> {
  return updateRoutes((draft) => {
    draft.server.port = port
  })
}

export function addRedirect(entry: string): Promise<RoutesConfig> {
  return updateRoutes((draft) => {
    if (!draft.redirect.includes(entry))
      draft.redirect.push(entry)
  })
}

export function removeRedirect(entry: string): Promise<RoutesConfig> {
  return updateRoutes((draft) => {
    draft.redirect = draft.redirect.filter(x => x !== entry)
  })
}

// ── BYOK 开关 ──

export function getByokMode(): ByokMode {
  return loadRoutes().byokMode
}

/** 切换 byokMode，同时重建官方 redirect 白名单并管理 relay 项。 */
export function setByokMode(mode: ByokMode): Promise<RoutesConfig> {
  return updateRoutes((draft) => {
    draft.byokMode = mode
    draft.redirect = buildRedirectForMode(mode)
    logger.info({ byokMode: normalizeByokMode(mode) }, '[CFG] byokMode set')
  })
}

export function toggleByokMode(): Promise<RoutesConfig> {
  const current = getByokMode()
  return setByokMode(current ? 0 : 1)
}

// ── 文件监听: 外部变更 (其他实例 / 手动编辑) 自动重载 ──

type RoutesChangeListener = () => void
const changeListeners: RoutesChangeListener[] = []
let watching = false

/** 注册 routes.json 变更回调 (用于跨实例状态同步) */
export function onRoutesChange(fn: RoutesChangeListener): () => void {
  changeListeners.push(fn)
  return () => {
    const idx = changeListeners.indexOf(fn)
    if (idx >= 0)
      changeListeners.splice(idx, 1)
  }
}

function notifyChange() {
  for (const fn of changeListeners)
    fn()
}

/** 启动 routes.json 文件监听 (2s 轮询, 与 always-local-patch 同频) */
export function startRoutesWatcher(): void {
  if (watching)
    return
  const path = getRoutesFilePath()
  watchFile(path, { interval: 2000, persistent: false }, () => {
    logger.info('[CFG] routes.json changed externally, reloading')
    notifyChange()
  })
  watching = true
}
/** 停止文件监听 */
export function stopRoutesWatcher(): void {
  if (!watching)
    return
  unwatchFile(getRoutesFilePath())
  watching = false
}
