/**
 * 将 vsix 解压安装到 Cursor.app/extensions/cursor2plus/
 *
 * 解压通过 adm-zip 完成 (纯 JS, 跨平台), 不再依赖系统 unzip 命令 ——
 * Windows 默认环境没有 unzip, 这是之前 0.0.1/0.0.2 在 Windows 上失败的原因。
 */
import AdmZip from 'adm-zip';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
// CJS bundle 中 __dirname 指向 dist/，vsix/ 在同级
const __pkgRoot = join(__dirname, '..');

export function installExtension(paths, log) {
  log?.('[extension] Installing to Cursor.app/extensions/cursor2plus/...');

  const vsixDir = join(__pkgRoot, 'vsix');
  const vsixFiles = existsSync(vsixDir) ? readdirSync(vsixDir).filter(f => f.endsWith('.vsix')) : [];

  if (vsixFiles.length === 0) {
    throw new Error('No .vsix file found in vsix/ directory. Run "npm run build" first.');
  }

  const vsixPath = join(vsixDir, vsixFiles[0]);
  const targetDir = paths.cursor2plusDir;

  // 清理旧安装
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
    log?.('  Removed previous installation');
  }

  // vsix 是 zip — 直接解压 extension/ 内容到目标目录（跳过临时目录，减少 IO）
  mkdirSync(targetDir, { recursive: true });

  const zip = new AdmZip(vsixPath);
  const entries = zip.getEntries();
  const extEntries = entries.filter(e => !e.isDirectory && e.entryName.startsWith('extension/'));
  const total = extEntries.length;
  let extracted = 0;

  for (const entry of extEntries) {
    const relPath = entry.entryName.slice('extension/'.length);
    const destPath = join(targetDir, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, entry.getData());
    extracted++;
    const pct = Math.round((extracted / total) * 100);
    process.stdout.write(`\r  Extracting: ${extracted}/${total} (${pct}%) ${relPath}${' '.repeat(20)}`);
  }
  process.stdout.write('\r' + ' '.repeat(80) + '\r');

  log?.(`  Installed: ${targetDir} (${total} files)`);
  log?.(`  From: ${vsixFiles[0]}`);
}

export function removeExtension(paths, log) {
  if (existsSync(paths.cursor2plusDir)) {
    rmSync(paths.cursor2plusDir, { recursive: true, force: true });
    log?.('[extension] Removed cursor2plus from extensions/');
  } else {
    log?.('[extension] Not installed');
  }
}

export function isExtensionInstalled(paths) {
  return existsSync(join(paths.cursor2plusDir, 'package.json'));
}

// 递归复制目录
function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
