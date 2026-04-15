import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import type { ProviderRoundContext } from '../llm/providerRuntime';
import type { LLMMessage } from '../llm/types';
import { toolCallCompleted } from './stream';
import {
    buildToolResultText,
    isToolResultError,
    normalizeToolResult,
    type ToolResultEnvelope,
} from './toolResults';

export function finalizeToolCall(params: {
    roundContext: Pick<ProviderRoundContext, 'createToolResult' | 'recordToolResult'>;
    messages: LLMMessage[];
    cursorToolType: string;
    toolName: string;
    callId: string;
    startedArgs: Record<string, unknown>;
    rawToolResult: ToolResultEnvelope;
    input: Record<string, unknown>;
    modelCallId: string;
}): { toolResult: ToolResultEnvelope; resultText: string; frame: AgentServerMessage } {
    const toolResult = normalizeToolResult(params.cursorToolType, params.rawToolResult, params.input);
    const resultText = buildToolResultText(params.cursorToolType, toolResult, params.input);

    params.roundContext.recordToolResult(
        params.messages,
        params.roundContext.createToolResult({
            toolCallId: params.callId,
            toolName: params.toolName,
            content: resultText,
            isError: isToolResultError(toolResult),
        }),
    );

    return {
        toolResult,
        resultText,
        frame: toolCallCompleted(
            params.callId,
            params.cursorToolType,
            params.startedArgs,
            toolResult,
            params.modelCallId,
        ),
    };
}
