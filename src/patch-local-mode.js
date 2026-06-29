/**
 * Local Mode Patch — 启用 Cursor 官方 Local Agent 配置能力
 *
 * Cursor 内置了 localMode 构建标志 (buildFlags.localMode)，控制:
 *   - Local Agent Configuration Modal (API key + base URL 配置界面)
 *   - Agent 运行路径切换 (runLocalAgentInExtensionHost 替代 ConnectRPC)
 *   - 环境变量读取 (CURSOR_LOCAL_AGENT_BASE_URL / CURSOR_LOCAL_AGENT_API_KEY)
 *   - 遥测禁用、Canvas 分享禁用等
 *
 * 当前所有发布版硬编码 localMode: false。此 patch 翻转为 true。
 *
 * 目标文件 (所有包含 buildFlags 定义的 bundle):
 *   - main.js (主进程)
 *   - workbench.desktop.main.js (Editor Window renderer)
 *   - workbench.glass.main.js (Agent Window renderer, 3.8+)
 *   - extensionHostProcess.js (extension host)
 *   - alwaysLocalSingletonMain.js (utility process, 3.8+)
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';

const NEEDLE = 'cursorPredictionOptions:!1,localMode:!1';
const REPLACEMENT = 'cursorPredictionOptions:!1,localMode:!0';

export function patchLocalMode(paths, log) {
  const targets = [
    { path: paths.workbenchJs, label: 'desktop' },
    { path: paths.glassJs, label: 'glass' },
    { path: paths.extensionHostJs, label: 'extensionHost' },
    { path: join(paths.appRoot, 'out', 'main.js'), label: 'main' },
    { path: join(paths.appRoot, 'out', 'vs', 'code', 'electron-utility', 'alwaysLocalSingleton', 'alwaysLocalSingletonMain.js'), label: 'alwaysLocalSingleton' },
  ];

  const patched = [];
  const checksumFiles = [];

  for (const { path, label } of targets) {
    if (!existsSync(path)) {
      log?.(`  [local-mode] ${label}: not found, skipping`);
      continue;
    }
    const code = readFileSync(path, 'utf-8');
    if (code.includes(REPLACEMENT)) {
      log?.(`  [local-mode] ${label}: already patched`);
      continue;
    }
    if (!code.includes(NEEDLE)) {
      log?.(`  [local-mode] ${label}: needle not found, skipping`);
      continue;
    }
    createBackup(path, 'local-mode', log);
    writeFileSync(path, code.replace(NEEDLE, REPLACEMENT));
    checksumFiles.push(path);
    patched.push(label);
  }

  if (checksumFiles.length > 0) {
    updateChecksums(paths, checksumFiles, 'local-mode', log);
  }

  if (patched.length > 0) {
    log?.(`  [local-mode] patched ${patched.length} file(s): ${patched.join(', ')}`);
  } else {
    log?.('  [local-mode] no files needed patching');
  }
}
