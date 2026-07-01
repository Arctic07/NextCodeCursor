/**
 * ccursor uninstall — full rollback
 *
 * Reverse order (opposite of install):
 *   1. Restore katex group (product.json → workbench.html)
 *   2. Restore proxy-39 group (product.json → alwaysLocalSingletonMain.js)
 *   3. Restore always-local group (product.json → extensionHostProcess.js → always-local.js)
 *   4. Restore inject group (product.json → workbench.js)
 *   5. Remove extensions/cursor2plus/
 *
 * local-mode 是游离于主 installer 之外的特殊工具，
 * 只通过 `ccursor local-mode` / `ccursor local-mode-off` 管理。
 */
import { join } from 'path';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { restoreBackup } from './backup.js';
import { removeExtension } from './extension-embed.js';

const ok = msg => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
const warn = msg => console.log(`\x1b[33m[!]\x1b[0m ${msg}`);
const fail = msg => console.log(`\x1b[31m[X]\x1b[0m ${msg}`);

export async function uninstall() {
  info('Cursor++ BYOK Uninstaller');
  console.log('');

  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    fail('Cursor installation not found');
    console.log('');
    console.log(formatDiagnostic(diagnostic));
    console.log('');
    throw new Error('Cursor installation not found');
  }
  info(`Cursor: ${paths.appRoot}`);

  let restored = 0;
  const workbenchHtml = join(paths.appRoot, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html');

  const singletonJs = join(paths.appRoot, 'out', 'vs', 'code', 'electron-utility', 'alwaysLocalSingleton', 'alwaysLocalSingletonMain.js');

  // 1. 倒序恢复 katex 组
  info('Restoring katex patches...');
  for (const file of [paths.productJson, workbenchHtml]) {
    if (restoreBackup(file, 'katex', info)) restored++;
  }

  // 2. 倒序恢复 Cursor 3.9 proxy sync 组
  info('Restoring proxy-39 patches...');
  for (const file of [paths.productJson, singletonJs]) {
    if (restoreBackup(file, 'proxy-39', info)) restored++;
  }

  // 3. 倒序恢复 always-local 组
  info('Restoring always-local patches...');
  for (const file of [paths.productJson, paths.extensionHostJs, paths.alwaysLocalMain]) {
    if (restoreBackup(file, 'always-local', info)) restored++;
  }

  // 4. 倒序恢复 inject 组 (glass → desktop → product.json, checksum 正确还原)
  info('Restoring inject patches...');
  for (const file of [paths.productJson, paths.glassJs, paths.workbenchJs]) {
    if (restoreBackup(file, 'inject', info)) restored++;
  }

  // 5. 删除扩展
  removeExtension(paths, info);

  console.log('');
  if (restored > 0) {
    ok(`Restored ${restored} file(s)`);
  } else {
    warn('No backups found (already clean?)');
  }
  ok('Uninstallation complete');
  warn('Restart Cursor for changes to take effect.');
}
