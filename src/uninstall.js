/**
 * ccursor uninstall — full rollback
 *
 * Reverse order (opposite of install):
 *   1. Restore local-mode group (product.json → all patched files)
 *   2. Restore katex group (product.json → workbench.html)
 *   3. Restore always-local group (product.json → extensionHostProcess.js → always-local.js)
 *   4. Restore inject group (product.json → workbench.js)
 *   5. Remove extensions/cursor2plus/
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

  // 1. 倒序恢复 local-mode 组 (install 步骤 6 的逆操作)
  const mainJs = join(paths.appRoot, 'out', 'main.js');
  const singletonJs = join(paths.appRoot, 'out', 'vs', 'code', 'electron-utility', 'alwaysLocalSingleton', 'alwaysLocalSingletonMain.js');
  info('Restoring local-mode patches...');
  for (const file of [paths.productJson, singletonJs, paths.extensionHostJs, paths.glassJs, paths.workbenchJs, mainJs]) {
    if (restoreBackup(file, 'local-mode', info)) restored++;
  }

  // 2. 倒序恢复 katex 组 (install 步骤 5 的逆操作)
  info('Restoring katex patches...');
  for (const file of [paths.productJson, workbenchHtml]) {
    if (restoreBackup(file, 'katex', info)) restored++;
  }

  // 2. 倒序恢复 always-local 组
  info('Restoring always-local patches...');
  for (const file of [paths.productJson, paths.extensionHostJs, paths.alwaysLocalMain]) {
    if (restoreBackup(file, 'always-local', info)) restored++;
  }

  // 3. 倒序恢复 inject 组 (glass → desktop → product.json, checksum 正确还原)
  info('Restoring inject patches...');
  for (const file of [paths.productJson, paths.glassJs, paths.workbenchJs]) {
    if (restoreBackup(file, 'inject', info)) restored++;
  }

  // 4. 删除扩展
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
