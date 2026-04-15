/**
 * product.json checksum 更新
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { relative, join, dirname, basename } from 'path';
import { createBackup } from './backup.js';

function computeHash(filePath) {
  return createHash('sha256')
    .update(readFileSync(filePath))
    .digest('base64')
    .replace(/=+$/, '');
}

export function updateChecksums(paths, modifiedFiles, tag, log) {
  const product = JSON.parse(readFileSync(paths.productJson, 'utf-8'));
  if (!product.checksums) {
    log?.('  No checksums in product.json');
    return 0;
  }

  let updated = 0;
  for (const file of modifiedFiles) {
    const key = relative(join(paths.appRoot, 'out'), file).replace(/\\/g, '/');
    if (product.checksums[key]) {
      product.checksums[key] = computeHash(file);
      updated++;
      log?.(`  Checksum: ${key}`);
    }
  }

  if (updated > 0) {
    // 备份 product.json (按 tag 作用域,不同 patch 步骤的备份独立存在)
    createBackup(paths.productJson, tag, log);
    writeFileSync(paths.productJson, JSON.stringify(product, null, 2) + '\n');
  }

  return updated;
}
