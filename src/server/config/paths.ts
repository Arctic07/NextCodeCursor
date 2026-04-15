/**
 * ~/.ccursor 目录下各资源文件的绝对路径
 *
 * 单一来源：所有 store / db / installer 都从这里取路径,避免散落硬编码。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CCURSOR_DIR_NAME, DB_FILE_NAME, MODELS_CATALOG_FILE_NAME, PROVIDERS_FILE_NAME, ROUTES_FILE_NAME } from '../data/defaults'

export function getCcursorDir(): string {
  return join(homedir(), CCURSOR_DIR_NAME)
}

export function getRoutesFilePath(): string {
  return join(getCcursorDir(), ROUTES_FILE_NAME)
}

export function getProvidersFilePath(): string {
  return join(getCcursorDir(), PROVIDERS_FILE_NAME)
}

export function getDatabaseFilePath(): string {
  return join(getCcursorDir(), DB_FILE_NAME)
}

/**
 * models.dev 快照路径 (installer 释放).
 * UI 端加载这个文件给"添加模型"面板做自动补全 + 默认值填充。
 */
export function getModelsCatalogFilePath(): string {
  return join(getCcursorDir(), MODELS_CATALOG_FILE_NAME)
}

/** 日志目录 ~/.ccursor/logs */
export function getLogsDir(): string {
  return join(getCcursorDir(), 'logs')
}

/**
 * 每窗口一个独立日志文件, 避免多实例并发写冲突。
 *   windowId 来自 VSCODE_PROCESS_TITLE 中的 [N-M],
 *   workspace 来自 vscode.workspace.name (无 workspace 时用 'no-workspace').
 *
 * 文件名例: "4-CometixCode.log" / "1-no-workspace.log"
 */
export function getSessionLogFilePath(windowId: number, workspaceName: string): string {
  const safeName = (workspaceName || 'no-workspace').replace(/[^\w.-]+/g, '_')
  return join(getLogsDir(), `${windowId}-${safeName}.log`)
}
