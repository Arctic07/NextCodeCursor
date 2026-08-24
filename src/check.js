/**
 * ccursor check — dry-run verify all AST patch targets are matchable
 */
import { existsSync, readFileSync } from 'fs';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { checkActivateInjection } from './patch-always-local.js';
import { checkProxy39Patch, needsProxy39Patch } from './patch-proxy-39.js';

const ok = s => `\x1b[32m✓ ${s}\x1b[0m`;
const fail = s => `\x1b[31m✗ ${s}\x1b[0m`;
const info = s => `\x1b[34m[>]\x1b[0m ${s}`;

export async function check() {
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    console.log(fail('Cursor installation not found'));
    console.log();
    console.log(formatDiagnostic(diagnostic));
    return;
  }

  console.log(info(`Cursor: ${paths.appRoot}`));
  console.log();

  let allOk = true;

  // 1. Renderer hook anchor (inject patch) — desktop + glass
  for (const [file, label] of [[paths.workbenchJs, 'desktop'], [paths.glassJs, 'glass']]) {
    if (!existsSync(file)) {
      if (label === 'glass') console.log(info('Glass workbench not found (pre-3.8, OK)'));
      continue;
    }
    const wb = readFileSync(file, 'utf-8');
    // 与 patch-inject.js 的 ANCHORS 保持一致 —— 3.17.8 起模块注册键从
    // "out-build/external/bufbuild/connect/callback-client.js" 缩短为
    // "callback-client.js",只取文件名可同时命中新旧两种形态。
    const anchors = [
      'callback-client.js',
      'promise-client.js',
    ];
    const found = anchors.find(a => wb.includes(a));
    if (found) {
      console.log(ok(`Inject anchor (${label}): "${found}"`));
    } else {
      console.log(fail(`Inject anchor (${label}) not found`));
      allOk = false;
    }
  }

  // 2. Signature bypass pattern
  if (existsSync(paths.extensionHostJs)) {
    const eh = readFileSync(paths.extensionHostJs, 'utf-8');
    const hasSigPattern = /if\(!\w\.valid\)/.test(eh);
    const alreadyBypassed = eh.includes('if(!1)') && !hasSigPattern;
    if (hasSigPattern || alreadyBypassed) {
      console.log(ok(`Sig bypass: ${alreadyBypassed ? 'already applied' : 'pattern found'}`));
    } else {
      console.log(fail('Sig bypass pattern not found'));
      allOk = false;
    }
  }

  // 3. Activate injection (wait-for-server in cursor-always-local)
  const actOk = checkActivateInjection(paths, s => console.log(info(s)));
  if (!actOk) allOk = false;

  // 4. Cursor 3.9+ singleton BYOK router/proxy target
  if (needsProxy39Patch(paths)) {
    console.log(info('[check] Verifying Cursor 3.9 singleton BYOK router/proxy patch target...'));
    const proxyOk = checkProxy39Patch(paths, s => console.log(info(s)));
    if (!proxyOk) allOk = false;
  } else {
    console.log(info('Cursor 3.9 singleton BYOK router/proxy patch not required'));
  }

  // 5. cursor-always-local main.js
  if (existsSync(paths.alwaysLocalMain)) {
    console.log(ok('cursor-always-local main.js found'));
  } else {
    console.log(fail('cursor-always-local main.js not found'));
    allOk = false;
  }

  console.log();
  if (allOk) {
    console.log(ok('All patch targets matchable'));
  } else {
    console.log(fail('Some targets not matchable — install may fail'));
  }
}
