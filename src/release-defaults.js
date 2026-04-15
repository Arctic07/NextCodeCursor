/**
 * Install 时释放默认资源到 ~/.ccursor/
 *
 * 释放内容:
 *   - routes.json         ← DEFAULT_ROUTES
 *   - providers.json      ← DEFAULT_PROVIDERS (空骨架,用户自己加)
 *   - models-catalog.json ← 从 installer 自带的 assets 复制 (models.dev 快照)
 *
 * 仅当目标文件不存在时写入,尊重用户已有配置。
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  MODELS_CATALOG_FILE_NAME,
  PROVIDERS_FILE_NAME,
  ROUTES_FILE_NAME,
  DEFAULT_PROVIDERS,
  DEFAULT_ROUTES,
} from './defaults.js';
import { CCURSOR_DIR } from './routes.js';

function release(filename, content, log) {
  const dest = join(CCURSOR_DIR, filename);
  if (existsSync(dest)) {
    log?.(`  ${filename} already exists, keep`);
    return false;
  }
  writeFileSync(dest, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  log?.(`  ${filename} released`);
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

function copyAsset(filename, log) {
  const dest = join(CCURSOR_DIR, filename);
  if (existsSync(dest)) {
    log?.(`  ${filename} already exists, keep`);
    return false;
  }
  const src = resolveAssetPath(filename);
  if (!src) {
    log?.(`  ${filename} asset not bundled, skip`);
    return false;
  }
  copyFileSync(src, dest);
  const size = (readFileSync(dest).length / 1024).toFixed(1);
  log?.(`  ${filename} released (${size} KB)`);
  return true;
}

export function releaseDefaults(log) {
  log?.('[defaults] Releasing to ~/.ccursor/...');
  mkdirSync(CCURSOR_DIR, { recursive: true });

  release(ROUTES_FILE_NAME, DEFAULT_ROUTES, log);
  release(PROVIDERS_FILE_NAME, DEFAULT_PROVIDERS, log);
  copyAsset(MODELS_CATALOG_FILE_NAME, log);

  log?.('[defaults] Done');
}
