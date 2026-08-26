import { ProviderAccordion } from './provider-accordion'

/** Provider 列表容器 */
export function Providers() {
  return (
    <div>
      <template x-if="$store.app.providers.length === 0">
        <div class="empty">
          No providers configured. Click
          <b>+ Add</b>
          {' '}
          to create one.
        </div>
      </template>
      <template x-for="(p, pIdx) in $store.app.providers" x-bind:key="p.id">
        <ProviderAccordion />
      </template>
    </div>
  )
}
