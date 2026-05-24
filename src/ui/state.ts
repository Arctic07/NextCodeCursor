/**
 * 共享应用状态 — 单一数据源
 *
 * 所有 UI（状态栏、侧边栏面板）从此处读取状态。
 * 状态变化时通过 EventEmitter 通知所有消费方。
 */
import type { ByokMode, ProviderEntry } from '../server/data/defaults'
import * as net from 'node:net'
import * as vscode from 'vscode'
import { version as EXTENSION_VERSION } from '../../package.json'
import { isServerRunning } from '../server'
import { getServerConfig } from '../server/config'
import { loadProviders } from '../server/config/providersStore'
import { getByokMode } from '../server/config/routesStore'

import { getWebTools } from '../server/config/searchConfigStore'

export type ServerState = 'local' | 'remote' | 'offline'

export interface AppState {
  server: ServerState
  host: string
  port: number
  byokMode: ByokMode
  providers: ProviderEntry[]
  webTools: import('../server/data/defaults').WebToolsConfig
  version: string
  fileLogEnabled: boolean
  logFilePath: string
}

const emitter = new vscode.EventEmitter<AppState>()
export const onStateChange = emitter.event

let current: AppState = {
  server: 'offline',
  host: '127.0.0.1',
  port: 9960,
  byokMode: 1,
  version: EXTENSION_VERSION,
  providers: [],
  webTools: { $schemaVersion: 1, search: { providers: [], parallel: false, maxResults: 5 }, fetch: { provider: 'builtin' } },
  fileLogEnabled: false,
  logFilePath: '',
}

/** 文件日志状态由 extension.ts 注入 (globalState + 实际写入 stream) */
export function setFileLogState(enabled: boolean, path: string): void {
  current = { ...current, fileLogEnabled: enabled, logFilePath: path }
  emitter.fire(current)
}

export function getState(): AppState {
  return current
}

export function isPortReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, host)
  })
}

export async function refreshState(_secrets?: vscode.SecretStorage): Promise<AppState> {
  const cfg = getServerConfig()

  let server: ServerState = 'offline'
  if (isServerRunning())
    server = 'local'
  else if (await isPortReachable(cfg.host, cfg.port))
    server = 'remote'

  const byokMode = getByokMode()
  const providers = loadProviders().providers

  current = {
    server,
    host: cfg.host,
    port: cfg.port,
    byokMode,
    providers,
    webTools: getWebTools(),
    version: EXTENSION_VERSION,
    fileLogEnabled: current.fileLogEnabled,
    logFilePath: current.logFilePath,
  }
  emitter.fire(current)
  return current
}
