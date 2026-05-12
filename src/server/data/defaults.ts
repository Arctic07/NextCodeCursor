/**
 * Cursor++ 共享默认值 (TS 版)
 *
 * 必须与 installer/src/defaults.js 保持一致。
 * 用途参见 installer/src/defaults.js 文件头注释。
 */

export const CCURSOR_DIR_NAME = '.ccursor'
export const ROUTES_FILE_NAME = 'routes.json'
export const PROVIDERS_FILE_NAME = 'providers.json'
export const DB_FILE_NAME = 'cursor.db'
export const KNOWLEDGE_BASE_FILE_NAME = 'knowledge-base.json'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 9960
export const DEFAULT_COLLECTOR_PORT = 14800

/**
 * BASE_REDIRECT —— 不论 BYOK 开关如何,**永远**生效的劫持白名单。
 *
 * 当前只包含"假装订阅"的 2 个 Stripe profile stub。
 * 这些是无 Cursor 付费账号的用户切到 OFF 模式后,仍然需要 stub 的最小集
 * (让 Cursor 渲染器认为账户是 ultra,不进入付费引导)。
 */
export const BASE_REDIRECT: readonly string[] = [
  'REST:/auth/full_stripe_profile',
  'REST:/auth/stripe_profile',
]

/**
 * BYOK_REDIRECT —— 仅在 byokMode === 'on' 时追加进生效白名单。
 *
 * 关闭 BYOK 时这些项**必须**移除,让对应请求直通官方:
 *   - 模型列表 / Agent 流 / Bidi 队列: 关 BYOK 后客户端走真 Cursor
 *   - ChatService 摘要: BYOK Agent 流的本地 sqlite 持久化
 *   - 一组整服务 stub: 支撑 BYOK 流程下的账号 / dashboard / serverConfig 假数据
 *     (整服务挂入是为了后续逐方法实装,当前未实装的方法返回 unimplemented)
 *
 * 注意 BidiAppend 位于 aiserver.v1 包下, 不是 agent.v1 —— 切记别又写错。
 */
export const BYOK_REDIRECT: readonly string[] = [
  // ── BYOK 核心 ──
  'aiserver.v1.AiService/AvailableModels',
  'agent.v1.AgentService/RunSSE',
  'agent.v1.AgentService/UploadConversationBlobs',
  'aiserver.v1.BidiService/BidiAppend',

  // ── 本地摘要持久化(BYOK Agent 配套) ──
  'aiserver.v1.ChatService/GetConversationSummary',
  'aiserver.v1.ChatService/StreamSpeculativeSummaries',

  // ── Rules / Knowledge Base (本地持久化) ──
  'aiserver.v1.AiService/KnowledgeBaseList',
  'aiserver.v1.AiService/KnowledgeBaseAdd',
  'aiserver.v1.AiService/KnowledgeBaseUpdate',
  'aiserver.v1.AiService/KnowledgeBaseRemove',

  // ── BYOK 流程下需要 stub 的服务 ──
  'aiserver.v1.AuthService',
  // DashboardService: 逐方法挂入 — 未列出的方法 (如 ListMarketplacePlugins) 直接透传官方 API
  'aiserver.v1.DashboardService/GetPlanInfo',
  'aiserver.v1.DashboardService/GetCurrentPeriodUsage',
  'aiserver.v1.DashboardService/GetTeams',
  'aiserver.v1.DashboardService/GetUserPrivacyMode',
  'aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants',
  'aiserver.v1.DashboardService/GetEffectiveUserPlugins',
  'aiserver.v1.DashboardService/IsOnNewPricing',
  'aiserver.v1.DashboardService/GetManagedSkills',
  'aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam',
  'aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam',
  'aiserver.v1.DashboardService/GetGlobalCommands',
  'aiserver.v1.DashboardService/GetTeamCommands',
  'aiserver.v1.DashboardService/GetSlackInstallUrl',
  'aiserver.v1.ServerConfigService',
  'aiserver.v1.NetworkService',
  'aiserver.v1.HealthService',
  'aiserver.v1.InAppAdService',

  // ── BackgroundComposerService (逐方法 stub — 启动轮询 + UI 初始化) ──
  'aiserver.v1.BackgroundComposerService/ListBackgroundComposers',
  'aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings',
  'aiserver.v1.BackgroundComposerService/ListTeamEnvironments',
  'aiserver.v1.BackgroundComposerService/ListPersonalEnvironments',

  // ── REST endpoints (BYOK 流程下需要的假账号 stub) ──
  'REST:/auth/has_valid_payment_method',
  'REST:/auth/poll',
  'REST:/auth/logout',
]

/** 兼容旧调用: 完整白名单 = BASE + BYOK */
export const DEFAULT_REDIRECT: readonly string[] = [...BASE_REDIRECT, ...BYOK_REDIRECT]

/** BYOK 开关: 1 = on (BYOK 启用), 0 = off (走官方) */
export type ByokMode = 0 | 1

export interface RoutesConfig {
  $schemaVersion: number
  byokMode: ByokMode
  server: { host: string, port: number }
  collector: { host: string, port: number }
  redirect: string[]
}

export const DEFAULT_ROUTES: RoutesConfig = {
  $schemaVersion: 1,
  byokMode: 1,
  server: { host: DEFAULT_HOST, port: DEFAULT_PORT },
  collector: { host: DEFAULT_HOST, port: DEFAULT_COLLECTOR_PORT },
  redirect: [...BASE_REDIRECT, ...BYOK_REDIRECT],
}

/** 根据 byokMode 计算最终 redirect 数组 */
export function buildRedirectForMode(mode: ByokMode): string[] {
  return mode
    ? [...BASE_REDIRECT, ...BYOK_REDIRECT]
    : [...BASE_REDIRECT]
}

// ── Provider / Model ──

export type ProviderType = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini'

export interface ProviderAuth {
  kind: 'apiKey' | 'token'
  value: string
}

/**
 * 思考档位。三家 SDK 的映射:
 *   - OpenAI reasoning_effort: 原样枚举透传 (完全对齐)
 *   - Anthropic output_config.effort: minimal→low, xhigh→max (4.5-opus / 4.6 + 专用)
 *   - Gemini thinkingConfig.thinkingLevel: xhigh→HIGH (饱和)
 * 用户应按 model 是否支持选填;不填则 handler 回退默认行为。
 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ProviderModel {
  id: string
  apiModel: string
  displayName: string
  thinking: boolean
  /** 统一思考档位 — 优先用于 OpenAI/Gemini/Anthropic 4.5-opus+/4.6+ */
  thinkingLevel?: ThinkingLevel
  /** 精确思考预算 (token 数) — 适用于老 Claude 4.x (legacy thinking.enabled) 和 Gemini 精确覆盖 */
  thinkingBudgetTokens?: number
  supportsAgent?: boolean
  supportsImages?: boolean
  supportsCmdK?: boolean
  supportsAutoContext?: boolean
  // autoContextMaxTokens / autoContextExtendedMaxTokens 已移除:
  // 客户端不消费,官方 server 返回值也全等于 contextTokenLimit,
  // BYOK server 的 auto-summarize 只看 contextTokenLimit × 85% 阈值。
  // byokModelBuilder 里自动从 contextTokenLimit 派生填入 proto 响应。
  supportsMaxMode?: boolean
  supportsNonMaxMode?: boolean
  contextTokenLimit?: number
  contextTokenLimitForMaxMode?: number
  /** 单次输出最大 token 数 — 不填默认 8192 */
  maxOutputTokens?: number
  supportsPlanMode?: boolean
  supportsSandboxing?: boolean
  defaultOn?: boolean
  /** Fast 模式 — OpenAI: service_tier=priority / Anthropic: fast-mode beta */
  fastMode?: boolean
  /** 模型选择器里 hover 显示的 markdown tooltip (非 max mode) */
  tooltipMarkdown?: string
  /** 模型选择器里 hover 显示的 markdown tooltip (max mode 开启时) */
  tooltipMarkdownForMaxMode?: string
}

export interface ProviderEntry {
  id: string
  name: string
  type: ProviderType
  baseUrl: string
  auth: ProviderAuth
  models: ProviderModel[]
  /**
   * HTTP 代理 URL — 对 Anthropic / OpenAI provider 生效 (Gemini 暂不支持)。
   *
   * 用途:
   *   1. 抓包调试: mitmproxy / Charles 等工具观察最终 LLM request/response
   *   2. 代理访问: 需要 proxy 才能连接的模型提供商
   *
   * 格式: "http://host:port" (undici ProxyAgent 仅支持 HTTP proxy)
   * 留空则不走代理。
   */
  proxyUrl?: string
  /**
   * 自定义请求头 — 每次 LLM 请求时附加。
   *
   * 用途:
   *   - Anthropic: anthropic-beta (interleaved-thinking, prompt-caching-scope 等)
   *   - OpenAI: 自定义 header (如 Helicone 等代理网关需要的 key)
   *   - 第三方兼容 API: 特定认证或功能头
   *
   * 示例: { "anthropic-beta": "interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05" }
   */
  headers?: Record<string, string>
}

export interface ProvidersConfig {
  $schemaVersion: number
  providers: ProviderEntry[]
}

/**
 * BYOK Provider 兜底常量 — server 读不到文件 / 文件损坏时的 fallback。
 * 不放任何 provider,避免"假装有配置"造成的歧义。
 * 首次安装时 installer 会释放一份更丰富的 INITIAL_PROVIDERS 到磁盘,
 * 那部分数据定义在 installer/src/defaults.js。
 */
export const DEFAULT_PROVIDERS: ProvidersConfig = {
  $schemaVersion: 1,
  providers: [],
}

export const MODELS_CATALOG_FILE_NAME = 'models-catalog.json'
