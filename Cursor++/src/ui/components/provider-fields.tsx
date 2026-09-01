import { CustomSelect } from './custom-select'

const PROVIDER_TYPES = [
  { value: 'anthropic', label: 'anthropic' },
  { value: 'openai-chat', label: 'openai-chat' },
  { value: 'openai-responses', label: 'openai-responses' },
  { value: 'gemini', label: 'gemini' },
]

const AUTH_KINDS = [
  { value: 'apiKey', label: 'API Key' },
  { value: 'token', label: 'Bearer Token' },
]

/** Provider 表单字段 — 在 provider accordion body 内, x-for p 作用域 */
export function ProviderFields() {
  return (
    <>
      <div class="field">
        <label>Key 名称</label>
        <input
          type="text"
          placeholder="名称自定义，用于区分不同 Key（如 工作号/私人）"
          x-effect="if(document.activeElement !== $el) $el.value = $store.app.getDraft(p.id).name || ''"
          x-on:input="$store.app.updateField(p.id, 'name', $event.target.value)"
          x-bind:class="{ 'invalid': $store.app.validate(p.id).errors.name }"
        />
        <div class="err" x-show="$store.app.validate(p.id).errors.name" x-text="$store.app.validate(p.id).errors.name"></div>
        <div class="field-hint">名称自定义；多个 Key 有相同模型时显示为 名称/模型名</div>
      </div>
      {/*
        Type + Auth Kind 行:
          - Anthropic 同时支持 x-api-key 和 Bearer token, 显示下拉
          - openai-chat / openai-responses / gemini 只有 apiKey, Auth Kind 字段隐藏,
            Type 下拉占满整行
      */}
      <div class="field-row" x-show="$store.app.getDraft(p.id).type === 'anthropic'">
        <div class="field">
          <label>Type</label>
          <CustomSelect
            valueExpr="$store.app.getDraft(p.id).type"
            changeExpr="$store.app.updateField(p.id, 'type', $value); $store.app.normalizeAuthKind(p.id)"
            options={PROVIDER_TYPES}
          />
        </div>
        <div class="field">
          <label>Auth Kind</label>
          <CustomSelect
            valueExpr="$store.app.getDraft(p.id).auth?.kind"
            changeExpr="$store.app.updateField(p.id, 'auth.kind', $value)"
            options={AUTH_KINDS}
          />
        </div>
      </div>
      <div class="field" x-show="$store.app.getDraft(p.id).type !== 'anthropic'" x-cloak>
        <label>Type</label>
        <CustomSelect
          valueExpr="$store.app.getDraft(p.id).type"
          changeExpr="$store.app.updateField(p.id, 'type', $value); $store.app.normalizeAuthKind(p.id)"
          options={PROVIDER_TYPES}
        />
      </div>
      <div class="field">
        <label>Base URL (leave empty for SDK default)</label>
        <input
          type="text"
          x-effect="if(document.activeElement !== $el) $el.value = $store.app.getDraft(p.id).baseUrl || ''"
          x-on:input="$store.app.updateField(p.id, 'baseUrl', $event.target.value)"
          placeholder="https://api.example.com"
          x-bind:class="{ 'invalid': $store.app.validate(p.id).errors.baseUrl }"
        />
        <div class="err" x-show="$store.app.validate(p.id).errors.baseUrl" x-text="$store.app.validate(p.id).errors.baseUrl"></div>
      </div>
      <div class="field" x-data="{ showKey: false }">
        <label>Auth Value</label>
        <div class="input-reveal">
          <input
            x-bind:type="showKey ? 'text' : 'password'"
            x-effect="if(document.activeElement !== $el) $el.value = $store.app.getDraft(p.id).auth?.value || ''"
            x-on:input="$store.app.updateField(p.id, 'auth.value', $event.target.value)"
            placeholder="sk-..."
            x-bind:class="{ 'invalid': $store.app.validate(p.id).errors.authValue }"
          />
          <button
            type="button"
            class="reveal-btn"
            x-on:click="showKey = !showKey"
            title="Toggle visibility"
          >
            <span x-bind:class="showKey ? 'codicon codicon-eye-closed' : 'codicon codicon-eye'"></span>
          </button>
        </div>
        <div class="err" x-show="$store.app.validate(p.id).errors.authValue" x-text="$store.app.validate(p.id).errors.authValue"></div>
      </div>
      <div class="field" x-show="$store.app.getDraft(p.id).type !== 'gemini'">
        <label>Proxy URL (optional)</label>
        <input
          type="text"
          x-effect="if(document.activeElement !== $el) $el.value = $store.app.getDraft(p.id).proxyUrl || ''"
          x-on:input="$store.app.updateField(p.id, 'proxyUrl', $event.target.value)"
          placeholder="http://127.0.0.1:8080"
        />
      </div>
      <div class="field">
        <label>
          {'Custom Headers (optional, JSON) '}
          <span style="opacity:.55;font-weight:normal;font-size:0.85em">e.g. anthropic-beta</span>
        </label>
        <textarea
          rows={2}
          style="font-family:var(--vscode-editor-font-family,monospace);font-size:0.9em;resize:vertical"
          {...{ 'x-effect': 'if(document.activeElement !== $el) $el.value = $store.app.formatHeaders(p.id)' }}
          {...{ 'x-on:input': '$store.app.updateHeaders(p.id, $event.target.value)' }}
          {...{ 'x-bind:class': '{ \'invalid\': $store.app.headersInvalid[p.id] }' }}
          placeholder={'{"anthropic-beta": "interleaved-thinking-2025-05-14"}'}
        >
        </textarea>
        <div class="err" {...{ 'x-show': '$store.app.headersInvalid[p.id]' }}>Invalid JSON</div>
      </div>
    </>
  )
}
