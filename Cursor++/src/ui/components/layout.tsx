/**
 * Root layout — Hono JSX 生成完整 HTML, 内嵌 Alpine 指令 + webview JS
 *
 * renderHtml(webviewJs) 在 extension host 侧调用一次,
 * 产出的 HTML 字符串赋给 webview.html, 之后 Alpine.js 接管所有交互。
 */
import { Banner } from './banner'
import { Footer } from './footer'
import { Providers } from './providers'
import { WebToolsButton, WebToolsDialog } from './search-section'
import { Server } from './server'
import { styles } from './styles'
import { ToastContainer } from './toast'

function Layout({ webviewJs, codiconUri, logoUri }: { webviewJs: string, codiconUri?: string, logoUri?: string }) {
  const codiconCss = codiconUri
    ? `@font-face { font-family: 'codicon'; font-display: block; src: url('${codiconUri}') format('truetype'); }
       .codicon { font-family: 'codicon'; font-size: 14px; line-height: 1; display: inline-block; -webkit-font-smoothing: antialiased; }
       .codicon::before { display: inline-block; }
       .codicon-eye::before { content: "\\ea70"; }
       .codicon-eye-closed::before { content: "\\eae7"; }`
    : ''

  return (
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="logo-uri" content={logoUri || ''} />
        <style>{codiconCss + styles}</style>
      </head>
      <body x-data>
        <div class="brand-header">
          <img src={logoUri || ''} alt="" width="20" height="20" class="brand-logo-img" />
          <span>NextCode</span>
        </div>

        <Banner />

        <h3>
          <span>Server</span>
          <span
            style="float:right;font-size:0.85em;font-weight:500;color:var(--vscode-descriptionForeground)"
            {...{ 'x-effect': '$el.textContent = \'v\' + ($store.app.state?.version || \'\')' }}
          >
          </span>
        </h3>
        <Server />

        <h3>
          <span>Providers</span>
          <span class="h3-actions">
            <WebToolsButton />
            <button class="search-btn" x-on:click="$store.app.onboardingOpen = true">+ 添加 Key</button>
          </span>
        </h3>
        <Providers />

        <WebToolsDialog />

        <Footer />
        <ToastContainer />

        <script dangerouslySetInnerHTML={{ __html: webviewJs }} />
      </body>
    </html>
  )
}

/** 生成完整 HTML 字符串 (extension host 侧调用) */
/** 生成完整 HTML 字符串 (extension host 侧调用) */
export function renderHtml(webviewJs: string, codiconUri?: string, logoUri?: string): string {
  const html = (<Layout webviewJs={webviewJs} codiconUri={codiconUri} logoUri={logoUri} />).toString()
  return `<!DOCTYPE html>${html}`
}
