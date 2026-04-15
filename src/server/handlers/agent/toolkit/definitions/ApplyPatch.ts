import { readFileSync } from 'fs';
import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

// ── Patch 解析器 ──

interface ParsedPatch {
    action: 'add' | 'update';
    path: string;
    /** Add File: 新文件的全部内容行 */
    addLines?: string[];
    /** Update File: 变更 hunks */
    hunks?: ParsedHunk[];
}

interface ParsedHunk {
    header?: string;
    contextLines: string[];
    removals: string[];
    additions: string[];
}

function parsePatch(patch: string): ParsedPatch | null {
    const lines = patch.split('\n');
    let i = 0;

    // Skip to *** Begin Patch
    while (i < lines.length && !lines[i].startsWith('*** Begin Patch')) i++;
    if (i >= lines.length) return null;
    i++;

    // Read file operation header
    if (i >= lines.length) return null;
    const headerLine = lines[i];

    if (headerLine.startsWith('*** Add File: ')) {
        const path = headerLine.slice('*** Add File: '.length).trim();
        i++;
        const addLines: string[] = [];
        while (i < lines.length && !lines[i].startsWith('*** End Patch')) {
            const line = lines[i];
            if (line.startsWith('+')) {
                addLines.push(line.slice(1));
            }
            i++;
        }
        return { action: 'add', path, addLines };
    }

    if (headerLine.startsWith('*** Update File: ')) {
        const path = headerLine.slice('*** Update File: '.length).trim();
        i++;
        const hunks: ParsedHunk[] = [];
        let currentHunk: ParsedHunk | null = null;

        while (i < lines.length && !lines[i].startsWith('*** End Patch')) {
            const line = lines[i];
            if (line.startsWith('@@')) {
                if (currentHunk) hunks.push(currentHunk);
                const header = line.length > 2 ? line.slice(3).trim() : undefined;
                currentHunk = { header, contextLines: [], removals: [], additions: [] };
            } else if (line.startsWith('*** End of File')) {
                // ignore
            } else if (currentHunk) {
                if (line.startsWith('-')) {
                    currentHunk.removals.push(line.slice(1));
                } else if (line.startsWith('+')) {
                    currentHunk.additions.push(line.slice(1));
                } else if (line.startsWith(' ')) {
                    currentHunk.contextLines.push(line.slice(1));
                }
            }
            i++;
        }
        if (currentHunk) hunks.push(currentHunk);
        return { action: 'update', path, hunks };
    }

    return null;
}

/**
 * 将 parsed patch 应用到文件，返回新内容。
 * 对于 Add File 直接返回新内容。
 * 对于 Update File 读取当前文件并逐 hunk 替换。
 */
function applyPatch(patch: ParsedPatch): string {
    if (patch.action === 'add') {
        return (patch.addLines ?? []).join('\n');
    }

    // Update File
    let content: string;
    try {
        content = readFileSync(patch.path, 'utf8');
    } catch {
        return ''; // 文件不存在
    }

    const fileLines = content.split('\n');

    for (const hunk of patch.hunks ?? []) {
        // 简化策略：找到 removals 对应的行，替换为 additions
        // 用 context + removals 一起作为搜索模式
        const searchLines = [...hunk.contextLines, ...hunk.removals];
        if (searchLines.length === 0 && hunk.additions.length > 0) {
            // 纯新增，追加到末尾
            fileLines.push(...hunk.additions);
            continue;
        }

        // 在文件中查找 removals 的位置
        for (let j = 0; j < fileLines.length; j++) {
            let match = true;
            for (let k = 0; k < hunk.removals.length; k++) {
                if (j + k >= fileLines.length || fileLines[j + k] !== hunk.removals[k]) {
                    match = false;
                    break;
                }
            }
            if (match && hunk.removals.length > 0) {
                fileLines.splice(j, hunk.removals.length, ...hunk.additions);
                break;
            }
        }
    }

    return fileLines.join('\n');
}

// ── OpenAI 工具定义 ──
// ApplyPatch 只有 OpenAI provider 使用

const OPENAI_DESCRIPTION = `Use this tool to edit files.
Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one file section ]
*** End Patch

Within that envelope, you get one file operation.
You MUST include a header to specify the action you are taking.
Each operation starts with one of two headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Then one or more "hunks", each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change's [context_after] lines in the second change's [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs.
- If a code block is repeated so many times in a class or function such that even a single @@ statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple @@ statements to jump to the right context.

It is important to remember:
- You must only include one file per call
- You must include a header with your intended action (Add/Update)
- You must prefix new lines with \` +\` even when creating a new file

All file paths must be absolute paths. Make sure to read the file before applying a patch to get the latest file content, unless you are creating a new file.`;

const OPENAI = {
    name: 'ApplyPatch',
    description: OPENAI_DESCRIPTION,
    // 官方 Cursor 用 { type: 'string' }（与 OpenAI 的专有协议），
    // 但标准 OpenAI API 强制要求 type: 'object'。BYOK 走标准 API，必须包装。
    inputSchema: {
        type: 'object',
        required: ['patch'],
        properties: {
            patch: {
                type: 'string',
                description: 'The patch content following the format described above. Must obey the lark grammar and start with "*** Begin Patch" and end with "*** End Patch". All file paths must be absolute paths.',
            },
        },
    },
};

export const ApplyPatchTool: ToolRegistryEntry = {
    canonicalName: 'ApplyPatch',
    aliases: ['ApplyPatch'],
    cursorToolType: 'editToolCall',
    execArgsType: 'writeArgs',
    llmToolByProvider: {
        // ApplyPatch 仅 OpenAI provider 使用
        openai: OPENAI,
    },
    buildStartedArgs: (input) => {
        // 官方: toolCallStarted 只发 path，不含 streamContent
        // patch 内容通过 editToolCallDelta 发送
        const patchStr = typeof input === 'string'
            ? input
            : typeof (input as any).patch === 'string'
                ? (input as any).patch
                : str(input as any);
        const parsed = parsePatch(patchStr);
        if (!parsed) throw new Error('Failed to parse patch: invalid format');
        return { path: parsed.path };
    },
    buildExecArgs: (input, callId) => {
        const patchStr = typeof input === 'string'
            ? input
            : typeof (input as any).patch === 'string'
                ? (input as any).patch
                : str(input as any);
        const parsed = parsePatch(patchStr);
        if (!parsed) throw new Error('Failed to parse patch: invalid format');
        const newContent = applyPatch(parsed);
        const beforeContent = (() => { try { return readFileSync(parsed.path, 'utf8'); } catch { return ''; } })();
        // streamContent = patch 格式内容（用于 editToolCallDelta）
        // 从原始 patch 中提取 hunk 部分（去掉 *** Begin Patch 和文件头）
        const patchBody = patchStr
            .replace(/^\*\*\* Begin Patch\n/, '')
            .replace(/^\*\*\* (?:Add|Update) File:.*\n/, '')
            .replace(/\*\*\* End Patch\s*$/, '')
            .trim();
        return {
            path: parsed.path,
            fileText: newContent,
            beforeContent,
            streamContent: patchBody + '\n*** End Patch\n',
            toolCallId: callId,
        };
    },
};
