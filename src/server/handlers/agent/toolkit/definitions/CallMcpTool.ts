import { toProtoValueMap } from '../../protoValue';
import { obj, str } from '../shared';
import type { ToolRegistryEntry } from '../types';

/**
 * MCP 动态工具调用 — 不暴露给 LLM (由 MCP 动态注册)。
 * 对应旧 mcpTools.ts 中的 `mcp` 条目。
 */
export const CallMcpToolTool: ToolRegistryEntry = {
    canonicalName: 'CallMcpTool',
    aliases: ['CallMcpTool'],
    cursorToolType: 'mcpToolCall',
    execArgsType: 'mcpArgs',
    llmToolByProvider: {},
    buildStartedArgs: (input, callId) => ({
        name: str(input.name),
        args: toProtoValueMap(obj(input.args)),
        toolCallId: callId,
        providerIdentifier: str(input.providerIdentifier ?? input.provider),
        toolName: str(input.toolName ?? input.tool_name),
    }),
    buildExecArgs: (input, callId) => ({
        name: input.name || '',
        args: toProtoValueMap((input.args as Record<string, unknown>) || {}),
        toolCallId: callId,
        providerIdentifier: input.providerIdentifier || input.provider || '',
        toolName: input.toolName || input.tool_name || '',
    }),
};
