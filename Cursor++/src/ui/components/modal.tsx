/**
 * 通用 Modal 组件 — 浮动顶层对话框，可复用。
 *
 * showExpr: Alpine 表达式控制显隐 (如 "$store.app.searchDialogOpen")
 * title: 标题文字
 */
export function Modal({ showExpr, title, children }: { showExpr: string, title: string, children: any }) {
  return (
    <div class="modal-backdrop" x-show={showExpr} x-cloak {...{ 'x-on:click.self': `${showExpr} = false` }}>
      <div class="modal-dialog">
        <div class="modal-header">
          <span class="modal-title">{title}</span>
          <button class="modal-close" x-on:click={`${showExpr} = false`}>&times;</button>
        </div>
        <div class="modal-body">
          {children}
        </div>
      </div>
    </div>
  )
}
