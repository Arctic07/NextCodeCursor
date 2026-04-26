/**
 * editToolCall 运行时
 *
 * 对齐官方帧序列:
 *   1. toolCallStarted → EditArgs { path, streamContent }
 *      (保底创建 bubble — 即使 streaming 阶段没发任何 delta 也能完整显示)
 *   2. readArgs exec → 客户端读文件
 *   3. writeArgs exec → 客户端写文件
 *   4. diff 计算
 *   5. toolCallCompleted → { success: { path, diffString, ... } }
 *
 * streaming 阶段的 editToolCallDelta + partialToolCall{path}
 * 由 conversationRuntime 的 onEvent 回调处理，此处不重复发送。
 */

import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { logger } from '../../logger';
import type { ProviderRoundContext } from '../llm/providerRuntime';
import type { LLMMessage } from '../llm/types';
import {
    execMessage,
    heartbeat,
    toolCallCompleted,
    toolCallStarted,
} from './stream';
import { finalizeToolCall } from './toolLifecycle';
import type { AgentSession } from './session';
import {
    waitForExecClientMessageWithHeartbeat,
    waitForExecStreamCloseWithHeartbeat,
} from './wait';
import { computeDiffFromContents } from './toolkit/definitions/ApplyPatch';

export async function* finalizeEditToolCall(params: {
    session: AgentSession;
    toolName: string;
    callId: string;
    modelCallId: string;
    startedArgs: Record<string, unknown>;
    input: Record<string, unknown>;
    streamContent: string;
    fileText: string;
    beforeContent: string;
    path: string;
    roundContext: Pick<ProviderRoundContext, 'createToolResult' | 'recordToolResult'>;
    messages: LLMMessage[];
    allocateExecMessageId: () => number;
}): AsyncGenerator<AgentServerMessage, void, void> {
    const { callId, modelCallId, path, streamContent, fileText, beforeContent } = params;
    const cursorToolType = 'editToolCall';

    // 1. toolCallStarted — 保底 bubble 创建 (带 path + streamContent)
    const editArgs = { path, streamContent };
    logger.debug({ callId, path, streamContentLen: streamContent.length, modelCallId }, '[EDIT_T] 4.toolCallStarted');
    yield toolCallStarted(callId, cursorToolType, editArgs, modelCallId);

    // 2. readArgs exec
    const readExecMsgId = params.allocateExecMessageId();
    yield execMessage(readExecMsgId, `${callId}-read`, 'readArgs', { path, toolCallId: callId });
    yield* waitForExecClientMessageWithHeartbeat(params.session, readExecMsgId, null);
    yield* waitForExecStreamCloseWithHeartbeat(params.session, readExecMsgId, null);
    yield heartbeat();

    // 3. writeArgs exec
    const writeExecMsgId = params.allocateExecMessageId();
    yield execMessage(writeExecMsgId, `${callId}-write`, 'writeArgs', { path, fileText, toolCallId: callId });
    yield* waitForExecClientMessageWithHeartbeat(params.session, writeExecMsgId, null);
    yield* waitForExecStreamCloseWithHeartbeat(params.session, writeExecMsgId, null);

    // 4. diff
    const { diffString, linesAdded, linesRemoved } = computeDiffFromContents(beforeContent, fileText);
    const message = !beforeContent ? `Wrote contents to ${path}` : `The file ${path} has been updated.`;

    // 5. toolCallCompleted
    const editResult = {
        result: {
            case: 'success',
            value: {
                path, linesAdded, linesRemoved, diffString,
                ...(beforeContent ? { beforeFullFileContent: beforeContent } : {}),
                afterFullFileContent: fileText,
                message,
            },
        },
    };

    const finalized = finalizeToolCall({
        roundContext: params.roundContext,
        messages: params.messages,
        cursorToolType,
        toolName: params.toolName,
        callId,
        startedArgs: editArgs,
        rawToolResult: editResult,
        input: params.input,
        modelCallId,
    });

    logger.debug({ callId, modelCallId }, '[EDIT_T] 5.toolCallCompleted');
    yield finalized.frame;
    logger.info({ tool: params.toolName, path, linesAdded, linesRemoved }, '[EDIT] completed');
}
