import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import type { ProviderRoundContext } from '../llm/providerRuntime';
import type { LLMContentBlock, LLMMessage } from '../llm/types';
import { toolCallCompleted } from './stream';
import {
    buildToolResultText,
    isToolResultError,
    normalizeToolResult,
    type ToolResultEnvelope,
} from './toolResults';

const IMAGE_EXTENSIONS: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

function extractReadImageBlock(cursorToolType: string, toolResult: ToolResultEnvelope, input: Record<string, unknown>): Extract<LLMContentBlock, { type: 'image' }> | null {
    if (cursorToolType !== 'readToolCall') return null;
    const value = toolResult.result?.value as Record<string, unknown> | undefined;
    if (!value || toolResult.result?.case !== 'success') return null;
    const output = value.output as { case: string; value: unknown } | undefined;
    if (output?.case !== 'data' || !(output.value instanceof Uint8Array)) return null;
    const bytes = output.value as Uint8Array;
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_SIZE) return null;
    const path = String(value.path ?? input.path ?? '');
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const mimeType = IMAGE_EXTENSIONS[ext];
    if (!mimeType) return null;
    return { type: 'image', mimeType, data: Buffer.from(bytes).toString('base64') };
}

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
}): { toolResult: ToolResultEnvelope; resultText: string; frame: AgentServerMessage; imageBlock: Extract<LLMContentBlock, { type: 'image' }> | null } {
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
        imageBlock: extractReadImageBlock(params.cursorToolType, toolResult, params.input),
    };
}
