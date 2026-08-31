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

/**
 * 带 relay 叠加的 redirect 构造器。
 * BYOK=on 时在官方白名单后追加 RELAY_EXTRA_REDIRECT（去重）。
 */
export function buildRedirectForMode(mode: ByokMode): string[] {
  const base = baseBuildRedirectForMode(mode)
  if (!mode || RELAY_EXTRA_REDIRECT.length === 0)
    return base
  const seen: Record<string, true> = {}
  for (const r of base) seen[r] = true
  const extra = RELAY_EXTRA_REDIRECT.filter(r => !seen[r])
  return [...base, ...extra]
}

// 供不经过 routesStore 的地方（如 installer 对照）查询纯官方白名单
export { BASE_REDIRECT, BYOK_REDIRECT }

function normalizeByokMode(value: unknown): ByokMode {
  // 0 / 1 / true / false / 'on' / 'off' 一律收敛到 0|1
  if (value === 0 || value === false || value === 'off')
    return 0
  return 1
}

function withFallback(loaded: Partial<RoutesConfig> | null): RoutesConfig {
  const fallback = clone(DEFAULT_ROUTES)
  // fallback 的 redirect 也要带 relay
  fallback.redirect = buildRedirectForMode(fallback.byokMode)
  if (!loaded)
    return fallback
  const byokMode = normalizeByokMode(loaded.byokMode)
  return {
    $schemaVersion: loaded.$schemaVersion ?? fallback.$schemaVersion,
    byokMode,
    server: {
      host: loaded.server?.host ?? fallback.server.host,
      port: loaded.server?.port ?? fallback.server.port,
    },
    collector: {
      host: loaded.collector?.host ?? fallback.collector.host,
      port: loaded.collector?.port ?? fallback.collector.port,
    },
    redirect: Array.isArray(loaded.redirect) && loaded.redirect.length > 0
      ? loaded.redirect.slice()
      : buildRedirectForMode(byokMode),
  }
}

export function loadRoutes(): RoutesConfig {
  const loaded = readJsonOrNull<Partial<RoutesConfig>>(getRoutesFilePath())
  return withFallback(loaded)
}

/**
 * 首次启动 / 缺字段时把内置默认值补齐写回。
 * 已有字段一律保留, 不覆盖用户值。
 */
export async function ensureRoutesFile(): Promise<RoutesConfig> {
  const path = getRoutesFilePath()
  return withSerial(path, () => {
    const existing = readJsonOrNull<Partial<RoutesConfig>>(path)
    const merged = withFallback(existing)
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
    const current = withFallback(readJsonOrNull<Partial<RoutesConfig>>(path))
    updater(current)
    writeJsonAtomic(path, current)
    return current
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

/**
 * 切换 byokMode 并重写 redirect 数组。
 *
 * 重写策略: redirect 完全由 buildRedirectForMode(mode) 重生成,
 * 用户手动塞进 redirect 的"其他"条目会被覆盖 — 这是有意为之,
 * 避免开关切换后白名单状态混乱。
 */
export function setByokMode(mode: ByokMode): Promise<RoutesConfig> {
  return updateRoutes((draft) => {
    draft.byokMode = mode
    draft.redirect = buildRedirectForMode(mode)
    logger.info({ byokMode: mode, redirectCount: draft.redirect.length }, '[CFG] byokMode set')
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
