import { CustomSelect } from './custom-select'
import { ModelsSection } from './models-section'

const PROVIDER_TYPES = [
  { value: 'anthropic', label: 'anthropic' },
  { value: 'openai-chat', label: 'openai-chat' },
  { value: 'openai-responses', label: 'openai-responses' },
  { value: 'gemini', label: 'gemini' },
]

/**
 * 单个 Provider 折叠面板 — NextCode 专属精简版。
 *
 * 与通用版的差异:
 *   - 无 Base URL / Auth Value / Proxy / Custom Headers 字段 (连接时已固定, 面板不暴露)
 *   - 无余额展示
 *   - 仅保留: Key 名称、Type 选择 (默认 openai-chat)、模型开关列表
 *   - 模型不可展开编辑 (白名单自动填参)
 */
export function ProviderAccordion() {
  return (
    <div class="acc" {...{ 'x-bind:class': '{ \'dirty\': $store.app.isDirty(p.id) }' }}>
      {/* Head — 始終可見 */}
      <div class="acc-head" {...{ 'x-on:click': '$store.app.toggleExpand(p.id)' }}>
        <span class="acc-caret" {...{ 'x-text': '$store.app.expanded[p.id] ? \'▼\' : \'▶\'' }}></span>
        <span class="acc-title" {...{ 'x-text': '$store.app.getDraftOrOriginal(p.id).name || \'(unnamed)\'' }}></span>
        <span class="acc-type" {...{ 'x-text': '$store.app.getDraftOrOriginal(p.id).type' }}></span>
        <span class="acc-meta" {...{ 'x-text': '($store.app.getDraftOrOriginal(p.id).models || []).length + \' model\' + (($store.app.getDraftOrOriginal(p.id).models || []).length === 1 ? \'\' : \'s\')' }}></span>
        <span class="acc-dot" title="Unsaved changes" {...{ 'x-show': '$store.app.isDirty(p.id)' }}></span>
      </div>
      {/* Body — 可折叠 */}
      <div class="acc-body" {...{ 'x-show': '$store.app.expanded[p.id]' }} x-cloak>
        {/* Key 名称 — 可编辑 (显示用) */}
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
        </div>
        {/* Type — 默认 openai-chat; 切换仅影响请求协议, baseUrl/auth 保持不变 */}
        <div class="field">
          <label>Type</label>
          <CustomSelect
            valueExpr="$store.app.getDraft(p.id).type"
            changeExpr="$store.app.updateField(p.id, 'type', $value); $store.app.normalizeAuthKind(p.id)"
            options={PROVIDER_TYPES}
          />
        </div>
        <ModelsSection />
        <div class="actions-bar">
          <button class="danger" {...{ 'x-on:click': '$store.app.deleteProvider(p.id)' }}>Delete</button>
          <button class="ghost" {...{ 'x-on:click': '$store.app.resetProvider(p.id)' }}>Reset</button>
          <button {...{ 'x-on:click': '$store.app.saveProvider(p.id)' }}>Save</button>
        </div>
      </div>
    </div>
  )
}
