/**
 * Install 时释放默认资源到 ~/.ccursor/
 *
 * 释放内容:
 *   - routes.json         ← DEFAULT_ROUTES (强制覆盖:白名单由开发者编排,非用户数据)
 *   - providers.json      ← DEFAULT_PROVIDERS (keep-if-exists:用户 API Key 不能丢)
 *   - models-catalog.json ← 从 installer 自带的 assets 复制 (models.dev 快照,强制覆盖)
 *
 * routes.json 强制覆盖的理由:
 *   redirect 数组由我们主动编排,用户不应手改;每次 install 都会拿到最新白名单,
 *   保证新版扩展增删的方法/REST 路径能立即生效。用户的 byokMode / host / port 偏好
 *   由运行时切换 (toggleByokMode / 设置面板) 维护,install 是显式动作,重置回默认可接受。
 *
 * byokMode 自动检测:
 *   读取 Cursor 的 state.vscdb, 如果 cursorAuth/accessToken 不存在或 onboarding
 *   未完成 → byokMode: 0 (OFF), 允许用户先完成登录/引导再手动开启 BYOK。
 *   已登录且引导完成 → byokMode: 1 (ON), 直接进入 BYOK 模式。
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import {
  MODELS_CATALOG_FILE_NAME,
  PROVIDERS_FILE_NAME,
  ROUTES_FILE_NAME,
  DEFAULT_PROVIDERS,
  DEFAULT_ROUTES,
  BASE_REDIRECT,
  DEFAULT_REDIRECT,
} from './defaults.js';
import { CCURSOR_DIR } from './routes.js';

function getCursorStateDbPath() {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'linux':
      return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      return join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

function detectByokMode(log) {
  const vscdb = getCursorStateDbPath();
  if (!existsSync(vscdb)) {
    log?.('  [detect] state.vscdb not found → byokMode: 0 (fresh Cursor)');
    return 0;
  }
  try {
    const query = "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1";
    const token = execFileSync('sqlite3', [vscdb, query], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!token || token.length < 10) {
      log?.('  [detect] no accessToken → byokMode: 0 (not logged in)');
      return 0;
    }
    const query2 = "SELECT value FROM ItemTable WHERE key='workbench.contrib.onboarding.browser.gettingStarted.contribution.ts.firsttime' LIMIT 1";
    const firsttime = execFileSync('sqlite3', [vscdb, query2], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (firsttime === '' || firsttime === 'true') {
      log?.('  [detect] onboarding not completed → byokMode: 0');
      return 0;
    }
    log?.('  [detect] logged in + onboarding done → byokMode: 1');
    return 1;
  } catch (e) {
    log?.(`  [detect] sqlite3 failed: ${e.message} → byokMode: 1 (fallback)`);
    return 1;
  }
}

function release(filename, content, log, { force = false } = {}) {
  const dest = join(CCURSOR_DIR, filename);
  if (!force && existsSync(dest)) {
    log?.(`  ${filename} already exists, keep`);
    return false;
  }
  const existed = existsSync(dest);
  writeFileSync(dest, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  log?.(`  ${filename} ${existed ? 'overwritten' : 'released'}`);
  return true;
}

// 打包后 __dirname 指向 cli.cjs 所在目录 (installer/dist/),
// 与之同级存放 models-catalog.json (esbuild.js 构建时复制)。
// 开发模式从 src/ 直接跑时 fallback 到 src/../assets/
function resolveAssetPath(filename) {
  const candidates = [
    join(__dirname, filename),                  // bundled: dist/<file>
    join(__dirname, '..', 'assets', filename),  // dev: src/../assets/<file>
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function copyAsset(filename, log, { force = false } = {}) {
  const dest = join(CCURSOR_DIR, filename);
  if (!force && existsSync(dest)) {
    log?.(`  ${filename} already exists, keep`);
    return false;
  }
  const src = resolveAssetPath(filename);
  if (!src) {
    log?.(`  ${filename} asset not bundled, skip`);
    return false;
  }
  const existed = existsSync(dest);
  copyFileSync(src, dest);
  const size = (readFileSync(dest).length / 1024).toFixed(1);
  log?.(`  ${filename} ${existed ? 'updated' : 'released'} (${size} KB)`);
  return true;
}

export function releaseDefaults(log) {
  log?.('[defaults] Releasing to ~/.ccursor/...');
  mkdirSync(CCURSOR_DIR, { recursive: true });

  const mode = detectByokMode(log);
  const routes = {
    ...DEFAULT_ROUTES,
    byokMode: mode,
    redirect: mode ? [...DEFAULT_REDIRECT] : [...BASE_REDIRECT],
  };
  release(ROUTES_FILE_NAME, routes, log, { force: true });
  release(PROVIDERS_FILE_NAME, DEFAULT_PROVIDERS, log);
  copyAsset(MODELS_CATALOG_FILE_NAME, log, { force: true });

  log?.('[defaults] Done');
}
