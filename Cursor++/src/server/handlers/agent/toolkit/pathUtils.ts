const WINDOWS_UNC_RE = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;

export function isUncPath(value: string): boolean {
  return WINDOWS_UNC_RE.test(value);
}

/**
 * Minimal server-side path validation only.
 *
 * Official Cursor client/agent-exec performs the real path/cwd interpretation
 * relative to workspace and shell state. The BYOK server must not re-invent
 * that logic using its own process.platform / process.cwd() / homedir().
 */
export function resolveToolPath(rawPath: unknown, _workspacePath?: string): string {
  if (typeof rawPath !== 'string') return '';
  if (rawPath.includes('\0')) throw new Error('Path contains null bytes');
  return rawPath;
}

/**
 * Shell 工作目录参数 —— 与 resolveToolPath 同一原则: 原样透传, 由客户端 agent-exec 解析。
 *
 * 三个 provider 的 Shell schema 声明的都是 snake_case `working_directory`;官方 agent-exec (3.27.22)
 * 同样读取 `"working_directory" in args ? args.working_directory : undefined` 原样作为 workingDirectory。
 * camelCase `workingDirectory` / `cwd` 兼容历史输入。
 */
export function shellWorkingDirectoryArg(input: Record<string, unknown>): string {
  const value = input.working_directory ?? input.workingDirectory ?? input.cwd;
  return typeof value === 'string' ? value : '';
}

/**
 * Server-side preflight reads must not touch UNC paths. On Windows, stat/read on
 * an attacker-controlled UNC host may trigger SMB/NTLM authentication. Tools
 * that need server-side content computation should fail closed.
 */
export function assertSafeForServerFs(filePath: string, operation: string): void {
  if (isUncPath(filePath)) {
    throw new Error(`${operation} refused to access UNC path during server-side preflight: ${filePath}`);
  }
}
