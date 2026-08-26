/**
 * 备份与恢复 — 按 tag 作用域独立
 *
 * 每个 patch 步骤使用自己的 tag(例如 'inject' / 'always-local'),
 * 同一文件可同时存在多份不同 tag 的备份,互不干扰。
 *
 * 命名: <filePath>.backup-byok-<tag>-<iso-ts>
 *
 * 倒序恢复示例(以 product.json 为例):
 *   install 顺序: inject → always-local
 *   各自备份:
 *     product.json.backup-byok-inject-<ts1>        (原始干净版)
 *     product.json.backup-byok-always-local-<ts2>  (仅经过 inject 的版本)
 *   uninstall 倒序:
 *     1. restore tag=always-local → product.json 回到"仅 inject"状态
 *     2. restore tag=inject       → product.json 回到完全原始状态
 */
import { copyFileSync, existsSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';

const PREFIX = 'backup-byok';

function backupNamePattern(base, tag) {
  // 匹配 <base>.backup-byok-<tag>-<ts>
  return `${base}.${PREFIX}-${tag}-`;
}

function listBackups(dir, base, tag) {
  if (!existsSync(dir)) return [];
  const prefix = backupNamePattern(base, tag);
  return readdirSync(dir).filter(f => f.startsWith(prefix)).sort();
}

export function createBackup(filePath, tag, log) {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const existing = listBackups(dir, base, tag);
  if (existing.length > 0) {
    log?.(`  Backup exists: ${existing[0]}`);
    return join(dir, existing[0]);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = `${filePath}.${PREFIX}-${tag}-${ts}`;
  copyFileSync(filePath, backupPath);
  log?.(`  Backup [${tag}]: ${basename(backupPath)}`);
  return backupPath;
}

export function restoreBackup(filePath, tag, log) {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const backups = listBackups(dir, base, tag);

  if (backups.length === 0) {
    log?.(`  No [${tag}] backup for ${base}`);
    return false;
  }

  // 同 tag 下多份时取最早的一份(最接近原始),其他冗余份删除
  const primary = backups[0];
  renameSync(join(dir, primary), filePath);
  for (let i = 1; i < backups.length; i++) {
    try {
      unlinkSync(join(dir, backups[i]));
    }
    catch {}
  }
  log?.(`  Restored [${tag}]: ${base}`);
  return true;
}

export function hasBackup(filePath, tag) {
  const dir = dirname(filePath);
  const base = basename(filePath);
  if (!existsSync(dir)) return false;
  if (tag) {
    return listBackups(dir, base, tag).length > 0;
  }
  // 不指定 tag 时,检测是否存在任何 byok 备份
  return readdirSync(dir).some(f => f.startsWith(`${base}.${PREFIX}-`));
}
