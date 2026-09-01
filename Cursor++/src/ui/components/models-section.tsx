/**
 * Models 子区域 — NextCode 专属精简版。
 *
 * - 「获取模型」= fetchRemoteModels + 自动添加全部白名单模型
 * - 已添加模型平铺显示: 仅显示名 + defaultOn 开关, 不可展开编辑 (参数来自白名单)
 * - 无 + Add Model (不允许自定义模型)
 */
export function ModelsSection() {
  return (
    <div class="models-section" style="position:relative">
      {/* Loading 遮罩 */}
      <template {...{ 'x-if': '$store.app.remoteModels[p.id] && $store.app.remoteModels[p.id].loading' }}>
        <div class="models-loading-overlay">
          <span class="models-loading-spinner">获取模型中…</span>
        </div>
      </template>

      <div class="models-header">
        <span
          class="models-title"
          {...{ 'x-text': '\'模型 (\' + ($store.app.getDraft(p.id).models || []).length + \')\'' }}
        >
        </span>
        <span class="models-header-actions">
          <button class="tiny secondary" {...{ 'x-on:click': '$store.app.fetchAndApplyModels(p.id)' }}>获取模型</button>
        </span>
      </div>

      <template {...{ 'x-if': '!$store.app.getDraft(p.id).models || $store.app.getDraft(p.id).models.length === 0' }}>
        <div class="model-empty">
          暂无模型。点击
          <b>获取模型</b>
          拉取白名单内可用模型。
        </div>
      </template>

      {/* 已添加模型 — 平铺开关列表, 不可展开 */}
      <div class="relay-model-list">
        <template {...{ 'x-for': 'm in ($store.app.getDraft(p.id).models || [])', 'x-bind:key': 'm.id' }}>
          <div class="relay-model-item">
            <span
              class="relay-model-name"
              {...{ 'x-text': '$store.app.modelDisplayName(p.id, m.id) || m.apiModel || m.id' }}
            >
            </span>
            <label
              class="model-switch"
              title="启用后模型出现在 Cursor 选择器列表中"
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
        </template>
      </div>
    </div>
  )
}
