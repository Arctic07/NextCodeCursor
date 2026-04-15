import { ModelCard } from './model-card'

/** Models 子区域 — 在 provider accordion body 内 */
export function ModelsSection() {
  return (
    <div class="models-section">
      <div class="models-header">
        <span class="models-title" x-text="'Models (' + ($store.app.getDraft(p.id).models || []).length + ')'"></span>
        <button class="tiny secondary" x-on:click="$store.app.addModel(p.id)">+ Add Model</button>
      </div>
      <template x-if="!$store.app.getDraft(p.id).models || $store.app.getDraft(p.id).models.length === 0">
        <div class="model-empty">
          No models. Click
          <b>+ Add Model</b>
          {' '}
          to add one.
        </div>
      </template>
      <template x-for="m in ($store.app.getDraft(p.id).models || [])" x-bind:key="m.id">
        <ModelCard />
      </template>
    </div>
  )
}
