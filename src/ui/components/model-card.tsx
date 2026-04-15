import { Autocomplete } from './autocomplete'
import { CustomSelect } from './custom-select'

const THINKING_LEVELS = [
  { value: '', label: '(auto)' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
]

/**
 * 单个 Model 卡片 — 在 x-for="m in ..." 作用域内使用
 *
 * 文本/数字输入框使用 x-effect + activeElement 守卫:
 *   - 非焦点时: x-effect 同步 store 值到 DOM (外部变更 / 初始化)
 *   - 焦点时: 只由 x-on:input 写 store, 不回写 DOM, 避免光标跳动
 *
 * apiModel 输入不再每次 keystroke 同步 m.id (会导致 x-for key 变化 → DOM 销毁重建 → 脱焦),
 * 改为 blur 时调用 syncModelId() 一次性同步。
 */
export function ModelCard() {
  return (
    <div class="model-item" x-data="{ me: {} }" x-effect="me = $store.app.getModelErrors(p.id, m.id)">
      <div class="model-head" x-on:click="$store.app.toggleModelExpand(p.id, m.id)">
        <span class="acc-caret" x-text="$store.app.modelExpanded[p.id]?.[m.id] ? '▼' : '▶'"></span>
        <span class="model-title" x-text="m.displayName || m.apiModel || m.id || '(unnamed model)'"></span>
        {/* 右对齐的 defaultOn 开关 — 控制模型是否注册到 Cursor 选择器。
            stop 阻止点击冒泡触发折叠/展开 */}
        <label
          class="model-switch"
          title="启用后模型出现在 Cursor 选择器列表中"
          {...{ 'x-on:click.stop': '' }}
        >
          <input
            type="checkbox"
            x-bind:checked="m.defaultOn === true"
            x-on:change="$store.app.updateModelField(p.id, m.id, 'defaultOn', $event.target.checked)"
          />
          <span class="model-switch-track"></span>
          <span class="model-switch-knob"></span>
        </label>
      </div>
      <div class="model-body" x-show="$store.app.modelExpanded[p.id]?.[m.id]" x-cloak>
        {/* API Model + autocomplete */}
        <div class="field autocomplete" {...{ 'x-on:click.outside': '$store.app.acClose()' }}>
          <label>
            {'API Model '}
            <span style="opacity:.5;font-weight:normal;text-transform:none">(fuzzy catalog search)</span>
          </label>
          <input
            type="text"
            x-effect="if(document.activeElement !== $el) $el.value = m.apiModel || ''"
            x-on:input="$store.app.updateModelField(p.id, m.id, 'apiModel', $event.target.value); $store.app.searchCatalog(p.id, m.id, $event.target.value)"
            {...{ 'x-on:blur': '$store.app.syncModelId(p.id, m.id)' }}
            {...{ 'x-on:keydown.arrow-down.prevent': '$store.app.acNavigate(1)' }}
            {...{ 'x-on:keydown.arrow-up.prevent': '$store.app.acNavigate(-1)' }}
            {...{ 'x-on:keydown.enter.prevent': '$store.app.acSelect(p.id, m.id)' }}
            {...{ 'x-on:keydown.escape.prevent': '$store.app.acClose()' }}
            autocomplete="off"
            x-bind:class="{'invalid': me?.apiModel}"
          />
          <div class="err" x-show="me?.apiModel" x-text="me?.apiModel"></div>
          <Autocomplete />
        </div>

        {/* Display Name — Cursor 客户端所有 UI 路径 (picker / inputbox / command palette)
            都走 clientDisplayName fallback, 不需要独立的 short name */}
        <div class="field">
          <label>
            {'Display Name '}
            <span style="color:var(--vscode-errorForeground);font-weight:normal" x-show="me?.displayName">*</span>
          </label>
          <input
            type="text"
            x-effect="if(document.activeElement !== $el) $el.value = m.displayName || ''"
            x-on:input="$store.app.updateModelField(p.id, m.id, 'displayName', $event.target.value)"
            x-bind:class="{'invalid': me?.displayName}"
          />
          <div class="err" x-show="me?.displayName" x-text="me?.displayName"></div>
        </div>

        {/* Capabilities grid */}
        <div class="caps">
          <label class="check">
            <input type="checkbox" x-bind:checked="m.supportsAgent !== false" x-on:change="$store.app.updateModelField(p.id, m.id, 'supportsAgent', $event.target.checked)" />
            {' Agent'}
          </label>
          <label class="check">
            <input type="checkbox" x-bind:checked="m.supportsImages !== false" x-on:change="$store.app.updateModelField(p.id, m.id, 'supportsImages', $event.target.checked)" />
            {' Images'}
          </label>
          <label class="check">
            <input type="checkbox" x-bind:checked="m.supportsCmdK !== false" x-on:change="$store.app.updateModelField(p.id, m.id, 'supportsCmdK', $event.target.checked)" />
            {' Cmd+K'}
          </label>
          <label class="check">
            <input type="checkbox" x-bind:checked="m.supportsPlanMode !== false" x-on:change="$store.app.updateModelField(p.id, m.id, 'supportsPlanMode', $event.target.checked)" />
            {' Plan'}
          </label>
          <label class="check">
            <input type="checkbox" x-bind:checked="m.supportsAutoContext !== false" x-on:change="$store.app.updateModelField(p.id, m.id, 'supportsAutoContext', $event.target.checked)" />
            {' Auto Ctx'}
          </label>
          <label class="check thinking-cell" title="Enables extended reasoning">
            <input type="checkbox" x-bind:checked="m.thinking === true" x-on:change="$store.app.updateModelField(p.id, m.id, 'thinking', $event.target.checked)" />
            {' Thinking'}
          </label>
          <div class="check thinking-level-cell">
            <CustomSelect
              valueExpr="m.thinkingLevel || ''"
              changeExpr="$store.app.updateModelField(p.id, m.id, 'thinkingLevel', $value || undefined)"
              options={THINKING_LEVELS}
              title="Thinking/reasoning effort level"
            />
          </div>
          {/* Thinking Budget — 紧跟 Thinking Level */}
          <div class="check thinking-budget-cell">
            <input
              type="number"
              x-effect="if(document.activeElement !== $el) $el.value = m.thinkingBudgetTokens ?? ''"
              x-on:input="$store.app.updateModelNumber(p.id, m.id, 'thinkingBudgetTokens', $event.target.value)"
              placeholder="budget tokens"
              title="Thinking budget tokens (optional, legacy Anthropic 4.x / Gemini precise)"
              style="height:20px;padding:0 4px;font-size:10px"
            />
          </div>
        </div>

        {/* Context limits */}
        <div class="field-row">
          <div class="field">
            <label>
              {'Context Token Limit '}
              <span style="color:var(--vscode-errorForeground);font-weight:normal">*</span>
            </label>
            <input
              type="number"
              x-effect="if(document.activeElement !== $el) $el.value = m.contextTokenLimit ?? ''"
              x-on:input="$store.app.updateModelNumber(p.id, m.id, 'contextTokenLimit', $event.target.value)"
              placeholder="required"
              x-bind:class="{'invalid': me?.contextTokenLimit}"
            />
            <div class="err" x-show="me?.contextTokenLimit" x-text="me?.contextTokenLimit"></div>
          </div>
          {/* autoContextMaxTokens 已移除 — 从 contextTokenLimit 自动派生, 用户无需配置 */}
        </div>

        {/* Tooltip */}
        <div class="field">
          <label>Tooltip Markdown (hover in model picker)</label>
          <textarea
            rows={2}
            x-effect="if(document.activeElement !== $el) $el.value = m.tooltipMarkdown || ''"
            x-on:input="$store.app.updateModelField(p.id, m.id, 'tooltipMarkdown', $event.target.value)"
            placeholder="**Model name**<br/>Short description"
          >
          </textarea>
        </div>

        <div class="actions-bar">
          <button class="danger tiny" x-on:click="$store.app.deleteModel(p.id, m.id)">Remove Model</button>
        </div>
      </div>
    </div>
  )
}
