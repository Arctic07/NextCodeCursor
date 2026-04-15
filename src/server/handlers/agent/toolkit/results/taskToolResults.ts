import {
    arr,
    bigintLike,
    bool,
    envelope,
    obj,
    str,
    truncate,
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
        });
    }
    if (resultCaseName) return envelope(resultCaseName, value);
    return null;
}

export function buildTaskToolResultText(resultCaseName: string, value: Record<string, unknown>): string | null {
    if (resultCaseName === 'success') {
        const steps = arr<Record<string, unknown>>(value.conversationSteps);
        const texts = steps
            .map(step => str(obj(step.assistantMessage).text))
            .filter(Boolean);
        if (texts.length > 0) return truncate(texts.join('\n\n'), 12000);
        return `Subagent completed${typeof value.agentId === 'string' ? `: ${value.agentId}` : ''}`;
    }
    if (resultCaseName) return `Task ${resultCaseName || 'error'}: ${JSON.stringify(value)}`;
    return null;
}
