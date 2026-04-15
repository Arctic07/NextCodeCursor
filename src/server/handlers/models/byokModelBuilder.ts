/**
 * 把 providersStore 里的 BYOK 模型转换成 Cursor AvailableModelsResponse_AvailableModel proto。
 *
 * 关键约定:
 *   - name = ProviderModel.id (不加前缀,跨 provider 重名由 providersStore first-wins)
 *   - isUserAdded = false —— BYOK 开关开启时我们已经把官方模型列表整体替换了,
 *     不需要靠 isUserAdded 做"用户追加"区分,避免客户端 UI 把它们塞进 "User Added" 子区
 *   - serverModelName = ProviderModel.apiModel (上游真实模型名)
 *   - 每个模型至少一个 ModelVariantConfig 让 Cursor 客户端能选中
 *   - tooltipData / tooltipDataForMaxMode 仅在用户配置了 markdown 内容时填入
 *
 * Variant 显示规则 (从 thinking/thinkingLevel/thinkingBudgetTokens/contextTokenLimit 自动派生):
 *
 *   后缀由两部分组成, 独立判断后用空格拼接:
 *     [thinking 片段] [context 片段]
 *
 *   thinking 片段:
 *     thinking=false            → 无
 *     thinking=true + level=medium → ":icon-brain: Medium"
 *     thinking=true + budget=16000 → ":icon-brain: 16k"  (仅当 level 缺失时)
 *     thinking=true 无 level 无 budget → ":icon-brain:"
 *
 *   context 片段 (仅当 contextTokenLimit >= LARGE_CTX_THRESHOLD):
 *     500000  → "500k"
 *     1000000 → "1M"
 *     1500000 → "1.5M"
 *
 *   组合示例:
 *     thinking=true + level=medium + ctx=1M  → ":icon-brain: Medium 1M"
 *     thinking=false + ctx=1M               → "1M"
 *     thinking=true + level=high + ctx=200k → ":icon-brain: High"
 *
 *   后缀统一包裹为灰色小字 (Cursor 官方同款样式):
 *     <span style="color: var(--cursor-text-tertiary); font-size: 0.85em;">suffix</span>
 *
 *   parameterValues + variantStringRepresentation 反映同样的配置, 便于 server 自身调试溯源。
 *   实际 LLM 调用 (Anthropic/OpenAI/Gemini) 仍由 resolveProviderRuntime → LLMStreamRequest
 *   从同一套 ProviderModel 字段消费, 不依赖 parameterValues。
 */
import type { ProviderEntry, ProviderModel } from '../../data/defaults'
import type { RequestedModel_ModelParameterValue } from '../../gen/agent_v1_pb'
import type { AvailableModelsResponse_AvailableModel } from '../../gen/aiserver_v1_pb'
import { create } from '@bufbuild/protobuf'
import { flattenModels } from '../../config/providersStore'
import { RequestedModel_ModelParameterValueSchema } from '../../gen/agent_v1_pb'
import {
  AvailableModelsResponse_AvailableModelSchema,
  AvailableModelsResponse_DegradationStatus,
  AvailableModelsResponse_ModelVariantConfigSchema,
  AvailableModelsResponse_TooltipDataSchema,
} from '../../gen/aiserver_v1_pb'

const VARIANT_SUFFIX_STYLE = 'color: var(--cursor-text-tertiary); font-size: 0.85em;'

/** context 标签显示阈值 — 小于此值视为普通容量, 不显示标签 */
const LARGE_CTX_THRESHOLD = 500_000

/** thinkingLevel 枚举 → 人类可读标签 */
const LEVEL_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Fast',
  medium: 'Medium',
  high: 'High',
  xhigh: 'xHigh',
}

/** budget tokens → "16k" / "32k" 格式 */
function formatBudgetLabel(budget: number): string {
  if (budget >= 1000)
    return `${Math.round(budget / 1000)}k`
  return String(budget)
}

/** context tokens → "1M" / "1.5M" / "500k" 格式, 低于阈值返回 null */
function formatContextLabel(ctx: number): string | null {
  if (ctx < LARGE_CTX_THRESHOLD)
    return null
  if (ctx >= 1_000_000) {
    const m = ctx / 1_000_000
    // 1.0M → "1M", 1.5M → "1.5M"
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`
  }
  return `${Math.round(ctx / 1000)}k`
}

/** thinking 片段: ":icon-brain: Medium" / ":icon-brain: 16k" / ":icon-brain:" / null */
function buildThinkingSegment(model: ProviderModel): string | null {
  if (!model.thinking)
    return null
  if (model.thinkingLevel) {
    const label = LEVEL_LABELS[model.thinkingLevel.toLowerCase()] ?? model.thinkingLevel
    return `:icon-brain: ${label}`
  }
  if (model.thinkingBudgetTokens !== undefined && model.thinkingBudgetTokens > 0) {
    return `:icon-brain: ${formatBudgetLabel(model.thinkingBudgetTokens)}`
  }
  return ':icon-brain:'
}

/** 组合 thinking + context 片段 → 完整后缀文本 */
function buildVariantSuffix(model: ProviderModel): string | null {
  const thinkingSeg = buildThinkingSegment(model)
  const ctxSeg = model.contextTokenLimit !== undefined
    ? formatContextLabel(model.contextTokenLimit)
    : null

  if (thinkingSeg && ctxSeg)
    return `${thinkingSeg} ${ctxSeg}`
  if (thinkingSeg)
    return thinkingSeg
  if (ctxSeg)
    return ctxSeg
  return null
}

/** 包装 variant.displayName, 把后缀裹进灰色 span */
function buildVariantDisplayName(base: string, suffix: string | null): string {
  if (!suffix)
    return base
  return `${base} <span style="${VARIANT_SUFFIX_STYLE}">${suffix}</span>`
}

/** variantStringRepresentation: "model-id[k1=v1,k2=v2]" */
function buildVariantStringRepresentation(model: ProviderModel): string {
  const parts: string[] = []
  if (model.thinking)
    parts.push('thinking=true')
  if (model.thinkingLevel)
    parts.push(`level=${model.thinkingLevel}`)
  if (model.thinkingBudgetTokens !== undefined && model.thinkingBudgetTokens > 0)
    parts.push(`budget=${model.thinkingBudgetTokens}`)
  if (model.contextTokenLimit !== undefined) {
    const ctxLabel = formatContextLabel(model.contextTokenLimit)
    if (ctxLabel)
      parts.push(`context=${ctxLabel}`)
  }
  return `${model.id}[${parts.join(',')}]`
}

/** 生成 parameterValues 键值对数组 */
function buildParameterValues(model: ProviderModel): RequestedModel_ModelParameterValue[] {
  const values: RequestedModel_ModelParameterValue[] = []
  if (model.thinking) {
    values.push(create(RequestedModel_ModelParameterValueSchema, { id: 'thinking', value: 'true' }))
  }
  if (model.thinkingLevel) {
    values.push(create(RequestedModel_ModelParameterValueSchema, { id: 'level', value: model.thinkingLevel }))
  }
  if (model.thinkingBudgetTokens !== undefined && model.thinkingBudgetTokens > 0) {
    values.push(create(RequestedModel_ModelParameterValueSchema, { id: 'budget', value: String(model.thinkingBudgetTokens) }))
  }
  if (model.contextTokenLimit !== undefined) {
    values.push(create(RequestedModel_ModelParameterValueSchema, { id: 'context', value: String(model.contextTokenLimit) }))
  }
  return values
}

function buildAvailableModelFromByok(
  provider: ProviderEntry,
  model: ProviderModel,
): AvailableModelsResponse_AvailableModel {
  const contextLimit = model.contextTokenLimit ?? 200000
  const contextLimitMax = model.contextTokenLimitForMaxMode ?? contextLimit
  // autoContextMaxTokens 用户不配置, 直接从 contextTokenLimit 派生 (与官方行为一致)
  const autoContextMax = contextLimit
  const autoContextExtMax = contextLimitMax

  const tooltipData = model.tooltipMarkdown
    ? create(AvailableModelsResponse_TooltipDataSchema, { markdownContent: model.tooltipMarkdown })
    : undefined
  const tooltipDataForMaxMode = model.tooltipMarkdownForMaxMode
    ? create(AvailableModelsResponse_TooltipDataSchema, { markdownContent: model.tooltipMarkdownForMaxMode })
    : undefined

  // 派生 variant 显示标签: 由 thinking / thinkingLevel / thinkingBudgetTokens 决定
  const variantSuffix = buildVariantSuffix(model)
  const variantDisplayName = buildVariantDisplayName(model.displayName, variantSuffix)

  return create(AvailableModelsResponse_AvailableModelSchema, {
    name: model.id,
    defaultOn: model.defaultOn ?? false,
    isUserAdded: false,
    supportsAgent: model.supportsAgent ?? true,
    supportsThinking: model.thinking,
    supportsImages: model.supportsImages ?? true,
    supportsCmdK: model.supportsCmdK ?? true,
    supportsAutoContext: model.supportsAutoContext ?? true,
    autoContextMaxTokens: autoContextMax,
    autoContextExtendedMaxTokens: autoContextExtMax,
    // Max Mode 在 BYOK 场景下无意义 (我们不计费,context 全量透传),默认关闭让 toggle 从 UI 消失
    supportsMaxMode: model.supportsMaxMode ?? false,
    supportsNonMaxMode: model.supportsNonMaxMode ?? true,
    contextTokenLimit: contextLimit,
    contextTokenLimitForMaxMode: contextLimitMax,
    supportsPlanMode: model.supportsPlanMode ?? true,
    supportsSandboxing: model.supportsSandboxing ?? false,
    clientDisplayName: model.displayName,
    serverModelName: model.apiModel,
    // inputboxShortModelName 省略 — Cursor 客户端 fallback 链为:
    //   variant.displayNameOutsidePicker → variant.displayName → inputboxShortModelName → clientDisplayName → name
    // 我们已设 clientDisplayName, 所有 UI 路径自动命中, 无需独立的 short 名字段
    namedModelSectionIndex: 0,
    degradationStatus: AvailableModelsResponse_DegradationStatus.UNSPECIFIED,
    tooltipData,
    tooltipDataForMaxMode,
    // 把 provider 归属藏到 legacySlugs,server 自己的调试用,不影响客户端
    legacySlugs: [`byok:${provider.id}`],
    variants: [
      create(AvailableModelsResponse_ModelVariantConfigSchema, {
        displayName: variantDisplayName,
        displayNameOutsidePicker: variantDisplayName,
        isDefaultMaxConfig: true,
        isDefaultNonMaxConfig: model.defaultOn ?? false,
        variantStringRepresentation: buildVariantStringRepresentation(model),
        parameterValues: buildParameterValues(model),
      }),
    ],
  })
}

export function buildByokAvailableModels(): AvailableModelsResponse_AvailableModel[] {
  return flattenModels().map(({ provider, model }) => buildAvailableModelFromByok(provider, model))
}
