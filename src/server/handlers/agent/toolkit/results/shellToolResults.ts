import { envelope, num, str, truncate, type ToolResultEnvelope } from './shared';

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
    },
): ToolResultEnvelope {
    if (state.rejected) {
        return { result: { case: 'rejected', value: { reason: state.rejected.reason ?? 'rejected' } } };
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

export function buildShellToolResultText(
    resultCaseName: string,
    value: Record<string, unknown>,
    input: Record<string, unknown>,
): string {
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
