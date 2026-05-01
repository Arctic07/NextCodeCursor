import { extname } from 'node:path';
import { str } from '../shared';
import { resolveToolPath } from '../pathUtils';
import type { ToolExecBuildOptions, ToolRegistryEntry } from '../types';

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

type TextFileMetadata = {
    rawText: string;
    normalizedText: string;
    lineEnding: 'LF' | 'CRLF';
    bom: string;
};

function textMetadataFromContent(rawText: string): TextFileMetadata {
    const bom = rawText.startsWith('\uFEFF') ? '\uFEFF' : '';
    const textWithoutBom = bom ? rawText.slice(1) : rawText;
    const lineEnding = textWithoutBom.includes('\r\n') ? 'CRLF' : 'LF';
    return {
        rawText,
        normalizedText: textWithoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
        lineEnding,
        bom,
    };
}

function normalizeEditText(value: string): string {
    return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function restoreLineEndings(value: string, lineEnding: 'LF' | 'CRLF'): string {
    const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return lineEnding === 'CRLF'
        ? normalized.split('\n').join('\r\n')
        : normalized;
}

function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    return haystack.split(needle).length - 1;
}

export function applyStringEditToContent(params: {
    path: string;
    beforeContent: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
}): { fileText: string; streamContent: string } {
    const { path, beforeContent, oldString, newString, replaceAll } = params;

    if (oldString === newString) {
        throw new Error('No changes to make: old_string and new_string are exactly the same.');
    }
    if (oldString.length === 0) {
        throw new Error('Edit does not create files. Use the Write tool for new files.');
    }
    if (extname(path).toLowerCase() === '.ipynb') {
        throw new Error('File is a Jupyter Notebook. Use EditNotebook to edit notebook cells.');
    }

    const meta = textMetadataFromContent(beforeContent);
    const oldNorm = normalizeEditText(oldString);
    const newNorm = normalizeEditText(newString);
    const matches = countOccurrences(meta.normalizedText, oldNorm);

    if (matches === 0) {
        throw new Error(`String to replace not found in file.\nString: ${oldString}`);
    }
    if (matches > 1 && !replaceAll) {
        throw new Error(`Found ${matches} matches of the string to replace, but replace_all is false. Provide more context or set replace_all to true.\nString: ${oldString}`);
    }

    const edited = replaceAll
        ? meta.normalizedText.split(oldNorm).join(newNorm)
        : meta.normalizedText.replace(oldNorm, newNorm);
    const fileText = meta.bom + restoreLineEndings(edited, meta.lineEnding);

    return {
        fileText,
        streamContent: restoreLineEndings(newNorm, meta.lineEnding),
    };
}

function resolveEditPath(input: Record<string, unknown>, options?: ToolExecBuildOptions): string {
    return resolveToolPath(input.path, options?.workspacePath);
}

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
    buildStartedArgs: (input, _callId, options) => {
        return { path: resolveEditPath(input, options) };
    },
    buildExecArgs: (input, callId, options) => {
        const path = resolveEditPath(input, options);
        return {
            path,
            oldString: str(input.old_string),
            newString: str(input.new_string),
            replaceAll: input.replace_all === true,
            toolCallId: callId,
        };
    },
    buildEditPlan: (input, _callId, options) => {
        const path = resolveEditPath(input, options);
        return {
            kind: 'stringReplace',
            path,
            oldString: str(input.old_string),
            newString: str(input.new_string),
            replaceAll: input.replace_all === true,
            streamContent: str(input.new_string),
        };
    },
};
