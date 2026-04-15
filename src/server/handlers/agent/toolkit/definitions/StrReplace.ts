import { readFileSync } from 'fs';
import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

const ANTHROPIC = {
    name: 'StrReplace',
    description: `Performs exact string replacements in files.

Usage:
- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Optional parameter: replace_all (boolean, default false) — if true, replaces all occurrences of old_string in the file.

If you want to create a new file, use the Write tool instead.`,
    inputSchema: {
            "type": "object",
            "required": [
                    "path",
                    "old_string",
                    "new_string"
            ],
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

const OPENAI = {
    name: 'StrReplace',
    description: `Performs exact string replacements in files.

Usage:
- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Optional parameter: replace_all (boolean, default false) — if true, replaces all occurrences of old_string in the file.

If you want to create a new file, use the Write tool instead.`,
    inputSchema: {
            "type": "object",
            "required": [
                    "path",
                    "old_string",
                    "new_string"
            ],
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
    name: 'StrReplace',
    description: `Performs exact string replacements in files.

Usage:
- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Optional parameter: replace_all (boolean, default false) — if true, replaces all occurrences of old_string in the file.

If you want to create a new file, use the Write tool instead.`,
    inputSchema: {
            "type": "OBJECT",
            "properties": {
                    "new_string": {
                            "type": "STRING",
                            "description": "The text to replace it with (must be different from old_string)"
                    },
                    "old_string": {
                            "type": "STRING",
                            "description": "The text to replace"
                    },
                    "path": {
                            "type": "STRING",
                            "description": "The absolute path to the file to modify"
                    },
                    "replace_all": {
                            "type": "BOOLEAN",
                            "description": "Replace all occurrences of old_string (default false)"
                    }
            },
            "required": [
                    "path",
                    "old_string",
                    "new_string"
            ]
    },
};

export const StrReplaceTool: ToolRegistryEntry = {
    canonicalName: 'StrReplace',
    aliases: ['StrReplace'],
    cursorToolType: 'editToolCall',
    execArgsType: 'writeArgs',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        // OpenAI 使用 ApplyPatch 而非 StrReplace — 见 ApplyPatch.ts
        gemini: GEMINI,
    },
    buildStartedArgs: (input) => {
        // 官方: toolCallStarted 只发 path
        // streamContent（仅被修改的行）通过 editToolCallDelta 发送
        return { path: str(input.path) };
    },
    buildExecArgs: (input, callId) => {
        const path = str(input.path);
        const oldStr = str(input.old_string);
        const newStr = str(input.new_string);
        const replaceAll = input.replace_all === true;
        // 读取原文件
        const beforeContent = readFileSync(path, 'utf8');
        // 执行替换
        const fileText = replaceAll
            ? beforeContent.split(oldStr).join(newStr)
            : beforeContent.replace(oldStr, newStr);
        // streamContent = 仅被修改的内容（官方样例: 只有替换后的那一行）
        const streamContent = newStr;
        return {
            path,
            fileText,
            beforeContent,
            streamContent,
            toolCallId: callId,
        };
    },
};
