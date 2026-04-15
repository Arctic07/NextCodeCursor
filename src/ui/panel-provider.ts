/**
 * Cursor++ 侧边栏面板 — Server 控制 + Provider 配置
 *
 * 渲染策略:
 *   - Hono JSX 生成带 Alpine 指令的静态 HTML (extension host 侧, 一次性)
 *   - dist/webview.js (Alpine.js + store) 内联注入, 接管所有交互
 *   - 通过 postMessage 与 extension host 双向通信
 *
 * Provider 机制:
 *   - 数据源: ~/.ccursor/providers.json (通过 providersStore)
 *   - Alpine store 管理 drafts / expanded / autocomplete 等 UI 状态
 *   - 所有表单交互由 Alpine 响应式处理, 无 innerHTML 重写
 */
import type { ProviderEntry } from '../server/data/defaults'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { bumpRefreshSignal } from '../server'
import { searchCatalog } from '../server/config/catalogStore'
import { updateProviders } from '../server/config/providersStore'
import { resetProviderInstanceCache } from '../server/handlers/llm/providerRuntime'
import { renderHtml } from './components/layout'
import { getState, onStateChange, refreshState } from './state'

let webviewJsCache: string | null = null

function getWebviewJs(extensionPath: string): string {
  if (!webviewJsCache) {
    const raw = readFileSync(join(extensionPath, 'dist', 'webview.js'), 'utf-8')
    // 内联 <script> 安全转义: </script> 和 <!-- 会被 HTML 解析器截断
    webviewJsCache = raw.replaceAll('</script>', '<\\/script>').replaceAll('<!--', '<\\!--')
  }
  return webviewJsCache
}

export class PanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cursor2plus.panel'

  private view?: vscode.WebviewView
  private context: vscode.ExtensionContext
  private disposeStateListener?: vscode.Disposable

  constructor(context: vscode.ExtensionContext) {
    this.context = context
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true }

    const webviewJs = getWebviewJs(this.context.extensionPath)

    // codicon 字体 — 引用 Cursor.app 内置的 codicon.ttf
    const cursorAppPath = vscode.Uri.file(join(this.context.extensionPath, '..', '..', 'out', 'media', 'codicon.ttf'))
    const codiconUri = webviewView.webview.asWebviewUri(cursorAppPath).toString()

    webviewView.webview.html = renderHtml(webviewJs, codiconUri)

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await refreshState()
          this.postState()
          break
        case 'refresh':
          await refreshState()
          this.postState()
          break
        case 'toggleByok':
          await vscode.commands.executeCommand('cursor2plus.toggleByok')
          break
        case 'toggleServer':
          await vscode.commands.executeCommand('cursor2plus.serverToggle')
          break
        case 'editRoutes':
          await vscode.commands.executeCommand('cursor2plus.editRoutes')
          break
        case 'editProvidersJson':
          await vscode.commands.executeCommand('cursor2plus.editProviders')
          break
        case 'toggleFileLog':
          await vscode.commands.executeCommand('cursor2plus.toggleFileLog')
          break
        case 'openLogFile':
          await vscode.commands.executeCommand('cursor2plus.openLogFile')
          break
        case 'searchCatalog': {
          const query = typeof msg.query === 'string' ? msg.query : ''
          const results = searchCatalog(query, 30)
          this.view?.webview.postMessage({
            type: 'catalogResults',
            requestId: msg.requestId,
            results,
          })
          break
        }
        case 'saveProviders': {
          const next = msg.providers as ProviderEntry[]
          try {
            await updateProviders((draft) => {
              draft.providers = next
            })
            resetProviderInstanceCache() // SDK client 用新 baseUrl/apiKey
            bumpRefreshSignal() // 通知 renderer EventSource 刷新模型选择器
            await refreshState()
            this.postState()
            vscode.window.showInformationMessage('Providers saved.')
          }
          catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            vscode.window.showErrorMessage(`Save providers failed: ${errMsg}`)
          }
          break
        }
      }
    })

    this.disposeStateListener?.dispose()
    this.disposeStateListener = onStateChange(() => this.postState())
    webviewView.onDidDispose(() => {
      this.disposeStateListener?.dispose()
      this.disposeStateListener = undefined
      this.view = undefined
    })
  }

  private postState() {
    if (!this.view)
      return
    const s = getState()
    this.view.webview.postMessage({ type: 'state', state: s })
  }
}
