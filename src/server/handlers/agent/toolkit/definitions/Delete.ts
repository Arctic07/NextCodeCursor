import { resolveToolPath } from '../pathUtils';
import type { ToolExecBuildOptions, ToolRegistryEntry } from '../types';

const ANTHROPIC = {
    name: 'Delete',
    description: `Deletes a file at the specified path. The operation will fail gracefully if:
    - The file doesn't exist
    - The operation is rejected for security reasons
    - The file cannot be deleted`,
    inputSchema: {
            "type": "object",
            "required": [
                    "path"
            ],
            "properties": {
                    "path": {
                            "type": "string",
                            "description": "The absolute path of the file to delete"
                    }
            }
    },
};

const OPENAI = {
    name: 'Delete',
    description: `Delete file at specified path relative to workspace root; fails gracefully if file doesn't exist, security rejection, or undeletable.`,
    inputSchema: {
            "type": "object",
            "properties": {
                    "path": {
                            "type": "string",
                            "description": "The absolute path of the file to delete"
                    }
            },
            "required": [
                    "path"
            ]
    },
};

const GEMINI = {
    name: 'Delete',
    description: `Deletes a file at the specified path. The operation will fail gracefully if:
    - The file doesn't exist
    - The operation is rejected for security reasons
    - The file cannot be deleted`,
    inputSchema: {
            "type": "OBJECT",
            "properties": {
                    "path": {
                            "type": "STRING",
                            "description": "The absolute path of the file to delete"
                    }
            },
            "required": [
                    "path"
            ]
    },
};

function resolveDeletePath(input: Record<string, unknown>, options?: ToolExecBuildOptions): string {
    return resolveToolPath(input.path, options?.workspacePath);
}

export const DeleteTool: ToolRegistryEntry = {
    canonicalName: 'Delete',
    aliases: ["Delete"],
    cursorToolType: 'deleteToolCall',
    execArgsType: 'deleteArgs',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: (input, callId, options) => ({
        path: resolveDeletePath(input, options),
        toolCallId: callId,
    }),
    buildExecArgs: (input, callId, options) => ({ path: resolveDeletePath(input, options), toolCallId: callId }),
};
