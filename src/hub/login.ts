/**
 * Hub 登录流程 —— Device Authorization Grant
 *
 * 步骤:
 *   1. 调 /api/device/code 取 device_code + user_code + verify_url
 *   2. 复制 user_code 到剪贴板 + 弹通知提示
 *   3. openExternal 浏览器到 verify_url?user_code=XXX (web 侧预填)
 *   4. withProgress 通知里轮询 /api/device/token, interval 秒一次
 *   5. 授权后把 JWT 存 secrets
 */
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import { join, resolve } from 'node:path'
import * as vscode from 'vscode'
import { pollDeviceToken, requestDeviceCode, revokeSelf } from './client'
import { HUB_URL, SECRETS_JWT_KEY } from './config'

/**
 * 设备标识文本 —— Hub 设备管理页面上显示的展示名。
 *
 * 格式: "hostname / darwin arm64 / Cursor 3.0.16/0.0.4"
 *
 * 版本号: Cursor主版本/扩展版本, 紧凑拼接。
 * hostname 保证同架构设备可区分。
 * Hub server 侧真正区分设备靠 device_code (随机生成),
 * device_label 只是展示文本, 不影响鉴权逻辑。
 */
function deviceLabel(): string {
  const host = os.hostname()
  const extVer = vscode.extensions.getExtension('cometix-space.cursor2plus')?.packageJSON?.version ?? '?'
  const cursorVer = readCursorVersion()
  return `${host} / ${os.platform()} ${os.arch()} / Cursor ${cursorVer}/${extVer}`
}

/**
 * 从 Cursor.app 内置的 product.json 读取 Cursor 版本号。
 *
 * 路径反推:
 *   extension 安装在 <cursorRoot>/extensions/cursor2plus/dist/extension.js
 *   __dirname = .../extensions/cursor2plus/dist
 *   ../../.. = <cursorRoot> (即 Cursor.app/Contents/Resources/app)
 *   product.json 就在 <cursorRoot>/product.json
 *
 * 与 sqlite.ts 的 getCursorAppCandidates 使用相同的反推策略。
 */
function readCursorVersion(): string {
  try {
    const cursorRoot = resolve(__dirname, '..', '..', '..')
    const productJson = JSON.parse(readFileSync(join(cursorRoot, 'product.json'), 'utf-8'))
    return productJson.version ?? '?'
  }
  catch {
    return '?'
  }
}

export async function loginCommand(context: vscode.ExtensionContext): Promise<void> {
  let codeResp: Awaited<ReturnType<typeof requestDeviceCode>>
  try {
    codeResp = await requestDeviceCode(deviceLabel())
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    vscode.window.showErrorMessage(`Cursor++ Hub: 无法请求设备码 — ${msg}`)
    return
  }

  // 复制 user_code + 弹提示
  await vscode.env.clipboard.writeText(codeResp.user_code)
  const verifyUrlWithCode = `${codeResp.verify_url}?user_code=${encodeURIComponent(codeResp.user_code)}`
  const pick = await vscode.window.showInformationMessage(
    `设备码: ${codeResp.user_code} (已复制到剪贴板)`,
    { modal: false, detail: '点击打开浏览器完成 LinuxDO 授权,之后返回 Cursor。' },
    '打开浏览器授权',
    '取消',
  )
  if (pick !== '打开浏览器授权')
    return

  await vscode.env.openExternal(vscode.Uri.parse(verifyUrlWithCode))

  // 轮询
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Cursor++ Hub',
      cancellable: true,
    },
    async (progress, cancel) => {
      progress.report({ message: '等待授权中…' })
      const endAt = Date.now() + codeResp.expires_in * 1000
      let interval = Math.max(codeResp.interval, 2)

      while (Date.now() < endAt) {
        if (cancel.isCancellationRequested)
          return { outcome: 'cancelled' as const }

        await new Promise(r => setTimeout(r, interval * 1000))

        try {
          const poll = await pollDeviceToken(codeResp.device_code)
          if (poll.status === 'authorized' && poll.token && poll.user) {
            return { outcome: 'ok' as const, token: poll.token, user: poll.user }
          }
          if (poll.status === 'expired' || poll.status === 'denied' || poll.status === 'unknown') {
            return { outcome: 'failed' as const, reason: poll.status }
          }
          if (poll.status === 'slow_down') {
            interval = Math.min(interval + 2, 15)
          }
          // 'pending' → 继续等
        }
        catch {
          // 网络错误 → 继续重试直到超时
        }
      }
      return { outcome: 'timeout' as const }
    },
  )

  if (result.outcome === 'cancelled')
    return
  if (result.outcome === 'ok') {
    await context.secrets.store(SECRETS_JWT_KEY, result.token!)
    vscode.window.showInformationMessage(`Cursor++ Hub: 已登录为 ${result.user!.username}。请重新启动 BYOK Server 或通过命令面板刷新状态。`)
    return
  }
  if (result.outcome === 'failed') {
    const reasonMsg = { expired: '设备码已过期', denied: '授权被拒绝', unknown: '未知的设备码' }[result.reason!] ?? result.reason
    vscode.window.showErrorMessage(`Cursor++ Hub: 登录失败 — ${reasonMsg}`)
    return
  }
  vscode.window.showErrorMessage('Cursor++ Hub: 授权超时,请重新发起。')
}

export async function logoutCommand(context: vscode.ExtensionContext): Promise<void> {
  const token = await context.secrets.get(SECRETS_JWT_KEY)
  if (token)
    await revokeSelf(token)
  await context.secrets.delete(SECRETS_JWT_KEY)
  vscode.window.showInformationMessage('Cursor++ Hub: 已登出。')
}

/** 打开浏览器到 Hub 的"我的设备"页 */
export async function openDeviceManagerCommand(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(`${HUB_URL}/me/devices`))
}
