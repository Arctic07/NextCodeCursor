/**
 * 将 vsix 解压安装到 Cursor.app/extensions/cursor2plus/
 *
 * 解压通过 adm-zip 完成 (纯 JS, 跨平台), 不再依赖系统 unzip 命令 ——
 * Windows 默认环境没有 unzip, 这是之前 0.0.1/0.0.2 在 Windows 上失败的原因。
 */
import AdmZip from 'adm-zip';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
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

  // vsix 是 zip 格式 — 用 adm-zip 解压到临时目录
  const tmpDir = join(dirname(targetDir), '.cursor2plus-install-tmp');
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    const zip = new AdmZip(vsixPath);
    zip.extractAllTo(tmpDir, /* overwrite */ true);

    // vsix 内部结构: extension/{package.json, dist/, ...}
    const extractedExtDir = join(tmpDir, 'extension');
    if (!existsSync(extractedExtDir)) {
      throw new Error('Invalid vsix structure: extension/ directory not found');
    }

    // 移动到目标位置
    mkdirSync(dirname(targetDir), { recursive: true });
    copyDirSync(extractedExtDir, targetDir);

    log?.(`  Installed: ${targetDir}`);
    log?.(`  From: ${vsixFiles[0]}`);

  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
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
