/**
 * routes.json 加载 + 路径解析
 *
 * 默认值定义在 ./defaults.js (与 extension server 共享)。
 * 本模块仅做读取与释放,server 端有完整的单项原子写入实现。
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CCURSOR_DIR_NAME, ROUTES_FILE_NAME, DEFAULT_ROUTES } from './defaults.js';

export const CCURSOR_DIR = join(homedir(), CCURSOR_DIR_NAME);
export const ROUTES_PATH = join(CCURSOR_DIR, ROUTES_FILE_NAME);

/**
 * 加载 routes.json — 不存在或损坏时返回内置默认值。
 * 不在此处自动写入文件;首次释放由 install 流程统一处理。
 */
export function loadRoutes() {
  if (!existsSync(ROUTES_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(readFileSync(ROUTES_PATH, 'utf-8'));
    return mergeWithDefaults(parsed);
  } catch {
    return cloneDefaults();
  }
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_ROUTES));
}

function mergeWithDefaults(loaded) {
  const fallback = cloneDefaults();
  if (!loaded || typeof loaded !== 'object') return fallback;
  return {
    $schemaVersion: loaded.$schemaVersion ?? fallback.$schemaVersion,
    server: {
      host: loaded.server?.host ?? fallback.server.host,
      port: loaded.server?.port ?? fallback.server.port,
    },
    collector: {
      host: loaded.collector?.host ?? fallback.collector.host,
      port: loaded.collector?.port ?? fallback.collector.port,
    },
    redirect: Array.isArray(loaded.redirect) && loaded.redirect.length > 0
      ? loaded.redirect.slice()
      : fallback.redirect,
  };
}
