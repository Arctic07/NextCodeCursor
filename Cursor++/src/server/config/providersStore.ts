/**
 * providers.json 单项原子读写 + 反向索引
 *
 * 单一真源:
 *   - 内存里维护 ProvidersConfig + 按 exact modelId / 归一化 apiModel 的双索引
 *   - 加载时建立反向索引,modelId 跨 provider 重名 → relay 优先,同类 first-wins + warn
 *   - 写入立即重建索引
 *
 * Relay 叠加: RELAY_PROVIDERS 仅在“种子/兜底”阶段合并，不覆盖用户已有配置。
 * 详见 src/server/relay/preset.ts 与 relay.config.json
 * 读: 文件不存在 → 默认种子（含 relay 预设）;损坏 → 兜底（含 relay 预设）并 warn
 * 写: tmp + rename, withSerial 串行化
 */
import type { ProviderEntry, ProviderModel, ProvidersConfig } from '../data/defaults'
import { existsSync, unwatchFile, watchFile } from 'node:fs'
import { DEFAULT_PROVIDERS } from '../data/defaults'
import { logger } from '../logger'
import { isRelayProvider, normalizeRelayModelId } from '../relay/modelIdentity'
import { RELAY_PROVIDERS } from '../relay/preset'
import { readJsonOrNull, withSerial, writeJsonAtomic } from './atomic'
import { getProvidersFilePath } from './paths'

export interface ResolvedProviderModel {
  provider: ProviderEntry
  model: ProviderModel
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: ProvidersConfig | null = null
let reverseIndex: Map<string, ResolvedProviderModel> = new Map()
let apiModelIndex: Map<string, ResolvedProviderModel> = new Map()

function getEffectiveDefaults(): ProvidersConfig {
  if (RELAY_PROVIDERS.length === 0)
    return clone(DEFAULT_PROVIDERS)
  const seen: Record<string, true> = {}
  for (const p of DEFAULT_PROVIDERS.providers) seen[p.id] = true
  const extra = RELAY_PROVIDERS.filter(p => !seen[p.id])
  return { ...clone(DEFAULT_PROVIDERS), providers: [...clone(DEFAULT_PROVIDERS).providers, ...clone(extra)] }
}

interface ProviderIndexes {
  reverse: Map<string, ResolvedProviderModel>
  apiModel: Map<string, ResolvedProviderModel>
}

function rebuildIndexes(config: ProvidersConfig): ProviderIndexes {
  const reverse = new Map<string, ResolvedProviderModel>()
  for (const provider of config.providers) {
    if (!Array.isArray(provider.models))
      continue
    for (const model of provider.models) {
      const candidate = { provider, model }
      const existing = reverse.get(model.id)
      if (!existing) {
        reverse.set(model.id, candidate)
        continue
      }

      const candidateWins = isRelayProvider(provider) && !isRelayProvider(existing.provider)
      const winner = candidateWins ? candidate : existing
      const loser = candidateWins ? existing : candidate
      logger.warn(
        {
          modelId: model.id,
          winner: winner.provider.id,
          loser: loser.provider.id,
          winnerModel: winner.model.id,
          loserModel: loser.model.id,
          winnerApiModel: winner.model.apiModel,
          loserApiModel: loser.model.apiModel,
        },
        candidateWins
          ? '[CFG] duplicate model id, preferring relay provider'
          : '[CFG] duplicate model id across providers, keeping first',
      )
      if (candidateWins)
        reverse.set(model.id, candidate)
    }
  }

  const apiModel = new Map<string, ResolvedProviderModel>()
  for (const candidate of reverse.values()) {
    const apiModelKey = normalizeRelayModelId(candidate.model.apiModel) || candidate.model.id
    const existing = apiModel.get(apiModelKey)
    if (!existing) {
      apiModel.set(apiModelKey, candidate)
      continue
    }

    const existingIsRelay = isRelayProvider(existing.provider)
    const candidateIsRelay = isRelayProvider(candidate.provider)
    const candidateWins = candidateIsRelay && !existingIsRelay
    const winner = candidateWins ? candidate : existing
    const loser = candidateWins ? existing : candidate
    logger.warn(
      {
        apiModel: apiModelKey,
        winnerProvider: winner.provider.id,
        winnerModel: winner.model.id,
        winnerApiModel: winner.model.apiModel,
        loserProvider: loser.provider.id,
        loserModel: loser.model.id,
        loserApiModel: loser.model.apiModel,
      },
      candidateWins
        ? '[CFG] duplicate normalized api model, preferring relay provider'
        : '[CFG] duplicate normalized api model, keeping first',
    )
    if (candidateWins)
      apiModel.set(apiModelKey, candidate)
  }

  return { reverse, apiModel }
}

function withFallback(loaded: Partial<ProvidersConfig> | null): ProvidersConfig {
  if (!loaded || !Array.isArray(loaded.providers))
    return getEffectiveDefaults()
  return {
    $schemaVersion: loaded.$schemaVersion ?? DEFAULT_PROVIDERS.$schemaVersion,
    providers: loaded.providers.map(p => ({
      id: p.id,
      name: p.name ?? p.id,
      type: p.type,
      baseUrl: p.baseUrl ?? '',
      auth: p.auth ?? { kind: 'apiKey', value: '' },
      models: Array.isArray(p.models) ? p.models : [],
      ...(p.proxyUrl ? { proxyUrl: p.proxyUrl } : {}),
      ...(p.headers && typeof p.headers === 'object' && Object.keys(p.headers).length > 0 ? { headers: p.headers } : {}),
    })),
  }
}

function setIndexes(config: ProvidersConfig): void {
  const indexes = rebuildIndexes(config)
  reverseIndex = indexes.reverse
  apiModelIndex = indexes.apiModel
}

export function loadProviders(): ProvidersConfig {
  if (cache)
    return cache
  const loaded = readJsonOrNull<Partial<ProvidersConfig>>(getProvidersFilePath())
  cache = withFallback(loaded)
  setIndexes(cache)
  return cache
}

/**
 * 首次启动确保 providers.json 存在 (不存在 → 写默认种子)。
 *
 * 关键: 只在文件**物理不存在**时才写种子。如果文件存在但 readJsonOrNull 返回
 * null (权限错/JSON 损坏),**不覆盖** — 避免用户手动配置被空种子冲掉。
 * macOS 26+ 上曾观测到 extension host 因安全策略读文件失败的情况。
 */
export async function ensureProvidersFile(): Promise<ProvidersConfig> {
  const path = getProvidersFilePath()
  return withSerial(path, () => {
    const existing = readJsonOrNull<Partial<ProvidersConfig>>(path)
    if (existing && Array.isArray(existing.providers)) {
      cache = withFallback(existing)
      setIndexes(cache)
      return cache
    }
    // 文件物理存在但解析失败 → 不覆盖,用带 relay 的兜底运行 (让用户修复文件)
    if (existsSync(path)) {
      logger.warn({ path }, '[CFG] providers.json exists but failed to parse — not overwriting, using empty defaults')
      cache = getEffectiveDefaults()
      setIndexes(cache)
      return cache
    }
    // 文件真的不存在 → 写入种子（含 relay 预设）
    const seed = getEffectiveDefaults()
    writeJsonAtomic(path, seed)
    cache = seed
    setIndexes(cache)
    logger.info({ path }, '[CFG] providers.json seeded with defaults')
    return cache
  })
}

export async function updateProviders(updater: (draft: ProvidersConfig) => void): Promise<ProvidersConfig> {
  const path = getProvidersFilePath()
  return withSerial(path, () => {
    const current = withFallback(readJsonOrNull<Partial<ProvidersConfig>>(path))
    updater(current)
    writeJsonAtomic(path, current)
    cache = current
    setIndexes(cache)
    return cache
  })
}

/** 反向查找: exact modelId 优先,再按归一化 apiModel 兼容客户端输入 */
export function lookupModel(modelId: string): ResolvedProviderModel | null {
  if (!cache)
    loadProviders()
  const exact = reverseIndex.get(modelId)
  if (exact)
    return exact
  const apiModelId = normalizeRelayModelId(modelId)
  if (!apiModelId)
    return null
  return apiModelIndex.get(apiModelId) ?? null
}

/** 铺平所有 provider × model, 每个 exact modelId 和归一化 apiModel 只保留一条 */
export function flattenModels(): ResolvedProviderModel[] {
  if (!cache)
    loadProviders()
  return [...apiModelIndex.values()]
}

export function getProvider(providerId: string): ProviderEntry | null {
  const config = cache ?? loadProviders()
  return config.providers.find(p => p.id === providerId) ?? null
}

/** 测试用: 重置缓存 */
export function resetProvidersCacheForTests(): void {
  cache = null
  reverseIndex = new Map()
  apiModelIndex = new Map()
}

/** 测试用: 直接注入 in-memory providers, 跳过磁盘读写 */
export function setProvidersForTests(config: ProvidersConfig): void {
  cache = clone(config)
  setIndexes(cache)
}

// ── 文件监听: 外部变更 (其他实例 / 手动编辑) 自动重载 ──

type ProvidersChangeListener = () => void
const changeListeners: ProvidersChangeListener[] = []
let watching = false

/** 注册 providers.json 变更回调 (用于跨实例状态同步) */
export function onProvidersChange(fn: ProvidersChangeListener): () => void {
  changeListeners.push(fn)
  return () => {
    const idx = changeListeners.indexOf(fn)
    if (idx >= 0)
      changeListeners.splice(idx, 1)
  }
}

function reloadFromDisk() {
  const loaded = readJsonOrNull<Partial<ProvidersConfig>>(getProvidersFilePath())
  cache = withFallback(loaded)
  setIndexes(cache)
}

/** 启动 providers.json 文件监听 */
export function startProvidersWatcher(): void {
  if (watching)
    return
  const path = getProvidersFilePath()
  watchFile(path, { interval: 2000, persistent: false }, () => {
    logger.info('[CFG] providers.json changed externally, reloading')
    reloadFromDisk()
    for (const fn of changeListeners)
      fn()
  })
  watching = true
}

/** 停止文件监听 */
export function stopProvidersWatcher(): void {
  if (!watching)
    return
  unwatchFile(getProvidersFilePath())
  watching = false
}
