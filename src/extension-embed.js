/**
 * 将 vsix 解压安装到 Cursor.app/extensions/cursor2plus/
 *
 * 使用 fflate (纯 JS, WASM 级性能) 解压，比 adm-zip 快 10x+。
 */
import { unzipSync } from 'fflate';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
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

  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(targetDir, { recursive: true });

  const zipData = new Uint8Array(readFileSync(vsixPath));
  const files = unzipSync(zipData);
  const prefix = 'extension/';
  let count = 0;

  for (const [name, data] of Object.entries(files)) {
    if (!name.startsWith(prefix) || name.endsWith('/'))
      continue;
    const relPath = name.slice(prefix.length);
    const destPath = join(targetDir, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, data);
    count++;
  }

  log?.(`  Installed: ${targetDir} (${count} files)`);
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
