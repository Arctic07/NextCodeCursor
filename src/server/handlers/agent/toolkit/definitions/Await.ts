import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

const ANTHROPIC = {
    name: 'AwaitShell',
    description: `Poll a background shell or subagent job. For jobs that cannot be awaited directly, you can omit the task id to sleep for the full \`block_until_ms\` duration.

Monitor backgrounded jobs as follows:
- When job moves to background, check status immediately by reading the output file.
- Poll repeatedly to monitor by using this tool between checks (set \`block_until_ms\` to control how long to wait). If the file gets large, read from the end of the file to capture the latest content.
- Pick your polling intervals using best guess/judgment based on any knowledge you have about the command and its expected runtime, and any output from monitoring the job. When no new output, exponential backoff is a good strategy (e.g. 2000ms, 4000ms, 8000ms, 16000ms...), using educated guess for min and max wait. It's generally bad to go more than 5-10 min without updating the user.
- Shell only guidance:
  - Waiting until a regex matches the output can be useful for e.g. known startup/status/error logs.
  - HARD STOPPING CONSTRAINT: Don't stop polling until (a) job terminates, (b) the command reaches a healthy steady state (only for non-terminating command, e.g. dev server/watcher), or (c) command is hung - follow guidance below.
  - Output file header has \`pid\` and \`running_for_ms\` (updated every 5000ms).
  - When finished, footer with \`exit_code\` and \`elapsed_ms\` appears.
  - If taking longer than expected and the command seems like it is hung (use judgment based on type of command), kill the process if safe to do so using the pid that appears in the header. If possible, try to fix the hang and proceed.`,
    inputSchema: {
            "type": "object",
            "properties": {
                    "task_id": {
                            "type": "string",
                            "description": "Optional shell or subagent id to poll. If omitted, this tool sleeps for the full block_until_ms duration and then returns."
                    },
                    "block_until_ms": {
                            "type": "number",
                            "description": "Max sleep time to block before returning (in milliseconds). Defaults to 30000ms. Set to 0 for non-blocking status check."
                    },
                    "pattern": {
                            "type": "string",
                            "description": "Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output. Will not match terminal file headers or footers, e.g. exit_code. Accepts JavaScript regex patterns (compiled with the multiline `m` flag). Not supported for awaiting subagents: you MUST leave this argument unset."
                    }
            }
    },
};

const OPENAI = {
    name: 'AwaitShell',
    description: `Poll a background shell or subagent job. For jobs that cannot be awaited directly, you can omit the task id to sleep for the full \`block_until_ms\` duration.

Monitor backgrounded jobs as follows:
- When job moves to background, check status immediately by reading the output file.
- Poll repeatedly to monitor by using this tool between checks (set \`block_until_ms\` to control how long to wait). If the file gets large, read from the end of the file to capture the latest content.
- Pick your polling intervals using best guess/judgment based on any knowledge you have about the command and its expected runtime, and any output from monitoring the job. When no new output, exponential backoff is a good strategy (e.g. 2000ms, 4000ms, 8000ms, 16000ms...), using educated guess for min and max wait. It's generally bad to go more than 5-10 min without updating the user.
- Shell only guidance:
- Waiting until a regex matches the output can be useful for e.g. known startup/status/error logs.
- HARD STOPPING CONSTRAINT: Don't stop polling until (a) job terminates, (b) the command reaches a healthy steady state (only for non-terminating command, e.g. dev server/watcher), or (c) command is hung - follow guidance below.
- Output file header has \`pid\` and \`running_for_ms\` (updated every 5000ms).
- When finished, footer with \`exit_code\` and \`elapsed_ms\` appears.
- If taking longer than expected and the command seems like it is hung (use judgment based on type of command), kill the process if safe to do so using the pid that appears in the header. If possible, try to fix the hang and proceed.`,
    inputSchema: {
            "type": "object",
            "properties": {
                    "task_id": {
                            "type": "string",
                            "description": "Optional shell or subagent id to poll. If omitted, this tool sleeps for the full block_until_ms duration and then returns."
                    },
                    "block_until_ms": {
                            "type": "number",
                            "description": "Max sleep time to block before returning (in milliseconds). Defaults to 30000ms. Set to 0 for non-blocking status check."
                    },
                    "pattern": {
                            "type": "string",
                            "description": "Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output. Will not match terminal file headers or footers, e.g. exit_code. Accepts JavaScript regex patterns (compiled with the multiline `m` flag). Not supported for awaiting subagents: you MUST leave this argument unset."
                    }
            }
    },
};

const GEMINI = {
    name: 'AwaitShell',
    description: `Poll a background shell or subagent job. For jobs that cannot be awaited directly, you can omit the task id to sleep for the full \`block_until_ms\` duration.

Monitor backgrounded jobs as follows:
- When job moves to background, check status immediately by reading the output file.
- Poll repeatedly to monitor by using this tool between checks (set \`block_until_ms\` to control how long to wait). If the file gets large, read from the end of the file to capture the latest content.
- Pick your polling intervals using best guess/judgment based on any knowledge you have about the command and its expected runtime, and any output from monitoring the job. When no new output, exponential backoff is a good strategy (e.g. 2000ms, 4000ms, 8000ms, 16000ms...), using educated guess for min and max wait. It's generally bad to go more than 5-10 min without updating the user.
- Shell only guidance:
  - Waiting until a regex matches the output can be useful for e.g. known startup/status/error logs.
  - HARD STOPPING CONSTRAINT: Don't stop polling until (a) job terminates, (b) the command reaches a healthy steady state (only for non-terminating command, e.g. dev server/watcher), or (c) command is hung - follow guidance below.
  - Output file header has \`pid\` and \`running_for_ms\` (updated every 5000ms).
  - When finished, footer with \`exit_code\` and \`elapsed_ms\` appears.
  - If taking longer than expected and the command seems like it is hung (use judgment based on type of command), kill the process if safe to do so using the pid that appears in the header. If possible, try to fix the hang and proceed.`,
    inputSchema: {
            "type": "OBJECT",
            "properties": {
                    "block_until_ms": {
                            "type": "NUMBER",
                            "description": "Max sleep time to block before returning (in milliseconds). Defaults to 30000ms. Set to 0 for non-blocking status check."
                    },
                    "pattern": {
                            "type": "STRING",
                            "description": "Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output. Will not match terminal file headers or footers, e.g. exit_code. Accepts JavaScript regex patterns (compiled with the multiline `m` flag). Not supported for awaiting subagents: you MUST leave this argument unset."
                    },
                    "task_id": {
                            "type": "STRING",
                            "description": "Optional shell or subagent id to poll. If omitted, this tool sleeps for the full block_until_ms duration and then returns."
                    }
            }
    },
};

export const AwaitTool: ToolRegistryEntry = {
    canonicalName: 'AwaitShell',
    aliases: ['AwaitShell', 'Await'],
    cursorToolType: 'awaitToolCall',
    // 官方: Await 通过 readArgs exec 读取终端输出文件
    execArgsType: 'readArgs',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: (input) => ({
        taskId: str(input.task_id),
        ...(typeof input.block_until_ms === 'number' ? { blockUntilMs: input.block_until_ms } : {}),
        ...(typeof input.pattern === 'string' || typeof input.regex === 'string'
            ? { regex: str(input.pattern ?? input.regex) } : {}),
    }),
    // exec: 读取终端输出文件 terminals/{taskId}.txt
    buildExecArgs: (input, callId) => ({
        // 官方样例: path 指向 .cursor/projects/.../terminals/{taskId}.txt
        // BYOK 暂用 taskId 作为占位，实际路径由 toolRuntime 构建
        path: str(input.task_id),
        toolCallId: callId,
    }),
};
