/**
 * 客户端 "默认模型" 占位 id 解析
 *
 * Cursor 客户端在某些场景下不会发送具体模型 id, 而是发送占位名:
 *   - 会话创建时保存的 modelName 仍是 "default" (Auto/Routed 视图的默认值)
 *   - Agent Window 新建/旧会话, 模型选择从未落成具体 id
 *   - 请求里 modelDetails.modelId 缺省
 *
 * 官方服务端有路由层, 可以把占位名二次路由到真实模型; BYOK 没有这一层,
 * 占位名会直接落到 providers.json 的反向索引里命中失败, 表现为
 * "Model \"default\" not found in ~/.ccursor/providers.json" (Issue #34)。
 *
 * 因此这里把占位名统一映射到 providers.json 中的默认模型 —— 与
 * AiService.getDefaultModel 推送给 Composer / Cmd+K 的默认模型是**同一个选择函数**,
 * 启用判定统一走 isModelDefaultOn (缺省视为关闭, 与 AvailableModels 下发一致, PR #18)。
 */
import type { ResolvedProviderModel } from '../../config/providersStore'
import { flattenModels } from '../../config/providersStore'
import { isModelDefaultOn } from '../../data/defaults'

const DEFAULT_MODEL_ALIASES: ReadonlySet<string> = new Set(['', 'default', 'auto'])

/** 是否为客户端 "默认模型" 占位名 (空串也算 —— 客户端没给模型) */
export function isDefaultModelAlias(modelId: string | undefined | null): boolean {
  if (typeof modelId !== 'string')
    return true
  return DEFAULT_MODEL_ALIASES.has(modelId.trim().toLowerCase())
}

/** 选择器里启用的模型 (按 providers.json 顺序) —— GetDefaultModel 与占位名映射共用 */
export function enabledModelEntries(): ResolvedProviderModel[] {
  return flattenModels().filter(x => isModelDefaultOn(x.model))
}

/**
 * 占位名应映射到的模型 id: 首个启用模型 (即 GetDefaultModel 推送的那个);
 * 一个都没启用时退到首个配置模型, 保证 "default" 请求仍可服务;
 * providers.json 为空时返回 null。
 */
export function resolveDefaultModelId(): string | null {
  const enabled = enabledModelEntries()[0]
  return (enabled ?? flattenModels()[0])?.model.id ?? null
}

/**
 * 把客户端发来的 modelId 归一成 providers.json 中登记的 id。
 *
 * 占位名 → 默认模型 id; 已有具体 id → 原样返回 (不做任何前缀推断)。
 * 占位名且没有任何可用模型时返回原始占位名, 让上游照常报 ModelNotFoundError,
 * 用户能看到 "providers.json 为空" 的真实原因。
 */
export function resolveRequestedModelId(modelId: string | undefined | null): string {
  if (!isDefaultModelAlias(modelId))
    return modelId as string
  return resolveDefaultModelId() ?? (modelId ?? '')
}
