import { readFileSync } from 'fs';
import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

const DESCRIPTION = `Performs exact string replacements in files.

Usage:
- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Optional parameter: replace_all (boolean, default false) — if true, replaces all occurrences of old_string in the file.

If you want to create a new file, use the Write tool instead.`;

const ANTHROPIC = {
    name: 'Edit',
    description: DESCRIPTION,
    inputSchema: {
        "type": "object",
        "required": ["path", "old_string", "new_string"],
        "properties": {
            "path": {
                "type": "string",
                "description": "The absolute path to the file to modify"
            },
            "old_string": {
                "type": "string",
                "description": "The text to replace"
            },
            "new_string": {
                "type": "string",
                "description": "The text to replace it with (must be different from old_string)"
            },
            "replace_all": {
                "type": "boolean",
                "description": "Replace all occurrences of old_string (default false)"
            }
        }
    },
};

const GEMINI = {
    name: 'Edit',
    description: DESCRIPTION,
    inputSchema: {
        "type": "OBJECT",
        "required": ["path", "old_string", "new_string"],
        "properties": {
            "path": {
                "type": "STRING",
                "description": "The absolute path to the file to modify"
            },
            "old_string": {
                "type": "STRING",
                "description": "The text to replace"
            },
            "new_string": {
                "type": "STRING",
                "description": "The text to replace it with (must be different from old_string)"
            },
            "replace_all": {
                "type": "BOOLEAN",
                "description": "Replace all occurrences of old_string (default false)"
            }
        }
    },
};

export const EditTool: ToolRegistryEntry = {
    canonicalName: 'Edit',
    aliases: ['Edit'],
    cursorToolType: 'editToolCall',
    execArgsType: 'writeArgs',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        // OpenAI 使用 ApplyPatch — 见 ApplyPatch.ts
        gemini: GEMINI,
    },
    buildStartedArgs: (input) => {
        return { path: str(input.path) };
    },
    buildExecArgs: (input, callId) => {
        const path = str(input.path);
        const oldStr = str(input.old_string);
        const newStr = str(input.new_string);
        const replaceAll = input.replace_all === true;

        const raw = readFileSync(path, 'utf8');
        // BOM 处理 (Pi: stripBom)
        const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
        const stripped = bom ? raw.slice(1) : raw;
        // EOL 检测 + LF 规范化 (Pi: detectLineEnding + normalizeToLF)
        const eol = stripped.indexOf('\r\n') !== -1 && stripped.indexOf('\r\n') <= stripped.indexOf('\n') ? '\r\n' : '\n';
        const normalized = stripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        // 输入也规范化
        const oldNorm = oldStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const newNorm = newStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        const replaced = replaceAll
            ? normalized.split(oldNorm).join(newNorm)
            : normalized.replace(oldNorm, newNorm);

        // 发送纯 LF 内容 — Cursor 客户端通过 VS Code API 写入时自动处理 EOL
        // (对齐 Claude Code FileWriteTool: 不在 server 端做 EOL 还原)
        const fileText = replaced;
        const beforeContent = normalized;
        const streamContent = newNorm;

        return {
            path,
            fileText,
            beforeContent,
            streamContent,
            toolCallId: callId,
        };
    },
};
