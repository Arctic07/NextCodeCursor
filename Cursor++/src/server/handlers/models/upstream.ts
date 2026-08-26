/**
 * 透传到官方 Cursor 后端拉取真实订阅模型列表。
 *
 * - 端点: https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels
 * - 鉴权: 直接复用客户端原始 Authorization + x-cursor-* 头, server 不持有 token
 * - 缓存: 全局 5 分钟 TTL, 跨多次调用共享 (无需按 token 维度细分)
 *
 * 解析方式: ConnectRPC 默认走 application/json (Connect Protocol),
 * 我们用 fetch + Connect-style POST + fromJson 解码,避免引入 Connect client。
 */
import type { AvailableModelsRequest, AvailableModelsResponse } from '../../gen/aiserver_v1_pb'
import { fromJson, toJson } from '@bufbuild/protobuf'
import { AvailableModelsRequestSchema, AvailableModelsResponseSchema } from '../../gen/aiserver_v1_pb'
import { logger } from '../../logger'

const UPSTREAM_URL = 'https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels'
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  key: string
  expiresAt: number
  response: AvailableModelsResponse
}

let cache: CacheEntry | null = null

/** 从客户端请求头中过滤需要透传给官方的项 */
function buildForwardHeaders(clientHeaders: Headers): Record<string, string> {
  const out: Record<string, string> = {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
  }
  const passlist = [
    'authorization',
    'user-agent',
    'accept-language',
  ]
  for (const key of passlist) {
    const v = clientHeaders.get(key)
    if (v)
      out[key] = v
  }
  // 透传所有 x-cursor-* 头
  clientHeaders.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-cursor-'))
      out[key] = value
  })
  return out
}

export async function fetchUpstreamAvailableModels(
  clientHeaders: Headers,
  request: AvailableModelsRequest,
): Promise<AvailableModelsResponse | null> {
  // 缓存键不区分 token,但区分请求形态(additionalModelNames 等会影响响应)
  const cacheKey = JSON.stringify({
    isNightly: request.isNightly,
    includeLongContextModels: request.includeLongContextModels,
    excludeMaxNamedModels: request.excludeMaxNamedModels,
    additionalModelNames: request.additionalModelNames,
    useModelParameters: request.useModelParameters,
    includeHiddenModels: request.includeHiddenModels,
  })

  const now = Date.now()
  if (cache && cache.key === cacheKey && cache.expiresAt > now) {
    return cache.response
  }

  try {
    const requestJson = toJson(AvailableModelsRequestSchema, request)
    const res = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: buildForwardHeaders(clientHeaders),
      body: JSON.stringify(requestJson),
    })

    if (!res.ok) {
      logger.warn({ status: res.status, statusText: res.statusText }, '[MODEL] upstream availableModels failed')
      return cache?.response ?? null
    }

    const json = await res.json()
    // ignoreUnknownFields: 上游 proto 可能比我们这边更新 (如 displayConfiguration 等)
    // 严格解码会抛错导致整个 BYOK 列表无法返回,宽松解码保证前向兼容
    const response = fromJson(
      AvailableModelsResponseSchema,
      json as Parameters<typeof fromJson>[1],
      { ignoreUnknownFields: true },
    )
    cache = { key: cacheKey, expiresAt: now + CACHE_TTL_MS, response }
    logger.info({ count: response.models.length }, '[MODEL] upstream availableModels fetched')
    return response
  }
  catch (err) {
    logger.warn({ err: (err as Error).message }, '[MODEL] upstream availableModels error')
    return cache?.response ?? null
  }
}

/** 测试 / 调试用: 清空缓存 */
export function resetUpstreamCacheForTests(): void {
  cache = null
}
