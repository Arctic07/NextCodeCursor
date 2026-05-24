/** 底部操作栏 */
export function Footer() {
  return (
    <div class="footer">
      <button class="secondary" x-on:click="$store.app.post('editRoutes')">Edit Routes</button>
      <button class="secondary" x-on:click="$store.app.post('editProvidersJson')">Edit providers.json</button>
    </div>
  )
}
