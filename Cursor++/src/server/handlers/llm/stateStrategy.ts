import type { LLMContentBlock, LLMMessage, LLMToolResultBlock } from './types';

export interface ProviderStateStrategy {
    readonly name: string;
    createToolResult(params: {
        toolCallId: string;
        toolName: string;
        content: string;
        isError: boolean;
    }): LLMToolResultBlock;
    addToolResult(messages: LLMMessage[], pending: LLMToolResultBlock[], result: LLMToolResultBlock): void;
    flushToolResults(messages: LLMMessage[], pending: LLMToolResultBlock[]): void;
}

function getTrailingAssistantToolUseOrder(messages: LLMMessage[]): string[] {
    const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
    if (!lastAssistant || typeof lastAssistant.content === 'string') {
        return [];
    }

    const firstToolUseIndex = lastAssistant.content.findIndex(block => block.type === 'tool_use');
    if (firstToolUseIndex < 0) {
        return [];
    }

    return lastAssistant.content
        .slice(firstToolUseIndex)
        .filter((block): block is Extract<LLMContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
        .map(block => block.id);
}

function reorderAnthropicToolResults(messages: LLMMessage[], pending: LLMToolResultBlock[]): LLMToolResultBlock[] {
    if (pending.length <= 1) {
        return [...pending];
    }

    const toolUseOrder = getTrailingAssistantToolUseOrder(messages);
    if (toolUseOrder.length === 0) {
        return [...pending];
    }

    const orderMap = new Map(toolUseOrder.map((id, index) => [id, index]));
    return [...pending].sort((a, b) => {
        const orderA = orderMap.get(a.toolUseId) ?? Number.MAX_SAFE_INTEGER;
        const orderB = orderMap.get(b.toolUseId) ?? Number.MAX_SAFE_INTEGER;
        return orderA - orderB;
    });
}

class AnthropicStateStrategy implements ProviderStateStrategy {
    readonly name = 'anthropic';

    createToolResult(params: {
        toolCallId: string;
        toolName: string;
        content: string;
        isError: boolean;
    }): LLMToolResultBlock {
        return {
            type: 'tool_result',
            toolUseId: params.toolCallId,
            toolName: params.toolName,
            content: params.content,
            ...(params.isError ? { isError: true } : {}),
        };
    }

    addToolResult(_messages: LLMMessage[], pending: LLMToolResultBlock[], result: LLMToolResultBlock): void {
        pending.push(result);
    }

    flushToolResults(messages: LLMMessage[], pending: LLMToolResultBlock[]): void {
        if (pending.length === 0) return;
        const reordered = reorderAnthropicToolResults(messages, pending);
        pending.splice(0, pending.length);
        for (const result of reordered) {
            messages.push({
                role: 'tool',
                content: result.content,
                toolCallId: result.toolUseId,
                toolName: result.toolName,
                ...(result.isError ? { isError: true } : {}),
            });
        }
    }
}

class ToolRoleStateStrategy implements ProviderStateStrategy {
    constructor(readonly name: string) {}

    createToolResult(params: {
        toolCallId: string;
        toolName: string;
        content: string;
        isError: boolean;
    }): LLMToolResultBlock {
        return {
            type: 'tool_result',
            toolUseId: params.toolCallId,
            toolName: params.toolName,
            content: params.content,
            ...(params.isError ? { isError: true } : {}),
        };
    }

    addToolResult(_messages: LLMMessage[], pending: LLMToolResultBlock[], result: LLMToolResultBlock): void {
        pending.push(result);
    }

    flushToolResults(messages: LLMMessage[], pending: LLMToolResultBlock[]): void {
        if (pending.length === 0) return;
        for (const result of pending) {
            messages.push({
                role: 'tool',
                content: result.content,
                toolCallId: result.toolUseId,
                toolName: result.toolName,
                ...(result.isError ? { isError: true } : {}),
            });
        }
        pending.splice(0, pending.length);
    }
}

export const anthropicStateStrategy: ProviderStateStrategy = new AnthropicStateStrategy();
export const openAIStateStrategy: ProviderStateStrategy = new ToolRoleStateStrategy('openai-chat');
export const geminiStateStrategy: ProviderStateStrategy = new ToolRoleStateStrategy('gemini');
