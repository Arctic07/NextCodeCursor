/**
 * ccursor install — 完整安装流程
 *
 * 顺序：
 *   0. 定位 Cursor 安装目录 + 预检
 *   1. 释放默认配置到 ~/.ccursor/
 *   2. 安装扩展到 extensions/cursor2plus/
 *   3. 注入 renderer hook (workbench.js)
 *   4. 注入 always-local 拦截 + 签名绕过 + 优先加载 (extensionHostProcess.js)
 *   5. KaTeX CSS link 修补 (workbench.html)
 *   6. 启用 Local Agent 配置能力 (buildFlags.localMode)
 *   7. 提示重启
 */
import { existsSync, readFileSync } from 'fs';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { installExtension, isExtensionInstalled } from './extension-embed.js';
import { hasBackup } from './backup.js';
import { patchInject } from './patch-inject.js';
import { patchAlwaysLocal } from './patch-always-local.js';
import { patchKatex } from './patch-katex.js';
import { patchLocalMode } from './patch-local-mode.js';
// delete-fix 已移除 — 3.2.11 原生 tombstoneDeletedComposer 已覆盖
import { releaseDefaults } from './release-defaults.js';

const ok = msg => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
const warn = msg => console.log(`\x1b[33m[!]\x1b[0m ${msg}`);
const fail = msg => console.log(`\x1b[31m[X]\x1b[0m ${msg}`);

export async function install() {
  info('Cursor++ BYOK Installer');
  console.log('');

  // 0. 定位 + 预检
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    fail('Cursor installation not found');
    console.log('');
    console.log(formatDiagnostic(diagnostic));
    console.log('');
    throw new Error('Cursor installation not found');
  }
  info(`Cursor: ${paths.appRoot}`);
  info(`Version: ${paths.cursorVersion}${paths.hasGlass ? ' (glass)' : ''}`);

  const extInstalled = isExtensionInstalled(paths);
  const desktopPatched = existsSync(paths.workbenchJs) && readFileSync(paths.workbenchJs, 'utf-8').includes('__byokWrapTransport');
  const glassPatched = !existsSync(paths.glassJs) || readFileSync(paths.glassJs, 'utf-8').includes('__byokWrapTransport');
  const hookInjected = desktopPatched && glassPatched;
  const alPatched = existsSync(paths.alwaysLocalMain) && readFileSync(paths.alwaysLocalMain, 'utf-8').includes('__byokUrlRewrite');
  const hasBackups = hasBackup(paths.workbenchJs) || hasBackup(paths.glassJs) || hasBackup(paths.alwaysLocalMain) || hasBackup(paths.extensionHostJs);

  if (extInstalled && hookInjected && alPatched) {
    ok('Already fully installed');
    info('To reinstall, run "ccursor uninstall" first');
    return;
  }

  if (hasBackups && !extInstalled) {
    warn('Found backup files from a previous installation');
    warn('Run "ccursor uninstall" to clean up before reinstalling');
    return;
  }

  console.log('');

  // 1. 释放默认配置到 ~/.ccursor/ (尊重已有用户文件)
  releaseDefaults(info);

  // 2. 安装扩展
  installExtension(paths, info);

  // 3. Inject renderer hook
  patchInject(paths, info);

  // 4. Always-local + sig bypass
  patchAlwaysLocal(paths, info);

  // 5. KaTeX CSS link (workbench.html + checksum)
  patchKatex(paths, info);

  // 6. Local Agent 配置能力 (buildFlags.localMode → true)
  info('[local-mode] Enabling local agent configuration...');
  patchLocalMode(paths, info);

  console.log('');
  ok('Installation complete!');
  warn('Restart Cursor for changes to take effect.');
  info('Uninstall: npx @cometix/ccursor uninstall');
}
