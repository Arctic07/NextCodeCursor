import { envelope, num, obj, str, truncate, type ToolResultEnvelope } from './shared';

export function buildShellToolResult(
    input: Record<string, unknown>,
    state: {
        stdout: string;
        stderr: string;
        exitCode: number;
        cwd?: string;
        localExecutionTimeMs?: number;
        rejected?: { reason?: string };
        permissionDenied?: { command?: string; workingDirectory?: string; error?: string };
        /**
         * 命令转后台 (ShellStreamBackgrounded)。执行侧(cursor-agent-exec)在超时/用户请求时
         * 把 shell 转后台并回报 shellId/pid/msToWait/reason; server 据此构造"已转后台"结果,
         * 而非误把片段输出 + exitCode=0 当成功。
         */
        backgrounded?: {
            shellId: number;
            pid?: number;
            msToWait?: number;
            /** ShellBackgroundReason: 0=UNSPECIFIED, 1=TIMEOUT, 2=USER_REQUEST */
            reason?: number;
            terminalsFolder?: string;
        };
    },
): ToolResultEnvelope {
    if (state.rejected) {
        return { result: { case: 'rejected', value: { reason: state.rejected.reason ?? 'rejected' } } };
    }
    if (state.backgrounded) {
        const command = str(input.command);
        const workingDirectory = str(state.cwd ?? input.workingDirectory ?? input.cwd);
        const combined = `${state.stdout}${state.stderr}`;
        // ShellSuccess 携带 shell_id(9) / pid(13) / ms_to_wait(15?) / background_reason(14)。
        // 这里按 success case 落盘,文本侧(buildShellToolResultText)依 shellId 识别后台态并复刻
        // 客户端 kZ 的 "moved to background" 措辞。
        return {
            result: {
                case: 'success',
                value: {
                    command,
                    workingDirectory,
                    output: combined,
                    stdout: state.stdout || undefined,
                    stderr: state.stderr || undefined,
                    exitCode: state.exitCode,
                    localExecutionTimeMs: num(state.localExecutionTimeMs),
                    shellId: state.backgrounded.shellId,
                    ...(state.backgrounded.pid !== undefined ? { pid: state.backgrounded.pid } : {}),
                    ...(state.backgrounded.msToWait !== undefined ? { msToWait: state.backgrounded.msToWait } : {}),
                    ...(state.backgrounded.reason !== undefined ? { backgroundReason: state.backgrounded.reason } : {}),
                    ...(state.backgrounded.terminalsFolder ? { terminalsFolder: state.backgrounded.terminalsFolder } : {}),
                },
            },
        };
    }
    if (state.permissionDenied) {
        return {
            result: {
                case: 'permissionDenied',
                value: {
                    command: state.permissionDenied.command ?? str(input.command),
                    workingDirectory: state.permissionDenied.workingDirectory ?? str(input.workingDirectory ?? input.cwd),
                    error: state.permissionDenied.error ?? 'permission denied',
                },
            },
        };
    }

    const command = str(input.command);
    const workingDirectory = str(state.cwd ?? input.workingDirectory ?? input.cwd);
    const combined = `${state.stdout}${state.stderr}`;

    if (state.exitCode === 0) {
        return {
            result: {
                case: 'success',
                value: {
                    command,
                    workingDirectory,
                    output: combined,
                    stdout: state.stdout || undefined,
                    stderr: state.stderr || undefined,
                    exitCode: state.exitCode,
                    localExecutionTimeMs: num(state.localExecutionTimeMs),
                },
            },
        };
    }

    return {
        result: {
            case: 'failure',
            value: {
                command,
                workingDirectory,
                stdout: state.stdout,
                stderr: state.stderr,
                output: combined,
                exitCode: state.exitCode,
                localExecutionTimeMs: num(state.localExecutionTimeMs),
            },
        },
    };
}

export function normalizeShellToolResult(
    resultCaseName: string,
    value: Record<string, unknown>,
    input: Record<string, unknown>,
): ToolResultEnvelope {
    if (resultCaseName === 'success' || resultCaseName === 'failure') {
        return envelope(resultCaseName, {
            command: str(value.command, str(input.command)),
            workingDirectory: str(value.workingDirectory, str(input.workingDirectory ?? input.cwd)),
            output: str(value.output),
            ...(typeof value.stdout === 'string' ? { stdout: value.stdout } : {}),
            ...(typeof value.stderr === 'string' ? { stderr: value.stderr } : {}),
            exitCode: num(value.exitCode),
            ...(value.localExecutionTimeMs !== undefined ? { localExecutionTimeMs: num(value.localExecutionTimeMs) } : {}),
            ...(typeof value.interleavedOutput === 'string' ? { interleavedOutput: value.interleavedOutput } : {}),
            // 后台态字段透传(命令转后台时由 buildShellToolResult 填入),供文本侧识别并复刻 kZ 提示。
            ...(value.shellId !== undefined ? { shellId: num(value.shellId) } : {}),
            ...(value.pid !== undefined ? { pid: num(value.pid) } : {}),
            ...(value.msToWait !== undefined ? { msToWait: num(value.msToWait) } : {}),
            ...(value.backgroundReason !== undefined ? { backgroundReason: num(value.backgroundReason) } : {}),
            ...(typeof value.terminalsFolder === 'string' ? { terminalsFolder: value.terminalsFolder } : {}),
        });
    }
    if (resultCaseName === 'permissionDenied' || resultCaseName === 'spawnError') {
        return envelope(resultCaseName, {
            command: str(value.command, str(input.command)),
            workingDirectory: str(value.workingDirectory, str(input.workingDirectory ?? input.cwd)),
            error: str(value.error, resultCaseName),
        });
    }
    if (resultCaseName === 'rejected') {
        return envelope('rejected', { reason: str(value.reason, 'rejected') });
    }
    return envelope(resultCaseName || 'error', value);
}

/**
 * 复刻客户端 kZ (main.unminify.js:123910) 的"已转后台"提示文本。
 *
 * 客户端原文 (3.5.38):
 *   USER_REQUEST: "The user manually backgrounded the command after {msToWait}ms."
 *   有 msToWait : "The command did not complete in {msToWait}ms and was sent to the background.\n"
 *   兜底       : "Command exceeded block_until_ms and was moved to background.\n\n"
 *   随后附 "Output before backgrounding" + "Shell ID: {id}\n" + 可选 "PID: {pid}\n"
 *   + "Output will continue to be written to {path}. Don't mention Shell ID to the user."
 *   其中 path = {terminalsFolder}/{shellId}.txt (terminalsFolder 即终端文件目录)。
 */
function buildBackgroundedText(value: Record<string, unknown>): string {
    const shellId = num(value.shellId);
    const pid = typeof value.pid === 'number' ? value.pid : undefined;
    const msToWait = typeof value.msToWait === 'number' ? value.msToWait : undefined;
    const reason = num(value.backgroundReason); // 1=TIMEOUT, 2=USER_REQUEST
    const terminalsFolder = str(value.terminalsFolder);
    const outputPath = terminalsFolder ? `${terminalsFolder}/${shellId}.txt` : `<terminals_folder>/${shellId}.txt`;
    const collectedOutput = str(value.output) || `${str(value.stdout)}${str(value.stderr)}`;

    let head: string;
    if (reason === 2) {
        head = `The user manually backgrounded the command${msToWait !== undefined ? ` after ${msToWait}ms` : ''}.\n`;
    } else if (msToWait !== undefined) {
        head = `The command did not complete in ${msToWait}ms and was sent to the background.\n`;
    } else {
        head = 'Command exceeded block_until_ms and was moved to background.\n\n';
    }

    let text = head;
    if (collectedOutput.trim().length > 0) {
        text += `Output before backgrounding:\n\n\`\`\`\n${collectedOutput}\n\`\`\`\n\n`;
    }
    text += `Shell ID: ${shellId}\n`;
    if (pid !== undefined && pid !== 0) text += `PID: ${pid}\n`;
    text += `Output will continue to be written to ${outputPath}. Don't mention Shell ID to the user. Use AwaitShell with this Shell ID to poll for completion.`;
    return text;
}

export function buildShellToolResultText(
    resultCaseName: string,
    value: Record<string, unknown>,
    input: Record<string, unknown>,
): string {
    // 后台态: success case 但携带 shellId(命令已转后台,而非真正完成)。
    if (resultCaseName === 'success' && value.shellId !== undefined) {
        return buildBackgroundedText(value);
    }
    if (resultCaseName === 'success' || resultCaseName === 'failure') {
        const stdout = str(value.stdout);
        const stderr = str(value.stderr);
        const output = str(value.output);
        return truncate([
            `command: ${str(value.command, str(input.command))}`,
            `exit_code: ${num(value.exitCode)}`,
            stdout ? `stdout:\n${stdout}` : '',
            stderr ? `stderr:\n${stderr}` : '',
            !stdout && !stderr && output ? `output:\n${output}` : '',
        ].filter(Boolean).join('\n\n'));
    }
    if (resultCaseName === 'permissionDenied') {
        return `Shell permission denied: ${str(value.error, 'permission denied')}`;
    }
    if (resultCaseName === 'rejected') {
        return `Shell rejected: ${str(value.reason, 'rejected')}`;
    }
    return `Shell ${resultCaseName || 'error'}: ${JSON.stringify(value)}`;
}
