/**
 * ccursor status — check install state
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { isExtensionInstalled } from './extension-embed.js';
import { hasBackup } from './backup.js';
import { CCURSOR_DIR } from './routes.js';
import { PROVIDERS_FILE_NAME, ROUTES_FILE_NAME } from './defaults.js';
import { needsProxy39Patch, isProxy39Patched, getProxy39Target } from './patch-proxy-39.js';

const ok = s => `\x1b[32m✓ ${s}\x1b[0m`;
const fail = s => `\x1b[31m✗ ${s}\x1b[0m`;
const na = s => `\x1b[2m- ${s}\x1b[0m`;

export async function status() {
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    console.log(fail('Cursor installation not found'));
    console.log('');
    console.log(formatDiagnostic(diagnostic));
    return;
  }

  console.log(`Cursor: ${paths.appRoot}\n`);

  // Extension
  const extInstalled = isExtensionInstalled(paths);
  console.log(extInstalled ? ok('Extension installed') : fail('Extension not installed'));

  // Inject (desktop)
  if (existsSync(paths.workbenchJs)) {
    const wb = readFileSync(paths.workbenchJs, 'utf-8');
    const injected = wb.includes('__byokWrapTransport');
    console.log(injected ? ok('Renderer hook injected (desktop)') : fail('Renderer hook not injected (desktop)'));
  } else {
    console.log(na('workbench.desktop.main.js not found'));
  }

  // Inject (glass / Agent Window)
  if (existsSync(paths.glassJs)) {
    const gl = readFileSync(paths.glassJs, 'utf-8');
    const injected = gl.includes('__byokWrapTransport');
    console.log(injected ? ok('Renderer hook injected (glass)') : fail('Renderer hook not injected (glass)'));
  } else {
    console.log(na('workbench.glass.main.js not found (pre-3.8)'));
  }

  // Always-local
  if (existsSync(paths.alwaysLocalMain)) {
    const al = readFileSync(paths.alwaysLocalMain, 'utf-8');
    const patched = al.includes('__byokUrlRewrite');
    console.log(patched ? ok('Always-local patched') : fail('Always-local not patched'));
  } else {
    console.log(na('cursor-always-local not found'));
  }

  // Sig bypass
  if (existsSync(paths.extensionHostJs)) {
    const eh = readFileSync(paths.extensionHostJs, 'utf-8');
    const bypassed = eh.includes('if(!1)') && !/if\(!\w\.valid\)/.test(eh);
    console.log(bypassed ? ok('Signature bypass active') : fail('Signature bypass not active'));
  } else {
    console.log(na('extensionHostProcess.js not found'));
  }

  // Wait-for-server injection in activate
  if (existsSync(paths.alwaysLocalMain)) {
    const al = readFileSync(paths.alwaysLocalMain, 'utf-8');
    const hasWait = al.includes('__byokWaitServer');
    console.log(hasWait ? ok('Server wait injection active') : fail('Server wait injection not active'));
  }

  // Cursor 3.9+ always-local singleton BYOK router/proxy sync
  if (needsProxy39Patch(paths)) {
    console.log(isProxy39Patched(paths) ? ok('Cursor 3.9 singleton BYOK router/proxy patch active') : fail('Cursor 3.9 singleton BYOK router/proxy patch missing'));
  } else if (existsSync(getProxy39Target(paths))) {
    console.log(na('Cursor 3.9 singleton BYOK router/proxy patch not required'));
  }

  // ~/.ccursor 资源
  console.log('');
  const routesPath = join(CCURSOR_DIR, ROUTES_FILE_NAME);
  const providersPath = join(CCURSOR_DIR, PROVIDERS_FILE_NAME);
  console.log(existsSync(routesPath) ? ok(`routes.json: ${routesPath}`) : fail(`routes.json missing at ${routesPath}`));
  console.log(existsSync(providersPath) ? ok(`providers.json: ${providersPath}`) : fail(`providers.json missing at ${providersPath}`));

  // Backups
  console.log('');
  const backupFiles = [paths.workbenchJs, paths.glassJs, paths.alwaysLocalMain, paths.alwaysLocalSingletonJs, paths.extensionHostJs, paths.productJson];
  const backupCount = backupFiles.filter(f => hasBackup(f)).length;
  console.log(`Backups: ${backupCount}/${backupFiles.length} files backed up`);
}
