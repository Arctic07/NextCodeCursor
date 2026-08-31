/**
 * 版本更新检查
 *
 * 从 npm registry 查询最新版本（包名由 relay.config.json 驱动），
 * 与当前 extension 版本比较，有更新时弹通知。
 */
import * as vscode from 'vscode'
import { version as CURRENT_VERSION } from '../package.json'
import { NPM_PACKAGE, UPDATE_COMMAND } from './server/relay/branding'

const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours
const STATE_KEY_LAST_CHECK = 'ccursor.updateCheck.lastCheckMs'
const STATE_KEY_DISMISSED = 'ccursor.updateCheck.dismissedVersion'

let timer: ReturnType<typeof setInterval> | null = null

function getCurrentVersion(): string {
  return CURRENT_VERSION
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb)
      return va - vb
  }
  return 0
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    clearTimeout(timeout)
    if (!res.ok)
      return null
    const data = await res.json() as { version?: string }
    return data.version ?? null
  }
  catch {
    return null
  }
}

async function checkOnce(state: vscode.Memento, log?: (msg: string) => void) {
  const current = getCurrentVersion()
  const latest = await fetchLatestVersion()
  if (!latest)
    return

  state.update(STATE_KEY_LAST_CHECK, Date.now())

  if (compareVersions(latest, current) <= 0) {
    log?.(`[UPDATE] up to date (current=${current}, latest=${latest})`)
    return
  }

  const dismissed = state.get<string>(STATE_KEY_DISMISSED)
  if (dismissed === latest)
    return

  log?.(`[UPDATE] new version available: ${latest} (current=${current})`)

  const action = await vscode.window.showInformationMessage(
    `Cursor++ ${latest} is available (current: ${current}). Run in an external terminal:\n${UPDATE_COMMAND}`,
    'Copy Command',
    'Dismiss',
  )

  if (action === 'Copy Command') {
    await vscode.env.clipboard.writeText(UPDATE_COMMAND)
    void vscode.window.showInformationMessage(
      `Copied to clipboard: ${UPDATE_COMMAND}\nClose Cursor first if the installer needs write access to the app bundle.`,
    )
  }
  else if (action === 'Dismiss') {
    state.update(STATE_KEY_DISMISSED, latest)
  }
}

export function startUpdateCheck(
  state: vscode.Memento,
  log?: (msg: string) => void,
) {
  const lastCheck = state.get<number>(STATE_KEY_LAST_CHECK) ?? 0
  const elapsed = Date.now() - lastCheck

  // 首次或距上次检查超过间隔 → 立即检查
  if (elapsed >= CHECK_INTERVAL_MS) {
    setTimeout(checkOnce, 5000, state, log) // 延迟 5s 避免拖慢 activate
  }

  timer = setInterval(checkOnce, CHECK_INTERVAL_MS, state, log)
}

export function stopUpdateCheck() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
