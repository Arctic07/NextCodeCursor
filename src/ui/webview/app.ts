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

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
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

    get serverLabel(): string {
      const s = this.state
      if (!s)
        return ''
      if (s.server === 'local')
        return `Running on :${s.port} (this instance)`
      if (s.server === 'remote')
        return `Running on :${s.port} (another instance)`
      return 'Offline'
    },

    // ── Draft 管理 ──
    getDraft(pid: string): any {
      if (!this.drafts[pid]) {
        const base = (this.state?.providers || []).find((p: any) => p.id === pid)
        if (base) {
          this.drafts[pid] = clone(base)
        }
        else {
          return {}
        }
      }
      return this.drafts[pid]
    },

    getDraftOrOriginal(pid: string): any {
      return this.drafts[pid] || (this.state?.providers || []).find((p: any) => p.id === pid) || {}
    },

    isDirty(pid: string): boolean {
      const draft = this.drafts[pid]
      if (!draft)
        return false
      const base = (this.state?.providers || []).find((p: any) => p.id === pid)
      if (!base)
        return true // new, not saved
      return JSON.stringify(base) !== JSON.stringify(draft)
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
        for (const f of OPTIONAL_NUM_FIELDS) {
          const v = m[f]
          if (v === undefined || v === null || v === '')
            continue
          if (!Number.isFinite(Number(v)) || Number(v) < 0 || !Number.isInteger(Number(v))) {
            me[f] = 'Must be a non-negative integer'
          }
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
      const d = this.getDraft(pid)
      if (field === 'auth.kind') {
        d.auth = { ...(d.auth || {}), kind: value }
      }
      else if (field === 'auth.value') {
        d.auth = { ...(d.auth || {}), value }
      }
      else {
        d[field] = value
      }
    },

    /**
     * 切换 provider type 后规范化 auth.kind:
     *   - anthropic 同时支持 apiKey / bearer token, 保留用户选择
     *   - 其他 provider (openai-chat / openai-responses / gemini) 只支持 apiKey,
     *     强制重置为 apiKey 避免旧的 "token" 残留污染
     */
    normalizeAuthKind(pid: string) {
      const d = this.getDraft(pid)
      if (d.type !== 'anthropic') {
        d.auth = { ...(d.auth || { value: '' }), kind: 'apiKey' }
      }
    },

    updateModelField(pid: string, mid: string, field: string, value: any) {
      const d = this.getDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return

      if (field === 'thinkingLevel') {
        if (!value)
          delete m.thinkingLevel
        else m.thinkingLevel = value
      }
      else {
        m[field] = value
      }

      // id = apiModel 同步 — 仅在 blur 时触发, 不在每次 input 时触发
      // 避免 x-for key 变化导致 DOM 销毁重建 + 输入脱焦
      // 实际同步由 syncModelId() 在 blur 事件中调用
    },

    updateModelNumber(pid: string, mid: string, field: string, raw: string) {
      const d = this.getDraft(pid)
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
    },

    // ── Provider / Model 增删 ──
    addProvider() {
      const p = {
        id: uid('provider'),
        name: 'New Provider',
        type: 'anthropic',
        baseUrl: '',
        auth: { kind: 'apiKey', value: '' },
        models: [],
      }
      this.drafts[p.id] = p
      this.expanded[p.id] = true
    },

    addModel(pid: string) {
      const d = this.getDraft(pid)
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
      const d = this.getDraft(pid)
      d.models = (d.models || []).filter((x: any) => x.id !== mid)
      if (this.modelExpanded[pid])
        delete this.modelExpanded[pid][mid]
    },

    resetProvider(pid: string) {
      delete this.drafts[pid]
      const base = (this.state?.providers || []).find((p: any) => p.id === pid)
      if (!base) {
        delete this.expanded[pid]
        delete this.modelExpanded[pid]
      }
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
      const v = this.validate(pid)
      if (!v.ok)
        return
      // JSON roundtrip 去除 Alpine reactive proxy, 确保 postMessage structured clone 正常序列化
      this.post('saveProviders', { providers: JSON.parse(JSON.stringify(this.providers)) })
    },

    // ── Autocomplete ──
    searchCatalog(pid: string, mid: string, query: string) {
      if (acTimer)
        clearTimeout(acTimer)
      const q = query.trim()
      if (q.length < 2) {
        this.ac = null
        return
      }
      acTimer = setTimeout(() => {
        const reqId = ++this.acReqId
        this.ac = { pid, mid, results: [], selected: 0, reqId }
        vscode.postMessage({ type: 'searchCatalog', query: q, requestId: reqId })
      }, 120)
    },

    applyCatalogEntry(pid: string, mid: string, entry: any) {
      const d = this.getDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m)
        return

      const oldId = m.id
      m.apiModel = entry.id
      m.id = entry.id
      if (!m.displayName?.trim())
        m.displayName = entry.name
      if (m.contextTokenLimit === undefined || m.contextTokenLimit === null) {
        m.contextTokenLimit = entry.contextLimit
        m.contextTokenLimitForMaxMode = entry.contextLimit
      }
      if (!m.thinking)
        m.thinking = entry.reasoning
      if (m.supportsAgent === undefined)
        m.supportsAgent = entry.toolCall
      if (m.supportsImages === undefined)
        m.supportsImages = entry.hasImages

      // 同步 expand key
      if (this.modelExpanded[pid]?.[oldId]) {
        delete this.modelExpanded[pid][oldId]
        this.modelExpanded[pid][m.id] = true
      }

      this.ac = null
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

    /** apiModel blur 时同步 m.id — 避免每次 keystroke 改 key 导致脱焦 */
    syncModelId(pid: string, mid: string) {
      const d = this.getDraft(pid)
      const m = (d.models || []).find((x: any) => x.id === mid)
      if (!m || !m.apiModel || m.id === m.apiModel)
        return
      const oldId = m.id
      m.id = m.apiModel
      if (this.modelExpanded[pid]?.[oldId]) {
        delete this.modelExpanded[pid][oldId]
        this.modelExpanded[pid][m.id] = true
      }
    },

    /** 获取单个 model 的校验错误 (供模板使用, 避免长表达式) */
    getModelErrors(pid: string, mid: string): Record<string, string> {
      return this.validate(pid).modelErrors[mid] || {}
    },

    fmtCtx(n: number): string {
      if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`
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

  // ── 消息接收 ──
  window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data
    const s = Alpine.store('app') as any

    if (msg?.type === 'state') {
      s.state = msg.state
      // 清理与 state 一致的 drafts
      for (const pid of Object.keys(s.drafts)) {
        const base = (s.state?.providers || []).find((p: any) => p.id === pid)
        if (base && JSON.stringify(base) === JSON.stringify(s.drafts[pid])) {
          delete s.drafts[pid]
        }
      }
    }
    else if (msg?.type === 'catalogResults') {
      if (!s.ac || msg.requestId !== s.ac.reqId)
        return
      s.ac.results = msg.results || []
      s.ac.selected = 0
    }
  })

  // 通知 extension 就绪
  vscode.postMessage({ type: 'ready' })
}
