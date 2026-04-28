import { homedir } from 'node:os';
import path from 'node:path';

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const WINDOWS_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_RELATIVE_RE = /^[A-Za-z]:(?![\\/])/;
const WINDOWS_UNC_RE = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;
const MSYS_DRIVE_RE = /^\/([A-Za-z])(?:\/|$)/;
const CYGDRIVE_RE = /^\/cygdrive\/([A-Za-z])(?:\/|$)/i;

function normalizeUnicodeSpaces(value: string): string {
  return value.replace(UNICODE_SPACES, ' ');
}

export function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_DRIVE_ABSOLUTE_RE.test(value) || WINDOWS_UNC_RE.test(value);
}

export function isWindowsDriveRelativePath(value: string): boolean {
  return WINDOWS_DRIVE_RELATIVE_RE.test(value);
}

export function isUncPath(value: string): boolean {
  return WINDOWS_UNC_RE.test(value);
}

function isWindowsLikePath(value: string): boolean {
  return isWindowsAbsolutePath(value) || isWindowsDriveRelativePath(value) || value.includes('\\');
}

function shouldUseWindowsPath(inputPath: string, workspacePath?: string): boolean {
  return process.platform === 'win32'
    || isWindowsLikePath(inputPath)
    || !!(workspacePath && isWindowsLikePath(workspacePath));
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return value;
}

function msysPathToWindows(value: string): string {
  const cyg = value.match(CYGDRIVE_RE);
  if (cyg) {
    const drive = cyg[1]!.toUpperCase();
    const rest = value.slice(`/cygdrive/${cyg[1]}`.length).replace(/\//g, '\\');
    return `${drive}:${rest || '\\'}`;
  }

  const msys = value.match(MSYS_DRIVE_RE);
  if (msys) {
    const drive = msys[1]!.toUpperCase();
    const rest = value.slice(2).replace(/^\//, '').replace(/\//g, '\\');
    return `${drive}:${rest ? `\\${rest}` : '\\'}`;
  }

  return value;
}

/**
 * Resolve model-provided tool paths consistently for local filesystem tools.
 *
 * Design mirrors the safer parts of Claude Code's expandPath() and Pi's
 * resolveToCwd(): expand ~, reject ambiguous Windows drive-relative paths,
 * normalize separators for the target platform/path style, and resolve relative
 * paths against the active Cursor workspace rather than the extension host cwd.
 */
export function resolveToolPath(rawPath: unknown, workspacePath?: string): string {
  if (typeof rawPath !== 'string') return '';

  let candidate = normalizeUnicodeSpaces(rawPath).trim();
  if (candidate.includes('\0')) throw new Error('Path contains null bytes');

  const base = workspacePath && workspacePath.trim().length > 0 ? workspacePath.trim() : process.cwd();
  const useWindows = shouldUseWindowsPath(candidate, base);

  if (candidate.length === 0) {
    return useWindows ? path.win32.normalize(base) : path.resolve(base).normalize('NFC');
  }

  candidate = expandHome(candidate);

  if (useWindows && (CYGDRIVE_RE.test(candidate) || MSYS_DRIVE_RE.test(candidate))) {
    candidate = msysPathToWindows(candidate);
  }

  if (isWindowsDriveRelativePath(candidate)) {
    throw new Error(`Ambiguous Windows drive-relative path is not allowed: ${candidate}`);
  }

  if (useWindows) {
    const winCandidate = candidate.replace(/\//g, '\\');
    if (isWindowsAbsolutePath(winCandidate)) return path.win32.normalize(winCandidate).normalize('NFC');
    return path.win32.resolve(base.replace(/\//g, '\\'), winCandidate).normalize('NFC');
  }

  if (path.posix.isAbsolute(candidate)) return path.posix.normalize(candidate).normalize('NFC');
  return path.resolve(base, candidate).normalize('NFC');
}

/**
 * Server-side preflight reads must not touch UNC paths. On Windows, stat/read on
 * an attacker-controlled UNC host may trigger SMB/NTLM authentication. Tools
 * that can delegate execution to the Cursor client may still pass the path on;
 * tools that need server-side content computation should fail closed.
 */
export function assertSafeForServerFs(filePath: string, operation: string): void {
  if (isUncPath(filePath)) {
    throw new Error(`${operation} refused to access UNC path during server-side preflight: ${filePath}`);
  }
}
