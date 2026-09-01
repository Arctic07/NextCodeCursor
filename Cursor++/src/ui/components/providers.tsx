import { ProviderAccordion } from './provider-accordion'

/** Key 引导卡 — 无中转 provider 或点击「+ 添加 Key」时显示 */
export function KeyOnboarding() {
  return (
    <div class="key-onboard" x-show="$store.app.onboardingOpen || !$store.app.hasRelayProvider">
      <div class="brand-header">
        <img x-bind:src="$store.app.logoUri || ''" alt="" width="28" height="28" class="brand-logo-img" />
        <span>NextCode 中转站</span>
      </div>
      <div class="field">
        <label>Key 名称</label>
        <input
          type="text"
          placeholder="名称自定义，用于区分不同 Key（如 工作号/私人）"
          x-model="$store.app.onboarding.keyName"
        />
      </div>
      <div class="field">
        <label>API Key</label>
        <input type="password" placeholder="sk-..." x-model="$store.app.onboarding.apiKey" />
      </div>
      <div class="key-onboard-error" x-show="$store.app.onboarding.error" x-text="$store.app.onboarding.error"></div>
      <div class="key-onboard-actions">
        <button x-on:click="$store.app.connectKey()" x-bind:disabled="$store.app.onboarding.connecting">
          <span x-show="!$store.app.onboarding.connecting">连接</span>
          <span x-show="$store.app.onboarding.connecting">连接中…</span>
        </button>
        <button class="ghost" x-show="$store.app.hasRelayProvider" x-on:click="$store.app.cancelOnboarding()">取消</button>
      </div>
      <div class="field-hint">连接后自动拉取可用模型（仅白名单），可多 Key 并存</div>
    </div>
  )
}

/** Provider 列表容器 — 仅显示 NextCode 中转 provider; 引导卡常驻 DOM (x-show 切换) */
export function Providers() {
  return (
    <div>
      {/* 引导卡: 常驻 DOM。x-if 会在 hasRelayProvider=true 时卸载它, 导致「+ 添加 Key」置 onboardingOpen 后仍无内容可显 */}
      <KeyOnboarding />
      <template x-for="(p, pIdx) in $store.app.relayProviders" x-bind:key="p.id">
        <ProviderAccordion />
      </template>
    </div>
  )
}
