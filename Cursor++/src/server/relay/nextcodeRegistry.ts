import { normalizeRelayModelId } from './modelIdentity'
import { RELAY_BRANDING } from './branding'
/**
 * NextCode 中转站远端白名单 Registry
 *
 * 白名单来源: RELAY_BRANDING.modelRegistryUrl（relay.config.json → branding.ts）。
 * 缓存策略: 模块级缓存, TTL 10 分钟（NEXTCODE_CACHE_TTL_MS）; TTL 内直接返回缓存,
 * 过期或 force=true 时重新拉取。多个调用同时过期时复用同一个 in-flight promise, 只发一次请求。
 *
 * 失败回退: 拉取失败且存在旧缓存 → 返回旧缓存并附带 error 字段（不 throw）;
 * 无缓存 → 返回空列表 + error。本模块保证 load/lookup 不向调用方抛出异常。
 * 匹配规则: 模型 id 先经 normalizeModelId（取末段 + trim + 小写）再与远端条目比对。
 */
export interface NextcodeModel {
  id: string
  displayName: string
  contextTokenLimit: number
  maxOutputTokens: number
  supportsImages: boolean
  supportsThinking: boolean
  supportsMaxMode: boolean
  _sourceId?: string
}

/** 远端白名单 JSON 地址 */
export const NEXTCODE_MODELS_URL = RELAY_BRANDING.modelRegistryUrl
/** 白名单缓存有效期: 10 分钟 */
export const NEXTCODE_CACHE_TTL_MS = 10 * 60 * 1000

/** 单次拉取超时 */
const FETCH_TIMEOUT_MS = 10_000

let cachedModels: NextcodeModel[] | null = null
let cachedAt = 0
let lookupMap: Map<string, NextcodeModel> | null = null
let inFlight: Promise<NextcodeModel[]> | null = null

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isPositiveFiniteInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0
}

/** 返回与模块内部缓存隔离的模型副本（模型结构为扁平对象）。 */
function cloneModels(models: readonly NextcodeModel[]): NextcodeModel[] {
  return models.map(model => ({ ...model }))
}

/** 并发防抖: 复用同一个 in-flight fetch promise */
function fetchModels(): Promise<NextcodeModel[]> {
  if (!inFlight) {
    inFlight = doFetch().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

async function doFetch(): Promise<NextcodeModel[]> {
  const res = await fetch(NEXTCODE_MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`白名单拉取失败: HTTP ${res.status} ${res.statusText}`)
  const data: unknown = await res.json()
  if (!Array.isArray(data)) throw new Error('白名单格式非法: JSON 顶层不是数组')
  const models: NextcodeModel[] = []
  const normalizedIds = new Set<string>()
  for (const item of data) {
    if (typeof item !== 'object' || item === null) throw new Error('白名单格式非法: 条目不是对象')
    const m = item as Record<string, unknown>
    if (!isNonEmptyString(m.id)) throw new Error('白名单格式非法: 条目缺少 id')
    const normalizedId = normalizeRelayModelId(m.id)
    if (!normalizedId) throw new Error('白名单格式非法: 条目 id 归一化后为空')
    if (normalizedIds.has(normalizedId)) {
      throw new Error(`白名单格式非法: 条目 id 归一化后重复: ${normalizedId}`)
    }
    normalizedIds.add(normalizedId)
    if (!isNonEmptyString(m.displayName)) throw new Error('白名单格式非法: 条目缺少 displayName')
    if (!isPositiveFiniteInteger(m.contextTokenLimit)) {
      throw new Error('白名单格式非法: 条目缺少有效 contextTokenLimit')
    }
    if (!isPositiveFiniteInteger(m.maxOutputTokens)) {
      throw new Error('白名单格式非法: 条目缺少有效 maxOutputTokens')
    }
    models.push({
      id: m.id,
      displayName: m.displayName,
      contextTokenLimit: m.contextTokenLimit,
      maxOutputTokens: m.maxOutputTokens,
      supportsImages: m.supportsImages === true,
      supportsThinking: m.supportsThinking === true,
      supportsMaxMode: m.supportsMaxMode === true,
      _sourceId: isNonEmptyString(m._sourceId) ? m._sourceId : undefined,
    })
  }
  return models
}

export async function loadNextcodeRegistry(opts?: { force?: boolean }): Promise<{
  models: NextcodeModel[]
  cached: boolean
  fetchedAt: number | null
  error: string | null
}> {
  const now = Date.now()
  if (!opts?.force && cachedModels !== null && now - cachedAt < NEXTCODE_CACHE_TTL_MS) {
    return { models: cloneModels(cachedModels), cached: true, fetchedAt: cachedAt, error: null }
  }
  try {
    const models = await fetchModels()
    cachedModels = cloneModels(models)
    lookupMap = null
    cachedAt = Date.now()
    return { models: cloneModels(cachedModels), cached: false, fetchedAt: cachedAt, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (cachedModels !== null) {
      // 拉取失败但有旧缓存: 回退旧缓存, 附带 error 供调用方提示
      return { models: cloneModels(cachedModels), cached: true, fetchedAt: cachedAt, error: message }
    }
    return { models: [], cached: false, fetchedAt: null, error: message }
  }
}

/** 归一化模型 id: 取路径末段（裸 id）→ trim → 小写 */
export const normalizeModelId = normalizeRelayModelId

/** 按归一化 id 在白名单缓存中查找; 未加载时后台预加载并返回 null（调用方应先 await loadNextcodeRegistry） */
export function lookupNextcodeModel(raw: string): NextcodeModel | null {
  if (cachedModels === null) {
    void loadNextcodeRegistry()
    return null
  }
  lookupMap ??= new Map(cachedModels.map(m => [normalizeModelId(m.id), m]))
  const model = lookupMap.get(normalizeModelId(raw))
  return model === undefined ? null : { ...model }
}
