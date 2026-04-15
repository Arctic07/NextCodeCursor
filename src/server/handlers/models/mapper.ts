/**
 * 模型映射器 — 基于 providersStore 反向索引
 *
 * 输入: 客户端发起请求时的 modelName (来自 ModelDetails.modelName 或 chat 请求)
 * 输出: ResolvedModel { provider, model, apiModel, thinking, context... }
 *
 * 命中失败:
 *   未在 providers.json 中登记的 modelId 直接抛 ModelNotFoundError,
 *   由上游 handler 转换为客户端可见的 "模型未找到" 错误响应 —
 *   绝不静默 fallback 到 anthropic 触发错误请求,避免调用者误以为模型可用。
 *
 *   不做任何前缀推断 — 用户必须在 ~/.ccursor/providers.json 里自行登记模型。
 */
import type { ProviderEntry, ProviderModel, ProviderType, ThinkingLevel } from '../../data/defaults'
import { lookupModel } from '../../config/providersStore'
import { logger } from '../../logger'

export class ModelNotFoundError extends Error {
  readonly code = 'MODEL_NOT_FOUND'
  readonly modelId: string
  constructor(modelId: string) {
    super(`Model "${modelId}" not found in ~/.ccursor/providers.json — please add it first.`)
    this.name = 'ModelNotFoundError'
    this.modelId = modelId
  }
}

export interface ModelContextMetadata {
  supportsAutoContext: boolean
  contextTokenLimit: number
  contextTokenLimitForMaxMode: number
}

export interface ResolvedModel extends ModelContextMetadata {
  provider: ProviderType
  providerEntry: ProviderEntry | null
  apiModel: string
  thinking: boolean
  thinkingLevel?: ThinkingLevel
  thinkingBudgetTokens?: number
}

// 不再提供 provider 级默认 contextTokenLimit —— 用户必须在 ProviderModel 上显式填写。
// 未填时 fallback 到 0, Cursor UI 的上下文进度条会显示 0/0 提示用户配置。
const UNSET_CONTEXT_LIMIT = 0

/**
 * 主入口: modelId → ResolvedModel
 *
 * 未登记直接抛 ModelNotFoundError, 不做前缀猜测, 也不 fallback 到 anthropic。
 * 上游 handler 应在 try/catch 中捕获此错, 构造对应的客户端错误响应。
 */
export function resolveModel(modelId: string): ResolvedModel {
  const hit = lookupModel(modelId)
  if (!hit) {
    logger.warn({ modelId }, '[MODEL] not found in providers.json — rejecting request')
    throw new ModelNotFoundError(modelId)
  }
  return {
    provider: hit.provider.type,
    providerEntry: hit.provider,
    apiModel: hit.model.apiModel,
    thinking: hit.model.thinking,
    thinkingLevel: hit.model.thinkingLevel,
    thinkingBudgetTokens: hit.model.thinkingBudgetTokens,
    ...inferModelContextMetadata(modelId, hit.provider.type, hit.model),
  }
}

export function inferModelContextMetadata(
  modelId: string,
  _provider: ProviderType,
  entry?: Partial<ProviderModel>,
): ModelContextMetadata {
  const contextTokenLimit = entry?.contextTokenLimit ?? UNSET_CONTEXT_LIMIT
  if (contextTokenLimit === UNSET_CONTEXT_LIMIT && entry) {
    logger.warn({ modelId }, '[MODEL] contextTokenLimit not set — progress bar will be inaccurate')
  }
  const contextTokenLimitForMaxMode = entry?.contextTokenLimitForMaxMode ?? contextTokenLimit
  const supportsAutoContext = entry?.supportsAutoContext ?? true

  return {
    supportsAutoContext,
    contextTokenLimit,
    contextTokenLimitForMaxMode,
  }
}
