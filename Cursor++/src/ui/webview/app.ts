/**
 * Alpine.js store — webview 客户端全部逻辑
 *
 * 替代原先 panel-provider.ts 内的 640 行内联 JS。
 * Alpine 响应式代理自动追踪 mutation → DOM 更新, 无需手动 render() / rebind。
 */
import type { Alpine as AlpineType } from 'alpinejs'

declare function acquireVsCodeApi(): { postMessage: (msg: any) => void, getState: () => any, setState: (s: any) => void }

// acquireVsCodeApi 只能调用一次
const vscode = acquireVsCodeApi()

// debounce timer for catalog search
let acTimer: ReturnType<typeof setTimeout> | null = null
/** NextCode 中转站 baseUrl — 判定中转 provider 的常量 */
export const RELAY_BASE_URL = 'https://www.arctictest.com/v1'

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

function sortedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const v = value[key]
    if (v !== undefined)
      out[key] = canonicalValue(v)
  }
  return out
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonicalValue)
  if (value && typeof value === 'object')
    return sortedRecord(value as Record<string, unknown>)
  return value
}

function canonicalProvider(provider: any): any {
  if (!provider)
    return {}
  const headers = provider.headers && typeof provider.headers === 'object' && !Array.isArray(provider.headers)
    ? sortedRecord(provider.headers)
    : undefined
  return {
    id: provider.id,
    name: provider.name ?? provider.id,
    type: provider.type,
    baseUrl: provider.baseUrl ?? '',
    auth: canonicalValue(provider.auth ?? { kind: 'apiKey', value: '' }),
    models: canonicalValue(Array.isArray(provider.models) ? provider.models : []),
    ...(provider.proxyUrl ? { proxyUrl: provider.proxyUrl } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function providersEqual(a: any, b: any): boolean {
  return stableStringify(canonicalProvider(a)) === stableStringify(canonicalProvider(b))
}

export function initApp(Alpine: AlpineType) {
  // Alpine store 内 this 指向 proxy 对象, TS 无法推断 — 用 any 绕过
  const store: any = {
    // ── 来自 extension 推送 ──
    state: null as any,

    // ── 本地 UI 状态 ──
    drafts: {} as Record<string, any>,
    expanded: {} as Record<string, boolean>,
    modelExpanded: {} as Record<string, Record<string, boolean>>,
    headersInvalid: {} as Record<string, boolean>,
    remoteModels: {} as Record<string, { loading: boolean, models?: any[], error?: string }>,
    balance: {} as Record<string, { loading: boolean, used?: number, remaining?: number, total?: number, error?: string }>,
    saveSnapshots: {} as Record<string, { targetIds: string[], snapshots: Record<string, any> }>,
    savingProviders: {} as Record<string, boolean>,
    // ── Key 引导卡 ──
    onboarding: { keyName: '', apiKey: '', connecting: false, error: '' },
    onboardingOpen: false,
    onboardingPid: null as string | null,
    logoUri: '',

    // ── Web Tools Config ──
    webToolsOpen: false,
    webToolsTab: 'search' as 'search' | 'fetch',
    webTools: null as any,

    isSearchProviderEnabled(type: string): boolean {
      return this.webTools?.search?.providers?.find((p: any) => p.type === type)?.enabled ?? false
    },
    getSearchProviderKey(type: string): string {
      return this.webTools?.search?.providers?.find((p: any) => p.type === type)?.apiKey ?? ''
    },
    toggleSearchProvider(type: string, enabled: boolean) {
      if (!this.webTools?.search)
        return
      const p = this.webTools.search.providers.find((x: any) => x.type === type)
      if (p)
        p.enabled = enabled
    },
    setSearchProviderKey(type: string, key: string) {
      if (!this.webTools?.search)
        return
      const p = this.webTools.search.providers.find((x: any) => x.type === type)
      if (p)
        p.apiKey = key
    },
    setSearchOption(key: string, value: any) {
      if (this.webTools?.search)
        (this.webTools.search as any)[key] = value
    },
    setFetchProvider(provider: string) {
      if (this.webTools)
        this.webTools.fetch.provider = provider
    },
    setFetchKey(provider: string, key: string, value: string) {
      if (!this.webTools)
        return
      if (!this.webTools.fetch[provider])
        this.webTools.fetch[provider] = {}
      this.webTools.fetch[provider][key] = value
    },
    saveWebTools() {
      if (!this.webTools)
        return
      this.post('saveWebTools', { config: JSON.parse(JSON.stringify(this.webTools)) })
      this.webToolsOpen = false
      this.toast('Web tools config saved', 'info')
    },

    // ── Toast ──
    toasts: [] as Array<{ id: number, text: string, level: string }>,
    _toastId: 0,

    toast(text: string, level: 'error' | 'warn' | 'info' = 'info', durationMs = 4000) {
      const id = ++this._toastId
      this.toasts = [...this.toasts, { id, text, level }]
      if (durationMs > 0)
        setTimeout(() => this.dismissToast(id), durationMs)
    },

    dismissToast(id: number) {
      this.toasts = this.toasts.filter((t: any) => t.id !== id)
    },

    // ── Autocomplete ──
    ac: null as { pid: string, mid: string, results: any[], selected: number, reqId: number } | null,
    acReqId: 0,

    // ── 派生 ──
    get providers(): any[] {
      if (!this.state)
        return []
      const base: any[] = this.state.providers || []
      const seen = new Set<string>()
      const out: any[] = []
      for (const p of base) {
        seen.add(p.id)
        out.push(this.drafts[p.id] ?? p)
      }
      // 新建但尚未保存的
      for (const [id, draft] of Object.entries(this.drafts)) {
        if (!seen.has(id))
          out.push(draft)
      }
      return out
    },

    /** 仅 NextCode 中转 provider — 与 providers 相同 draft 合并规则 */
    get relayProviders(): any[] {
      if (!this.state)
        return []
      const base: any[] = this.state.providers || []
      const seen = new Set<string>()
      const out: any[] = []
      for (const p of base) {
        // 中转 Key 判定: baseUrl 精确匹配 + type 必须是 openai-chat (面板专属协议)。
        // 用户手配的其他 provider (anthropic / gemini / 无 /v1 后缀) 一律不显示。
        if ((p.baseUrl || '').replace(/\/+$/, '') !== RELAY_BASE_URL || p.type !== 'openai-chat')
          continue
        seen.add(p.id)
        out.push(this.drafts[p.id] ?? p)
      }
      // 新建但尚未保存的中转 draft
      for (const [id, draft] of Object.entries(this.drafts) as [string, any][]) {
        if (!seen.has(id) && (draft.baseUrl || '').replace(/\/+$/, '') === RELAY_BASE_URL && draft.type === 'openai-chat')
          out.push(draft)
      }
      return out
    },

    get hasRelayProvider(): boolean {
      return this.relayProviders.length > 0
    },

    get serverLabel(): string {
      const s = this.state
      if (!s)
        return ''
      if (s.server === 'local')
        return `Running on :${s.port} (this instance)`
      if (s.server === 'remote')
        return `Running on :${s.port} (another instance)`
      if (s.serverIssue === 'port_occupied')
        return `Port :${s.port} occupied by another process`
      return 'Offline'
    },

    // ── Draft 管理 ──
    baseProvider(pid: string): any {
      return (this.state?.providers || []).find((p: any) => p.id === pid)
    },

    getProviderView(pid: string): any {
      return this.drafts[pid] || this.baseProvider(pid) || {}
    },

    getModel(pid: string, mid: string): any {
      const d = this.getProviderView(pid)
      return (d.models || []).find((x: any) => x.id === mid)
    },
    /** 跨 provider 同 apiModel 出现 ≥2 次 → 返回 名称/模型名, 否则裸 displayName (模板高频调用, 纯同步) */
    modelDisplayName(pid: string, mid: string): string {
      const m = this.getModel(pid, mid)
      if (!m)
        return ''
      const apiModel = m.apiModel as string | undefined
      const displayName = (m.displayName as string) || ''
      let count = 0
      for (const p of this.providers) {
        const list = p?.models
        if (Array.isArray(list) && list.some((x: any) => x.apiModel === apiModel))
          count++
      }
      if (apiModel && count >= 2) {
        const owner = this.getProviderView(pid)
        return `${(owner?.name as string) || ''}/${displayName}`
      }
      return displayName
    },

    /** 兼容模板旧命名：只读，不创建 draft。写操作必须调用 ensureDraft。 */
    getDraft(pid: string): any {
      return this.getProviderView(pid)
    },

    ensureDraft(pid: string): any {
      if (!this.drafts[pid]) {
        const base = this.baseProvider(pid)
        if (base)
          this.drafts[pid] = clone(base)
        else
          return {}
      }
      return this.drafts[pid]
    },

    getDraftOrOriginal(pid: string): any {
      return this.getProviderView(pid)
    },

    isDirty(pid: string): boolean {
      const draft = this.drafts[pid]
      if (!draft)
        return false
      const base = this.baseProvider(pid)
      if (!base)
        return true // new, not saved
      return !providersEqual(base, draft)
    },

    // ── 校验 ──
    validate(pid: string) {
      const p = this.getDraft(pid)
      const all = this.providers
      const errors: Record<string, string> = {}

      if (!p.name?.trim())
        errors.name = 'Name is required'
      if (!['anthropic', 'openai-chat', 'openai-responses', 'gemini'].includes(p.type))
        errors.type = 'Invalid type'
      if (p.baseUrl?.trim()) {
        try {
          void new URL(p.baseUrl.trim())
        }
        catch {
          errors.baseUrl = 'Invalid URL'
        }
      }
      if (!p.auth?.value?.trim())
        errors.authValue = 'Auth value is required'
      // Anthropic 允许 apiKey / token 两种; 其他 provider 只允许 apiKey
      if (p.type === 'anthropic') {
        if (!['apiKey', 'token'].includes(p.auth?.kind))
          errors.authKind = 'Invalid auth kind'
      }
      else if (p.auth?.kind !== 'apiKey') {
        errors.authKind = `${p.type} only supports apiKey`
      }

      // name 唯一
      const dupName = all.filter((x: any) => (x.name || '').trim().toLowerCase() === (p.name || '').trim().toLowerCase()).length > 1
      if (dupName)
        errors.name = 'Duplicate provider name'

      // model 校验
      const modelErrors: Record<string, Record<string, string>> = {}
      const modelIds = new Set<string>()
      const OPTIONAL_NUM_FIELDS = ['thinkingBudgetTokens']
      for (const m of p.models || []) {
        const me: Record<string, string> = {}
        if (!m.apiModel?.trim())
          me.apiModel = 'API model is required'
        if (!m.displayName?.trim())
          me.displayName = 'Display name is required'
        if (modelIds.has(m.id))
          me.id = 'Duplicate model id'
        modelIds.add(m.id)
        // contextTokenLimit 必填 — 影响 Cursor UI 上下文进度条
        if (m.contextTokenLimit === undefined || m.contextTokenLimit === null || m.contextTokenLimit === '') {
          me.contextTokenLimit = 'Context token limit is required'
        }
        else if (!Number.isFinite(Number(m.contextTokenLimit)) || Number(m.contextTokenLimit) <= 0 || !Number.isInteger(Number(m.contextTokenLimit))) {
          me.contextTokenLimit = 'Must be a positive integer'
        }
        // maxOutputTokens — noMaxTokens 开启时跳过必填校验
        if (!m.noMaxTokens) {
          if (m.maxOutputTokens === undefined || m.maxOutputTokens === null || m.maxOutputTokens === '') {
            me.maxOutputTokens = 'Max output tokens is required'
          }
          else if (!Number.isFinite(Number(m.maxOutputTokens)) || Number(m.maxOutputTokens) <= 0 || !Number.isInteger(Number(m.maxOutputTokens))) {
            me.maxOutputTokens = 'Must be a positive integer'
          }
        }
        for (const f of OPTIONAL_NUM_FIELDS) {
          const v = m[f]
          if (v === undefined || v === null || v === '')
            continue
          if (!Number.isFinite(Number(v)) || Number(v) < 0 || !Number.isInteger(Number(v))) {
            me[f] = 'Must be a non-negative integer'
          }
        }
        // Budget 模式校验: thinking=true + 无 level → budget 必填, ≥1024, < maxOutputTokens
        if (m.thinking && !m.thinkingLevel) {
          const b = m.thinkingBudgetTokens
          const maxOut = Number(m.maxOutputTokens) || 0
          if (b === undefined || b === null || b === '')
            me.thinkingBudgetTokens = 'Required — enter budget tokens'
          else if (Number(b) < 1024)
            me.thinkingBudgetTokens = 'Min 1024'
          else if (maxOut > 0 && Number(b) >= maxOut)
            me.thinkingBudgetTokens = `Must be < Max Output Tokens (${maxOut})`
          else if (maxOut === 0)
            me.thinkingBudgetTokens = 'Set Max Output Tokens first'
        }
        if (Object.keys(me).length > 0)
          modelErrors[m.id] = me
      }

      return { errors, modelErrors, ok: Object.keys(errors).length === 0 && Object.keys(modelErrors).length === 0 }
    },

    // ── UI 操作 ──
    toggleExpand(pid: string) {
      this.expanded[pid] = !this.expanded[pid]
    },

    toggleModelExpand(pid: string, mid: string) {
      if (!this.modelExpanded[pid])
        this.modelExpanded[pid] = {}
      this.modelExpanded[pid][mid] = !this.modelExpanded[pid][mid]
    },

    // ── 字段更新 ──
    updateField(pid: string, field: string, value: any) {
      const d = this.ensureDraft(pid)
      if (field === 'auth.kind') {
        d.auth = { ...(d.auth || {}), kind: value }
      }
      else if (field === 'auth.value') {
        d.auth = { ...(d.auth || {}), value }
      }
      else if (field === 'headers') {
        // JSON textarea → parse to object, ignore invalid
        if (typeof value === 'string') {
          const trimmed = value.trim()
          if (!trimmed) {
            delete d.headers
          }
          else {
            try {
              const parsed = JSON.parse(trimmed)
              if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
                d.headers = parsed
            }
            catch { /* 输入中途不合法 — 不更新 */ }
          }
        }
      }
      else {
        d[field] = value
      }
    },

    formatHeaders(pid: string): string {
      const h = this.getDraft(pid).headers
      if (!h || typeof h !== 'object' || Object.keys(h).length === 0)
        return ''
      return JSON.stringify(h, null, 2)
    },

    updateHeaders(pid: string, raw: string) {
      const trimmed = raw.trim()
      if (!trimmed) {
        this.headersInvalid[pid] = false
        this.updateField(pid, 'headers', '')
        return
      }
      try {
        JSON.parse(trimmed)
        this.headersInvalid[pid] = false
      }
      catch {
        this.headersInvalid[pid] = true
      }
      this.updateField(pid, 'headers', raw)
    },

    /**
     * 切换 provider type 后规范化 auth.kind:
     *   - anthropic 同时支持 apiKey / bearer token, 保留用户选择
     *   - 其他 provider (openai-chat / openai-responses / gemini) 只支持 apiKey,
     *     强制重置为 apiKey 避免旧的 "token" 残留污染
     */
    normalizeAuthKind(pid: string) {
      const d = this.ensureDraft(pid)
      if (d.type !== 'anthropic') {
        d.auth = { ...(d.auth || { value: '' }), kind: 'apiKey' }
      }
    },

    updateModelField(pid: string, mid: string, field: string, value: any) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return

      if (field === 'thinkingLevel') {
        if (!value)
          delete m.thinkingLevel
        else m.thinkingLevel = value
      }
      else if (field === 'thinking') {
        m.thinking = !!value
        if (!value) {
          delete m.thinkingLevel
          delete m.thinkingBudgetTokens
        }
        else {
          const pType = d.type
          if (!m.thinkingLevel && !m.thinkingBudgetTokens) {
            if (pType === 'anthropic')
              m.thinkingLevel = 'high'
            else
              m.thinkingLevel = 'medium'
          }
        }
      }
      else {
        m[field] = value
      }

      // QS 联动: thinking/thinkingLevel 变更时自动开启对应 QS 开关
      if (field === 'thinking' || field === 'thinkingLevel') {
        this._syncQsFromDefaults(pid, mid)
      }
    },

    setThinkingMode(pid: string, mid: string, mode: 'level' | 'budget') {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return
      if (mode === 'level') {
        delete m.thinkingBudgetTokens
        if (!m.thinkingLevel)
          m.thinkingLevel = 'high'
      }
      else {
        delete m.thinkingLevel
      }
    },

    updateModelNumber(pid: string, mid: string, field: string, raw: string) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return

      if (raw.trim() === '') {
        delete m[field]
        if (field === 'contextTokenLimit')
          delete m.contextTokenLimitForMaxMode
      }
      else {
        const n = Number(raw)
        m[field] = n
        if (field === 'contextTokenLimit')
          m.contextTokenLimitForMaxMode = n
      }

      // QS 联动: budget 模式 (thinkingBudgetTokens) 变更时同样自动开启 QS 开关
      if (field === 'thinkingBudgetTokens')
        this._syncQsFromDefaults(pid, mid)
    },

    // ── Provider / Model 增删 ──
    addProvider() {
      const p = {
        id: uid('provider'),
        name: '默认',
        type: 'openai-chat',
        baseUrl: RELAY_BASE_URL,
        auth: { kind: 'apiKey', value: '' },
        models: [],
      }
      this.drafts[p.id] = p
      this.expanded[p.id] = true
    },

    /** Key 引导卡「连接」— 新建中转 provider 并自动拉取模型 */
    connectKey() {
      const apiKey = String(this.onboarding.apiKey || '').trim()
      const keyName = String(this.onboarding.keyName || '').trim()
      if (!apiKey) {
        this.onboarding.error = '请输入 API Key'
        return
      }
      this.onboarding.connecting = true
      this.onboarding.error = ''
      this.addProvider()
      const pid = Object.keys(this.drafts).pop()! // addProvider 会写入 drafts
      const d = this.drafts[pid]
      d.name = keyName || '默认'
      d.auth = { kind: 'apiKey', value: apiKey }
      this.expanded[pid] = true
      // 不清空 onboarding: 连接失败时错误回显需要引导卡保持打开且凭据保留, 成功时在 remoteModelsResult 里统一收起+清空
      this.onboarding = { ...this.onboarding, connecting: true, error: '' }
      // 自动获取白名单模型 → 全部添加 → 自动保存验权
      this.fetchAndApplyModels(pid, true)
    },

    /** 引导卡「取消」— 收起引导卡, 清空输入; 若连接失败残留了 draft 一并清理 */
    cancelOnboarding() {
      if (this.onboardingPid) {
        const pid = this.onboardingPid
        const draft = this.drafts[pid]
        const saved = (this.state?.providers || []).some((p: any) => p.id === pid)
        if (draft && !saved) {
          delete this.drafts[pid]
          delete this.expanded[pid]
        }
      }
      this.onboardingPid = null
      this.onboardingOpen = false
      this.onboarding = { keyName: '', apiKey: '', connecting: false, error: '' }
    },

    addModel(pid: string) {
      const d = this.ensureDraft(pid)
      const m = {
        id: uid('model'),
        apiModel: '',
        displayName: '',
        thinking: false,
        defaultOn: true, // 新建模型默认启用, 避免用户忘记勾选导致客户端看不到
      }
      if (!d.models)
        d.models = []
      d.models.push(m)
      if (!this.modelExpanded[pid])
        this.modelExpanded[pid] = {}
      this.modelExpanded[pid][m.id] = true
    },

    deleteModel(pid: string, mid: string) {
      const d = this.ensureDraft(pid)
      d.models = (d.models || []).filter((x: any) => x.id !== mid)
      if (this.modelExpanded[pid])
        delete this.modelExpanded[pid][mid]
    },

    // ── QuickSwitch auto-link ──

    _syncQsFromDefaults(pid: string, mid: string) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return
      const pType = d.type as string
      const isOpenAI = pType === 'openai-chat' || pType === 'openai-responses'

      if (m.thinking && m.thinkingLevel) {
        if (!m.parameters)
          m.parameters = {}
        if (isOpenAI) {
          if (!Array.isArray(m.parameters.reasoning))
            m.parameters.reasoning = this._qsLevelsForType(pType)
        }
        else {
          if (m.parameters.thinking !== true)
            m.parameters.thinking = true
          if (!Array.isArray(m.parameters.effort))
            m.parameters.effort = this._qsLevelsForType(pType)
        }
      }
      // budget 模式 (Anthropic/Gemini): QS 没有 budget 轴, 只联动 Thinking Toggle,
      // 运行时由 resolved.thinkingBudgetTokens 兜底
      else if (m.thinking && m.thinkingBudgetTokens && !isOpenAI) {
        if (!m.parameters)
          m.parameters = {}
        if (m.parameters.thinking !== true)
          m.parameters.thinking = true
      }
    },

    _qsLevelsForType(pType: string): string[] {
      if (pType === 'anthropic')
        return ['low', 'medium', 'high', 'xhigh', 'max']
      if (pType === 'gemini')
        return ['minimal', 'low', 'medium', 'high']
      return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    },

    // ── Edit Panel parameters helpers ──

    setEditParam(pid: string, mid: string, key: string, value: any) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return
      if (!m.parameters)
        m.parameters = {}
      if (value === undefined || value === false)
        delete (m.parameters as any)[key]
      else
        (m.parameters as any)[key] = value
      if (Object.keys(m.parameters).length === 0)
        delete m.parameters
    },

    toggleEditParamArrayItem(pid: string, mid: string, key: string, item: string, checked: boolean) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m?.parameters)
        return
      const arr: string[] = (m.parameters as any)[key]
      if (!Array.isArray(arr))
        return
      if (checked && !arr.includes(item))
        arr.push(item)
      else if (!checked)
        (m.parameters as any)[key] = arr.filter((v: string) => v !== item)
    },

    removeEditParamArrayIndex(pid: string, mid: string, key: string, index: number) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m?.parameters)
        return
      const arr: any[] = (m.parameters as any)[key]
      if (!Array.isArray(arr))
        return
      arr.splice(index, 1)
    },

    addEditParamContextValue(pid: string, mid: string, value: number) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m?.parameters || !Array.isArray(m.parameters.context))
        return
      if (!value || value <= 0 || !Number.isFinite(value))
        return
      if (!m.parameters.context.includes(value)) {
        m.parameters.context.push(value)
        m.parameters.context.sort((a: number, b: number) => a - b)
      }
    },

    resetProvider(pid: string) {
      delete this.drafts[pid]
      const base = (this.state?.providers || []).find((p: any) => p.id === pid)
      if (!base) {
        delete this.expanded[pid]
        delete this.modelExpanded[pid]
      }
    },

    moveProvider(pid: string, direction: number) {
      const list = [...(this.state?.providers || [])]
      const idx = list.findIndex((p: any) => p.id === pid)
      if (idx < 0)
        return
      const target = idx + direction
      if (target < 0 || target >= list.length)
        return
      const tmp = list[idx]
      list[idx] = list[target]
      list[target] = tmp
      const merged = list.map((p: any) => this.drafts[p.id] ?? p)
      this.post('saveProviders', { providers: JSON.parse(JSON.stringify(merged)) })
    },

    deleteProvider(pid: string) {
      const remaining = (this.state?.providers || []).filter((p: any) => p.id !== pid)
      const merged = remaining.map((p: any) => this.drafts[p.id] ?? p)
      delete this.drafts[pid]
      delete this.expanded[pid]
      delete this.modelExpanded[pid]
      this.post('saveProviders', { providers: JSON.parse(JSON.stringify(merged)) })
    },

    saveProvider(pid: string) {
      try {
        const p = this.getProviderView(pid)
        const v = this.validate(pid)
        if (!v.ok) {
          const providerName = p.name || 'Provider'
          for (const [, msg] of Object.entries(v.errors))
            this.toast(`${providerName}: ${msg}`, 'error', 6000)
          for (const [mid, errs] of Object.entries(v.modelErrors) as [string, Record<string, string>][]) {
            const m = (p.models || []).find((x: any) => x.id === mid)
            const modelLabel = m?.displayName || m?.apiModel || mid
            for (const [, msg] of Object.entries(errs))
              this.toast(`${providerName}: ${modelLabel} — ${msg}`, 'error', 6000)
            this.expanded[p.id] = true
            if (!this.modelExpanded[p.id])
              this.modelExpanded[p.id] = {}
            this.modelExpanded[p.id][mid] = true
          }
          return
        }

        const snapshot = clone(p)
        const baseProviders = [...(this.state?.providers || [])]
        const idx = baseProviders.findIndex((x: any) => x.id === pid)
        const nextProviders = idx >= 0
          ? baseProviders.map((x: any) => x.id === pid ? snapshot : x)
          : [...baseProviders, snapshot]
        const requestId = uid('save')
        this.saveSnapshots[requestId] = { targetIds: [pid], snapshots: { [pid]: snapshot } }
        this.savingProviders[pid] = true
        this.post('saveProviders', {
          requestId,
          targetIds: [pid],
          providers: JSON.parse(JSON.stringify(nextProviders)),
        })
      }
      catch (e) {
        this.toast(`Save error: ${e instanceof Error ? e.message : String(e)}`, 'error')
      }
    },

    // ── Autocomplete ──
    searchCatalog(pid: string, mid: string, query: string) {
      if (acTimer)
        clearTimeout(acTimer)
      const q = query.trim()
      if (q.length < 2 && !this.ac) {
        return
      }
      acTimer = setTimeout(() => {
        const reqId = ++this.acReqId
        this.ac = { pid, mid, results: [], selected: 0, reqId }
        vscode.postMessage({ type: 'searchCatalog', query: q.length >= 2 ? q : '', requestId: reqId })
      }, 120)
    },

    toggleCatalog(pid: string, mid: string, inputEl: HTMLInputElement | null) {
      if (this.ac?.pid === pid && this.ac?.mid === mid) {
        this.ac = null
        return
      }
      const q = (inputEl?.value ?? '').trim()
      const reqId = ++this.acReqId
      this.ac = { pid, mid, results: [], selected: 0, reqId }
      vscode.postMessage({ type: 'searchCatalog', query: q, requestId: reqId })
      inputEl?.focus()
    },

    applyCatalogEntry(pid: string, mid: string, entry: any) {
      const d = this.ensureDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return

      // id 保持 addModel 生成的随机值不变 — 作为跨 provider 全局唯一 key
      m.apiModel = entry.id
      if (!m.displayName?.trim())
        m.displayName = entry.name
      if (m.contextTokenLimit === undefined || m.contextTokenLimit === null) {
        m.contextTokenLimit = entry.contextLimit
        m.contextTokenLimitForMaxMode = entry.contextLimit
      }
      if (!m.thinking && entry.reasoning) {
        m.thinking = true
        if (!m.thinkingLevel && !m.thinkingBudgetTokens) {
          const pType = d.type
          m.thinkingLevel = pType === 'anthropic' ? 'high' : 'medium'
        }
      }
      if ((m.maxOutputTokens === undefined || m.maxOutputTokens === null) && entry.outputLimit)
        m.maxOutputTokens = entry.outputLimit
      if (m.supportsAgent === undefined)
        m.supportsAgent = entry.toolCall
      if (m.supportsImages === undefined)
        m.supportsImages = entry.hasImages

      this.ac = null
      // x-effect 在 input 聚焦时不回写 DOM，blur 后又不重跑（m.apiModel 无二次变化）。
      // 因此手动将选中的 entry.id 写入 DOM 再 blur，确保完整 model ID 上屏。
      queueMicrotask(() => {
        if (document.activeElement instanceof HTMLInputElement) {
          document.activeElement.value = m.apiModel || ''
          document.activeElement.blur()
        }
      })
    },

    acNavigate(dir: number) {
      if (!this.ac || !this.ac.results.length)
        return
      this.ac.selected = Math.max(0, Math.min(this.ac.selected + dir, this.ac.results.length - 1))
    },

    acSelect(pid: string, mid: string) {
      if (!this.ac || !this.ac.results.length)
        return
      const entry = this.ac.results[this.ac.selected]
      if (entry)
        this.applyCatalogEntry(pid, mid, entry)
    },

    acClose() {
      this.ac = null
    },

    // ── Remote Models (GET /v1/models) ──
    fetchRemoteModels(pid: string) {
      if (this.remoteModels[pid]?.loading)
        return
      const draft = this.getDraft(pid)
      if (!draft.baseUrl?.trim()) {
        this.toast('Please set Base URL first', 'warn')
        return
      }
      if (!draft.auth?.value?.trim()) {
        this.toast('Please set Auth value first', 'warn')
        return
      }
      this.remoteModels = { ...this.remoteModels, [pid]: { loading: true } }
      this.post('fetchRemoteModels', { pid, draft: JSON.parse(JSON.stringify(draft)) })
    },

    dismissRemoteModels(pid: string) {
      const { [pid]: _, ...rest } = this.remoteModels
      this.remoteModels = rest
    },

    /** 余额查询 — loading 中幂等跳过 */
    fetchBalance(pid: string) {
      if (this.balance[pid]?.loading)
        return
      this.balance = { ...this.balance, [pid]: { loading: true } }
      this.post('getBalance', { pid, draft: JSON.parse(JSON.stringify(this.getDraft(pid))) })
    },

    /**
     * 获取模型 — 拉取白名单模型并自动全部添加 (覆盖式)。
     * 添加完成后自动保存 (走 validate 验权 → saveProviders)。
     */
    fetchAndApplyModels(pid: string, fromOnboarding = false) {
      if (this.remoteModels[pid]?.loading)
        return
      const draft = this.getDraft(pid)
      if (!draft.baseUrl?.trim()) {
        this.toast('Please set Base URL first', 'warn')
        return
      }
      if (!draft.auth?.value?.trim()) {
        this.toast('请先输入 API Key', 'warn')
        return
      }
      this.remoteModels = { ...this.remoteModels, [pid]: { loading: true } }
      // onboardPid=true 表示由引导卡发起 → 失败时删除残留 draft 并把错误回显到引导卡; 成功时收起引导卡
      if (fromOnboarding)
        this.onboardingPid = pid
      this.post('fetchRemoteModels', { pid, draft: JSON.parse(JSON.stringify(draft)), autoApply: true })
    },

    /**
     * 远端模型 → 覆盖式写入 draft.models (用户不可改参数)。
     *   - 白名单命中: 参数全部来自远端条目; supportsThinking=true → thinking=true + thinkingLevel='medium' (合法档位, 避免 budget 校验拦截)
     *   - 白名单外 (远端有但白名单无): 不隐藏, 显示名加 [非白名单] 前缀, 默认 上下文200k / 最大输出64k / 不识图 / 思考开 / 可max
     */
    applyAllRemoteModels(pid: string) {
      const remote = this.remoteModels[pid]?.models || []
      const d = this.ensureDraft(pid)
      d.models = remote.map((rm: any) => {
        const w = rm.whitelist
        if (w) {
          const thinking = w.supportsThinking !== false
          return {
            id: uid('model'),
            apiModel: w.id,
            displayName: w.displayName,
            thinking,
            ...(thinking ? { thinkingLevel: 'medium' as const } : {}),
            defaultOn: true,
            supportsImages: w.supportsImages,
            supportsMaxMode: w.supportsMaxMode,
            contextTokenLimit: w.contextTokenLimit,
            maxOutputTokens: w.maxOutputTokens,
          }
        }
        // 白名单外: 默认 200k ctx / 64k out / 不识图 / 思考开+medium / 可max
        return {
          id: uid('model'),
          apiModel: rm.id,
          displayName: `[非白名单] ${rm.id}`,
          thinking: true,
          thinkingLevel: 'medium' as const,
          defaultOn: true,
          supportsImages: false,
          supportsMaxMode: true,
          contextTokenLimit: 200000,
          maxOutputTokens: 64000,
        }
      })
      // 模型不可展开 — 清理展开状态
      delete this.modelExpanded[pid]
      // 自动保存验权
      this.saveProvider(pid)
    },

    applyRemoteModel(pid: string, modelId: string) {
      this.addModel(pid)
      const d = this.ensureDraft(pid)
      const models = d.models || []
      const lastModel = models[models.length - 1]
      if (lastModel) {
        lastModel.apiModel = modelId
        // 白名单命中 → 用远端条目自动填参; 未命中兜底保留裸 id
        const entry = (this.remoteModels[pid]?.models || []).find((m: any) => m.id === modelId)?.whitelist
        if (entry) {
          lastModel.apiModel = entry.id
          lastModel.displayName = entry.displayName
          lastModel.thinking = entry.supportsThinking
          lastModel.supportsImages = entry.supportsImages
          lastModel.supportsMaxMode = entry.supportsMaxMode
          lastModel.contextTokenLimit = entry.contextTokenLimit
          lastModel.maxOutputTokens = entry.maxOutputTokens
        }
      }
    },
    /** apiModel blur — id 保持不变,不再同步覆盖 */
    syncModelId(_pid: string, _mid: string) {
      // id 是 addModel 生成的随机值,作为全局唯一 key,不随 apiModel 变化
    },

    /** 获取单个 model 的校验错误 (供模板使用, 避免长表达式) */
    getModelErrors(pid: string, mid: string): Record<string, string> {
      return this.validate(pid).modelErrors[mid] || {}
    },

    fmtCtx(n: number): string {
      if (n >= 1_000_000) {
        const v = n / 1_000_000
        return `${Number.isInteger(v) ? v : v.toFixed(1)}M`
      }
      if (n >= 1_000)
        return `${Math.round(n / 1_000)}k`
      return String(n)
    },

    // ── 通信 ──
    post(type: string, payload?: any) {
      vscode.postMessage({ type, ...payload })
    },
  }

  Alpine.store('app', store)
  // 面板头部 logo — layout 通过 <meta name="logo-uri"> 注入 webview URI
  const logoMeta = document.querySelector('meta[name="logo-uri"]')
  store.logoUri = logoMeta?.getAttribute('content') || ''

  // ── 消息接收 ──
  window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data
    const s = Alpine.store('app') as any

    if (msg?.type === 'state') {
      s.state = msg.state
      if (msg.state?.webTools)
        s.webTools = clone(msg.state.webTools)
      for (const pid of Object.keys(s.drafts)) {
        const base = (s.state?.providers || []).find((p: any) => p.id === pid)
        if (base && providersEqual(base, s.drafts[pid]))
          delete s.drafts[pid]
      }
    }
    else if (msg?.type === 'saveProvidersResult') {
      if (msg.state) {
        s.state = msg.state
        if (msg.state?.webTools)
          s.webTools = clone(msg.state.webTools)
      }
      const requestId = msg.requestId as string
      const pending = requestId ? s.saveSnapshots[requestId] : null
      const targetIds = pending?.targetIds || msg.targetIds || []
      for (const pid of targetIds)
        delete s.savingProviders[pid]
      if (!msg.ok) {
        // 引导卡自动保存失败 → 错误回显引导卡 + 删除残留 draft
        if (s.onboardingPid && targetIds.includes(s.onboardingPid)) {
          const pid = s.onboardingPid
          const draft = s.drafts[pid]
          const saved = (s.state?.providers || []).some((p: any) => p.id === pid)
          if (draft && !saved) {
            delete s.drafts[pid]
            delete s.expanded[pid]
          }
          s.onboarding = { ...s.onboarding, connecting: false, error: `保存失败: ${msg.error || 'unknown error'}` }
        }
        else {
          s.toast(`Save failed: ${msg.error || 'unknown error'}`, 'error', 6000)
        }
      }
      else {
        for (const pid of targetIds) {
          const sent = pending?.snapshots?.[pid]
          const current = s.drafts[pid]
          const base = (s.state?.providers || []).find((p: any) => p.id === pid)
          if (sent && current && providersEqual(current, sent))
            delete s.drafts[pid]
          else if (sent && !current && base && providersEqual(base, sent))
            delete s.drafts[pid]
          else if (!sent && base && current && providersEqual(base, current))
            delete s.drafts[pid]
        }
        s.toast('Providers saved.', 'info')
      }
      if (requestId)
        delete s.saveSnapshots[requestId]
    }
    else if (msg?.type === 'remoteModelsResult') {
      const pid = msg.pid as string
      if (msg.error) {
        s.remoteModels = { ...s.remoteModels, [pid]: { loading: false, error: msg.error } }
        // 引导卡发起的连接失败 (如 401 Invalid token):
        //   1. 删除引导卡新建的残留 draft (避免面板多出一个空的「默认」卡)
        //   2. 错误回显到引导卡 (友好提示), 不额外弹 toast
        if (s.onboardingPid === pid) {
          const draft = s.drafts[pid]
          const saved = (s.state?.providers || []).some((p: any) => p.id === pid)
          if (draft && !saved) {
            delete s.drafts[pid]
            delete s.expanded[pid]
          }
          s.onboardingPid = null
          s.onboarding = { ...s.onboarding, connecting: false, error: `连接失败: ${msg.error}` }
        }
        else {
          s.toast(`获取模型失败: ${msg.error}`, 'error', 6000)
        }
      }
      else {
        s.remoteModels = { ...s.remoteModels, [pid]: { loading: false, models: msg.models || [] } }
        // 「获取模型」流程: 拉取成功 → 覆盖式自动添加全部白名单模型 → 自动保存验权
        if (msg.autoApply) {
          // 引导卡连接成功 → 收起引导卡, 展开新 Key 卡
          if (s.onboardingPid === pid) {
            s.onboardingOpen = false
            s.onboardingPid = null
            s.onboarding = { keyName: '', apiKey: '', connecting: false, error: '' }
            s.expanded[pid] = true
          }
          s.applyAllRemoteModels(pid)
        }
      }
    }
    else if (msg?.type === 'balanceResult') {
      const pid = msg.pid as string
      if (msg.error) {
        // 失败不 toast, 仅存 error 供 UI 隐藏余额行
        s.balance = { ...s.balance, [pid]: { loading: false, error: msg.error } }
      }
      else if (msg.balance) {
        s.balance = { ...s.balance, [pid]: { loading: false, ...msg.balance } }
      }
    }
    else if (msg?.type === 'catalogResults') {
      if (!s.ac || msg.requestId !== s.ac.reqId)
        return
      s.ac.results = msg.results || []
      s.ac.selected = 0
    }
    else if (msg?.type === 'toast') {
      s.toast(msg.text, msg.level || 'info', msg.duration ?? 4000)
    }
  })

  // 通知 extension 就绪
  vscode.postMessage({ type: 'ready' })
}
