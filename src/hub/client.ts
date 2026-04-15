/**
 * Hub HTTP 客户端 —— 调用 ccursor-hub server 的 device code / me 接口
 *
 * 所有方法都带超时 + 明确的错误分类,方便上层决定 "offline 放行" 还是 "denied 拒绝"。
 */
import { HUB_URL } from './config'

const DEFAULT_TIMEOUT_MS = 5000

export interface DeviceCodeResp {
  device_code: string
  user_code: string
  verify_url: string
  expires_in: number
  interval: number
}

export interface HubUser {
  id: number
  username: string
  name: string | null
  avatar_url: string | null
}

export interface PollResp {
  status: 'pending' | 'authorized' | 'expired' | 'denied' | 'unknown' | 'slow_down'
  token?: string
  user?: HubUser
}

export type MeResult
  = | { ok: true, user: { id: number, linuxdoId: number, username: string } }
    | { ok: false, reason: 'unauthorized' | 'offline' | 'server_error' }

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  }
  finally {
    clearTimeout(timer)
  }
}

export async function requestDeviceCode(deviceLabel: string): Promise<DeviceCodeResp> {
  const res = await fetchWithTimeout(`${HUB_URL}/api/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_label: deviceLabel }),
  })
  if (!res.ok)
    throw new Error(`device_code request failed: ${res.status}`)
  return res.json() as Promise<DeviceCodeResp>
}

export async function pollDeviceToken(deviceCode: string): Promise<PollResp> {
  const res = await fetchWithTimeout(`${HUB_URL}/api/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  }, 10000)
  // 几种状态都可能返回非 200,但 body 是有意义的 JSON
  return res.json() as Promise<PollResp>
}

/**
 * 周期 re-check: 拿 JWT 问 /api/me
 *
 * 返回语义:
 *   ok: true  → 用户仍然有效
 *   ok: false, reason: 'unauthorized' → JWT 被吊销或失效,本地应清 token + 禁用 server
 *   ok: false, reason: 'offline'      → 网络不通,本地应放行 (离线可用)
 *   ok: false, reason: 'server_error' → 服务器 5xx,本地放行
 */
export async function checkMe(token: string): Promise<MeResult> {
  try {
    const res = await fetchWithTimeout(`${HUB_URL}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    }, 5000)
    if (res.status === 401 || res.status === 403)
      return { ok: false, reason: 'unauthorized' }
    if (!res.ok)
      return { ok: false, reason: 'server_error' }
    const data = await res.json() as { user: { id: number, linuxdoId: number, username: string } }
    return { ok: true, user: data.user }
  }
  catch {
    // fetch 抛出 (网络错误/超时/DNS 失败) 全部视为 offline
    return { ok: false, reason: 'offline' }
  }
}

export async function revokeSelf(token: string): Promise<void> {
  await fetchWithTimeout(`${HUB_URL}/api/device/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }, 5000).catch(() => { /* 吊销失败不阻塞本地 logout */ })
}
