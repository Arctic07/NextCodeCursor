/**
 * ccursor install — 完整安装流程
 *
 * 顺序：
 *   0. 定位 Cursor 安装目录 + 预检
 *   1. 安装扩展到 extensions/cursor2plus/
 *   2. 注入 renderer hook (workbench.js)
 *   3. 注入 always-local 拦截 + 签名绕过 + 优先加载 (extensionHostProcess.js)
 *   4. 注入 delete-fix (workbench.js) — 修复非 draft 会话删除不持久的 bug
 *   5. 提示重启
 */
import { readFileSync, existsSync } from 'fs';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { installExtension, isExtensionInstalled } from './extension-embed.js';
import { hasBackup } from './backup.js';
import { patchInject } from './patch-inject.js';
import { patchAlwaysLocal } from './patch-always-local.js';
import { patchDeleteFix, isDeleteFixApplied } from './patch-delete-fix.js';
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

  const extInstalled = isExtensionInstalled(paths);
  const hookInjected = existsSync(paths.workbenchJs) && readFileSync(paths.workbenchJs, 'utf-8').includes('__byokWrapTransport');
  const alPatched = existsSync(paths.alwaysLocalMain) && readFileSync(paths.alwaysLocalMain, 'utf-8').includes('__byokUrlRewrite');
  const dfPatched = isDeleteFixApplied(paths);
  const hasBackups = hasBackup(paths.workbenchJs) || hasBackup(paths.alwaysLocalMain) || hasBackup(paths.extensionHostJs);

  if (extInstalled && hookInjected && alPatched && dfPatched) {
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

  // 5. Delete-fix (workbench.js, 在 inject 之后, 同一文件追加 patch)
  patchDeleteFix(paths, info);

  console.log('');
  ok('Installation complete!');
  warn('Restart Cursor for changes to take effect.');
  info('Uninstall: npx @cometix/ccursor uninstall');
}
