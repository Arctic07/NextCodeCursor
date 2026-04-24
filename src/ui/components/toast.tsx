export function ToastContainer() {
  return (
    <div
      class="toast-container"
      {...{ 'x-show': '($store.app.toasts || []).length > 0' }}
      x-cloak
    >
      <template {...{ 'x-for': 't in ($store.app.toasts || [])', 'x-bind:key': 't.id' }}>
        <div
          class="toast"
          {...{
            'x-bind:class': '\'toast-\' + t.level',
            'x-text': 't.text',
            'x-on:click': '$store.app.dismissToast(t.id)',
          }}
        >
        </div>
      </template>
    </div>
  )
}
