/**
 * Local Mode Patcher — 独立补丁
 *
 * 翻转 Cursor 内置的 buildFlags.localMode 编译标志:
 *   localMode:!1 → localMode:!0
 *
 * 影响所有进程的构建产物:
 *   - main.js (主进程: Sentry/更新 URL)
 *   - workbench.desktop.main.js (Editor Window: Agent 运行/模型/遥测/UI)
 *   - workbench.glass.main.js (Agent Window: 同上)
 *   - extensionHostProcess.js (EHP: agentExecProvider.runLocalAgent)
 *   - alwaysLocalSingletonMain.js (utility process: 编译标志引用)
 *
 * 启用后 Cursor 进入 Local Agent 模式:
 *   - Agent 运行走 extension host 内的 agentExecProvider，直接调 LLM API
 *   - 模型列表从 storage.localProviderModelIds 读取
 *   - Settings UI 显示 Local Agent Configuration Modal
 *   - 通过 CURSOR_LOCAL_AGENT_BASE_URL / CURSOR_LOCAL_AGENT_API_KEY 环境变量配置
 *   - 或通过 Settings UI 的 Base URL + API Key 输入框配置
 *
 * 此补丁独立于 inject/always-local/katex 补丁管线:
 *   - 使用独立的 backup tag 'local-mode'
 *   - 可单独 install/uninstall
 *   - 不影响 BYOK Server 的 ConnectRPC 代理方案
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';

const TAG = 'local-mode';
const PATTERN = 'localMode:!1';
const REPLACEMENT = 'localMode:!0';

const TARGET_FILES = [
  'out/main.js',
  'out/vs/workbench/workbench.desktop.main.js',
  'out/vs/workbench/workbench.glass.main.js',
  'out/vs/workbench/api/node/extensionHostProcess.js',
  'out/vs/code/electron-utility/alwaysLocalSingleton/alwaysLocalSingletonMain.js',
];

export function patchLocalMode(paths, log) {
  log?.('[local-mode] Patching buildFlags.localMode...');

  let patched = 0;
  const modifiedFiles = [];

  for (const rel of TARGET_FILES) {
    const filePath = join(paths.appRoot, rel);
    if (!existsSync(filePath)) {
      log?.(`  [local-mode] ${rel}: not found, skipping`);
      continue;
    }

    const code = readFileSync(filePath, 'utf-8');
    if (code.includes(REPLACEMENT)) {
      log?.(`  [local-mode] ${rel}: already patched`);
      patched++;
      continue;
    }
    if (!code.includes(PATTERN)) {
      log?.(`  [local-mode] ${rel}: pattern not found, skipping`);
      continue;
    }

    createBackup(filePath, TAG, log);
    writeFileSync(filePath, code.replace(PATTERN, REPLACEMENT));
    modifiedFiles.push(filePath);
    patched++;
    log?.(`  [local-mode] ${rel}: patched`);
  }

  if (modifiedFiles.length > 0) {
    updateChecksums(paths, modifiedFiles, TAG, log);
  }

  log?.(`[local-mode] Done (${patched}/${TARGET_FILES.length} files)`);
  return patched;
}

export function isLocalModePatched(paths) {
  const mainJs = join(paths.appRoot, TARGET_FILES[0]);
  if (!existsSync(mainJs)) return false;
  return readFileSync(mainJs, 'utf-8').includes(REPLACEMENT);
}
