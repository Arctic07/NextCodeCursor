#!/usr/bin/env node
/**
 * 构建 vsix 并复制到 installer/vsix/
 *
 * 从 Cursor++ 项目目录构建：
 *   1. 清掉新旧残留 vsix (Cursor++/ 和 installer/vsix/)
 *   2. pnpm run package (check-types + lint + esbuild)
 *   3. pnpm exec vsce package
 *   4. 复制 .vsix 到 installer/vsix/
 */
import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const installerRoot = join(__dirname, '..');
const extensionRoot = join(installerRoot, '..', 'Cursor++');
const vsixDir = join(installerRoot, 'vsix');

// 清掉旧 vsix, 避免残留文件干扰
function clearVsix(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.vsix'))) {
    unlinkSync(join(dir, f));
  }
}
clearVsix(extensionRoot);
clearVsix(vsixDir);

console.log('[build] Building Cursor++ extension...');
const obf = process.argv.includes('--obf');
execSync(obf ? 'pnpm run vsix:obf' : 'pnpm run vsix', { cwd: extensionRoot, stdio: 'inherit' });

// 找到生成的 vsix (此时 Cursor++/ 只可能剩下刚打的那一份)
const vsixFiles = readdirSync(extensionRoot).filter(f => f.endsWith('.vsix'));
if (vsixFiles.length === 0) throw new Error('No .vsix file generated');

mkdirSync(vsixDir, { recursive: true });

const src = join(extensionRoot, vsixFiles[0]);
const dest = join(vsixDir, vsixFiles[0]);
copyFileSync(src, dest);

console.log(`[build] Copied: ${vsixFiles[0]} → vsix/`);
console.log('[build] Done');
