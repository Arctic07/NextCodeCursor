/** Server 状态行 */
export function Server() {
  return (
    <div x-show="$store.app.state" class="server-row">
      <span>
        <span x-text="$store.app.state?.server === 'offline' ? '🔴' : '🟢'"></span>
        {' '}
        <span x-text="$store.app.serverLabel"></span>
      </span>
      <button
        x-show="$store.app.state?.server === 'local' || $store.app.state?.server === 'offline'"
        x-text="$store.app.state?.server === 'local' ? 'Stop Server' : 'Start Server'"
        x-on:click="$store.app.post('toggleServer')"
      >
      </button>
    </div>
  )
}
