/**
 * 定位 Cursor 安装路径 — 跨平台支持
 *
 * macOS:
 *   /Applications/Cursor.app/Contents/Resources/app
 *   ~/Applications/Cursor.app/Contents/Resources/app
 *
 * Linux:
 *   /opt/Cursor/resources/app
 *   /usr/share/cursor/resources/app
 *   ~/.local/share/cursor/resources/app
 *
 * Windows (per-user install):
 *   %LOCALAPPDATA%\Programs\cursor\resources\app
 *   %LOCALAPPDATA%\Programs\Cursor\resources\app
 *
 * Windows (system-wide install):
 *   %ProgramFiles%\Cursor\resources\app
 *   %ProgramFiles(x86)%\Cursor\resources\app
 *
 * 环境变量覆盖:
 *   CCURSOR_CURSOR_ROOT=/path/to/cursor/app   —— 绝对路径指向 resources/app 目录
 *   优先级最高,绕过所有自动检测
 */
import { existsSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

function getCandidateRoots() {
  const home = homedir();

  switch (platform()) {
    case 'darwin':
      return [
        '/Applications/Cursor.app/Contents/Resources/app',
        join(home, 'Applications/Cursor.app/Contents/Resources/app'),
      ];

    case 'linux':
      return [
        '/opt/Cursor/resources/app',
        '/opt/cursor/resources/app',
        '/usr/share/cursor/resources/app',
        '/usr/lib/cursor/resources/app',
        join(home, '.local/share/cursor/resources/app'),
      ];

    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      // NTFS is case-insensitive but we try both spellings defensively
      return [
        // Per-user install (default from Cursor installer)
        join(localAppData, 'Programs', 'cursor', 'resources', 'app'),
        join(localAppData, 'Programs', 'Cursor', 'resources', 'app'),
        // System-wide install
        join(programFiles, 'Cursor', 'resources', 'app'),
        join(programFilesX86, 'Cursor', 'resources', 'app'),
        // Scoop
        join(home, 'scoop', 'apps', 'cursor', 'current', 'resources', 'app'),
      ];
    }

    default:
      return [];
  }
}

function getExtensionHostPath(appRoot) {
  // Node 的 join 会按平台输出正确的分隔符
  return join(appRoot, 'out', 'vs', 'workbench', 'api', 'node', 'extensionHostProcess.js');
}

function readCursorVersion(appRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseSemver(v) {
  const [major = 0, minor = 0, patch = 0] = v.split('.').map(Number);
  return { major, minor, patch };
}

function buildPaths(appRoot) {
  const cursorVersion = readCursorVersion(appRoot);
  const semver = parseSemver(cursorVersion);
  const hasGlass = semver.major > 3 || (semver.major === 3 && semver.minor >= 8);
  return {
    appRoot,
    cursorVersion,
    hasGlass,
    workbenchJs: join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
    glassJs: join(appRoot, 'out', 'vs', 'workbench', 'workbench.glass.main.js'),
    alwaysLocalMain: join(appRoot, 'extensions', 'cursor-always-local', 'dist', 'main.js'),
    alwaysLocalSingletonJs: join(appRoot, 'out', 'vs', 'code', 'electron-utility', 'alwaysLocalSingleton', 'alwaysLocalSingletonMain.js'),
    extensionHostJs: getExtensionHostPath(appRoot),
    productJson: join(appRoot, 'product.json'),
    extensionsDir: join(appRoot, 'extensions'),
    cursor2plusDir: join(appRoot, 'extensions', 'cursor2plus'),
  };
}

/**
 * @returns {{ paths: object | null, diagnostic: { platform: string, tried: Array<{path, status}>, hint?: string } }}
 */
export function findCursorPathsDetailed() {
  const diagnostic = { platform: platform(), tried: [] };

  // 1. Env override has priority
  const envRoot = process.env.CCURSOR_CURSOR_ROOT;
  if (envRoot) {
    diagnostic.tried.push({ path: envRoot, status: 'env-override' });
    if (!existsSync(join(envRoot, 'product.json'))) {
      diagnostic.hint = `CCURSOR_CURSOR_ROOT has no product.json: ${envRoot}`;
      return { paths: null, diagnostic };
    }
    const paths = buildPaths(envRoot);
    if (!existsSync(paths.workbenchJs)) {
      diagnostic.hint = `Found product.json but workbench.desktop.main.js is missing: ${paths.workbenchJs}`;
      return { paths: null, diagnostic };
    }
    return { paths, diagnostic };
  }

  // 2. 自动检测 — Cursor 沿用 VS Code 的未打包 app/ 目录结构, 不使用 app.asar
  const candidates = getCandidateRoots();
  let foundProductJsonWithoutWorkbench = null;

  for (const appRoot of candidates) {
    if (!existsSync(join(appRoot, 'product.json'))) {
      diagnostic.tried.push({ path: appRoot, status: 'missing' });
      continue;
    }

    const paths = buildPaths(appRoot);
    if (existsSync(paths.workbenchJs)) {
      diagnostic.tried.push({ path: appRoot, status: 'ok' });
      return { paths, diagnostic };
    }

    foundProductJsonWithoutWorkbench = appRoot;
    diagnostic.tried.push({ path: appRoot, status: 'partial' });
  }

  if (foundProductJsonWithoutWorkbench) {
    diagnostic.hint
      = `Found Cursor install dir but workbench.desktop.main.js is missing:\n    ${foundProductJsonWithoutWorkbench}\n`
      + 'Cursor version may be too old or the layout has changed.';
  }
  else {
    diagnostic.hint
      = 'Cursor not found in any default location.\n'
      + 'If installed in a custom path, set CCURSOR_CURSOR_ROOT to point at the resources/app directory and retry.';
  }

  return { paths: null, diagnostic };
}

/** 兼容旧调用 —— 仅返回 paths 或 null */
export function findCursorPaths() {
  return findCursorPathsDetailed().paths;
}

/** 格式化诊断信息为人类可读的多行字符串 */
export function formatDiagnostic(diagnostic) {
  const lines = [];
  lines.push(`Platform: ${diagnostic.platform}`);
  lines.push('Tried paths:');
  if (diagnostic.tried.length === 0) {
    lines.push('  (none — unsupported platform)');
  }
  else {
    for (const t of diagnostic.tried) {
      const tag = t.status === 'ok'
        ? '✓'
        : t.status === 'partial'
          ? '~'
          : t.status === 'env-override'
            ? '→'
            : '✗';
      lines.push(`  ${tag} ${t.path}`);
    }
  }
  if (diagnostic.hint) {
    lines.push('');
    lines.push(diagnostic.hint);
  }
  return lines.join('\n');
}
