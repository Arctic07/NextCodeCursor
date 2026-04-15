/**
 * 门控检查 —— 在 activate() 最前面调用
 *
 * 决策规则:
 *   - 无 JWT            → deny, 弹通知引导 login 命令
 *   - 有 JWT + 离线     → allow (缓存授权, 断网不影响使用)
 *   - 有 JWT + 401/403  → deny, 清 token, 提示重新登录
 *   - 有 JWT + 200      → allow, 缓存最新 username
 *   - 有 JWT + 5xx      → allow (服务器问题不应阻挡用户)
 *
 * gateCheck() 返回的状态由 activate 读取,决定是否注册 BYOK toggle / 启动 server。
 */
import * as vscode from 'vscode'
import { checkMe } from './client'
import { SECRETS_JWT_KEY } from './config'

export interface GateState {
  allowed: boolean
  reason: 'no_token' | 'unauthorized' | 'ok_cached' | 'ok_online'
  username?: string
}

export async function gateCheck(
  context: vscode.ExtensionContext,
  log: (msg: string) => void,
): Promise<GateState> {
  const token = await context.secrets.get(SECRETS_JWT_KEY)
  if (!token) {
    log('[HUB] no token → deny')
    return { allowed: false, reason: 'no_token' }
  }

  const me = await checkMe(token)
  if (me.ok) {
    log(`[HUB] online OK, user=${me.user.username}`)
    return { allowed: true, reason: 'ok_online', username: me.user.username }
  }
  if (me.reason === 'unauthorized') {
    // token 已失效,清掉
    await context.secrets.delete(SECRETS_JWT_KEY)
    log('[HUB] unauthorized → token cleared')
    return { allowed: false, reason: 'unauthorized' }
  }
  // offline 或 server_error 都放行 (缓存授权)
  log(`[HUB] ${me.reason} → allow cached`)
  return { allowed: true, reason: 'ok_cached' }
}

/** 激活后启动一个定时任务,每小时 re-check 一次;发现 unauthorized 立即停 server */
export function startPeriodicReCheck(
  context: vscode.ExtensionContext,
  onRevoked: () => Promise<void>,
  log: (msg: string) => void,
): vscode.Disposable {
  const INTERVAL_MS = 60 * 60 * 1000 // 1 小时
  const handle = setInterval(async () => {
    const token = await context.secrets.get(SECRETS_JWT_KEY)
    if (!token)
      return
    const me = await checkMe(token)
    if (!me.ok && me.reason === 'unauthorized') {
      log('[HUB] periodic re-check detected revoke')
      await context.secrets.delete(SECRETS_JWT_KEY)
      vscode.window.showErrorMessage('Cursor++ Hub: 设备授权已被吊销,BYOK Server 将停止。')
      await onRevoked()
    }
  }, INTERVAL_MS)
  return new vscode.Disposable(() => clearInterval(handle))
}

/** 显示一个一键跳登录的通知 */
export function promptLogin(): void {
  vscode.window
    .showWarningMessage(
      'Cursor++ Hub: 未登录。请先通过设备授权后才能启动 BYOK Server。',
      '立即登录',
    )
    .then((pick) => {
      if (pick === '立即登录')
        vscode.commands.executeCommand('cursor2plus.hub.login')
    })
}
