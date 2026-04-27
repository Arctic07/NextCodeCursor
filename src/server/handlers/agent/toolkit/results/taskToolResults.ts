import {
    arr,
    bigintLike,
    bool,
    envelope,
    obj,
    str,
    type ToolResultEnvelope,
} from './shared';

function normalizeConversationStep(value: unknown): Record<string, unknown> {
    const step = obj(value);
    const message = obj(step.message);
    if (typeof message.case === 'string') return { message };
    if (step.assistantMessage) {
        return { message: { case: 'assistantMessage', value: obj(step.assistantMessage) } };
    }
    if (step.toolCall) {
        return { message: { case: 'toolCall', value: obj(step.toolCall) } };
    }
    if (step.thinkingMessage) {
        return { message: { case: 'thinkingMessage', value: obj(step.thinkingMessage) } };
    }
    return { message: { case: 'assistantMessage', value: { text: '' } } };
}

function extractConversationStepText(value: unknown): string {
    const step = obj(value);

    // Normalized protobuf oneof shape used by our ToolResultEnvelope:
    //   { message: { case: 'assistantMessage', value: { text } } }
    const message = obj(step.message);
    if (message.case === 'assistantMessage') return str(obj(message.value).text);

    // protobuf JSON / Cursor client expanded shape:
    //   { assistantMessage: { text } }
    if (step.assistantMessage) return str(obj(step.assistantMessage).text);

    return '';
}

function optionalNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (typeof value === 'bigint') {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    return undefined;
}

export function buildTaskExecToolResult(execClientMsg: Record<string, unknown>): ToolResultEnvelope | null {
    const sr = obj(execClientMsg.subagentResult);
    const success = obj(sr.success);
    if (sr.success) {
        const finalMessage = str(success.finalMessage);
        const durationMs = bigintLike(success.durationMs);
        return {
            result: {
                case: 'success',
                value: {
                    conversationSteps: finalMessage
                        ? [{ message: { case: 'assistantMessage', value: { text: finalMessage } } }]
                        : [],
                    ...(typeof success.agentId === 'string' ? { agentId: success.agentId } : {}),
                    isBackground: bool(success.isBackground),
                    ...(durationMs !== undefined ? { durationMs } : {}),
                    ...(typeof success.resultSuffix === 'string' ? { resultSuffix: success.resultSuffix } : {}),
                    ...(success.backgroundReason !== undefined ? { backgroundReason: success.backgroundReason } : {}),
                    ...(typeof success.transcriptPath === 'string' ? { transcriptPath: success.transcriptPath } : {}),
                    ...(optionalNumber(success.toolCallCount) !== undefined ? { toolCallCount: optionalNumber(success.toolCallCount) } : {}),
                },
            },
        };
    }
    const error = obj(sr.error);
    if (sr.error) {
        return {
            result: {
                case: 'error',
                value: {
                    error: str(error.error, 'subagent error'),
                    ...(typeof error.agentId === 'string' ? { agentId: error.agentId } : {}),
                },
            },
        };
    }
    return { result: { case: 'error', value: { error: 'no result' } } };
}

export function normalizeTaskToolResult(resultCaseName: string, value: Record<string, unknown>): ToolResultEnvelope | null {
    if (resultCaseName === 'success') {
        return envelope('success', {
            conversationSteps: arr(value.conversationSteps).map(normalizeConversationStep),
            ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
            isBackground: bool(value.isBackground),
            ...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}),
            ...(typeof value.resultSuffix === 'string' ? { resultSuffix: value.resultSuffix } : {}),
            ...(value.backgroundReason !== undefined ? { backgroundReason: value.backgroundReason } : {}),
            ...(typeof value.transcriptPath === 'string' ? { transcriptPath: value.transcriptPath } : {}),
            ...(optionalNumber(value.toolCallCount) !== undefined ? { toolCallCount: optionalNumber(value.toolCallCount) } : {}),
        });
    }
    if (resultCaseName) return envelope(resultCaseName, value);
    return null;
}

export function buildTaskToolResultText(resultCaseName: string, value: Record<string, unknown>): string | null {
    if (resultCaseName === 'success') {
        const texts = arr<Record<string, unknown>>(value.conversationSteps)
            .map(extractConversationStepText)
            .filter(Boolean);

        const parts = texts.length > 0 ? [...texts] : [];
        const resultSuffix = str(value.resultSuffix).trim();
        const transcriptPath = str(value.transcriptPath).trim();
        if (resultSuffix) parts.push(resultSuffix);
        if (transcriptPath) parts.push(`[Subagent transcript: ${transcriptPath}]`);

        const body = parts.join('\n\n').trim();
        if (body) return body;
        return `Subagent completed${typeof value.agentId === 'string' ? `: ${value.agentId}` : ''}`;
    }
    if (resultCaseName) return `Task ${resultCaseName || 'error'}: ${JSON.stringify(value)}`;
    return null;
}
