/**
 * editToolCall 专用运行时
 *
 * 复刻官方 Cursor 的 editToolCall 完整流程：
 *   1. editToolCallDelta → 流式发送 streamContent（被修改的内容）
 *   2. toolCallStarted → EditArgs { path, streamContent }
 *   3. readArgs exec → 读取原文件内容
 *   4. server 端计算 diff + 构建完整新文件
 *   5. writeArgs exec → 写入新文件
 *   6. toolCallCompleted → { result: { success: { path, linesAdded, linesRemoved,
 *                           diffString, beforeFullFileContent, afterFullFileContent, message } } }
 *
 * 从官方抓包 (Claude.jsonl) 还原的精确消息序列。
 */

import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { logger } from '../../logger';
import type { ProviderRoundContext } from '../llm/providerRuntime';
import type { LLMMessage } from '../llm/types';
import {
    editToolCallStreamDelta,
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

/** 计算简单 unified diff */
function computeDiff(oldContent: string, newContent: string): { diffString: string; linesAdded: number; linesRemoved: number } {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const diffParts: string[] = ['--- a', '+++ b'];
    let linesAdded = 0;
    let linesRemoved = 0;

    // 简单 LCS diff — 找出变更区域
    const maxLen = Math.max(oldLines.length, newLines.length);
    let hunkStart = -1;
    let hunkOld: string[] = [];
    let hunkNew: string[] = [];
    let contextBefore: string[] = [];

    const flushHunk = () => {
        if (hunkOld.length === 0 && hunkNew.length === 0) return;
        const oldStart = hunkStart - contextBefore.length + 1;
        const newStart = oldStart; // simplified
        diffParts.push(`@@ -${oldStart},${hunkOld.length + contextBefore.length} +${newStart},${hunkNew.length + contextBefore.length} @@`);
        for (const l of contextBefore) diffParts.push(` ${l}`);
        for (const l of hunkOld) { diffParts.push(`-${l}`); linesRemoved++; }
        for (const l of hunkNew) { diffParts.push(`+${l}`); linesAdded++; }
        hunkOld = [];
        hunkNew = [];
        contextBefore = [];
    };

    let oi = 0, ni = 0;
    while (oi < oldLines.length || ni < newLines.length) {
        if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
            flushHunk();
            contextBefore.push(oldLines[oi]);
            if (contextBefore.length > 3) contextBefore.shift();
            oi++;
            ni++;
        } else {
            if (hunkOld.length === 0 && hunkNew.length === 0) {
                hunkStart = oi;
            }
            // consume differing lines
            if (oi < oldLines.length && (ni >= newLines.length || oldLines[oi] !== newLines[ni])) {
                hunkOld.push(oldLines[oi]);
                oi++;
            }
            if (ni < newLines.length && (oi >= oldLines.length || (oi < oldLines.length && oldLines[oi] !== newLines[ni]))) {
                hunkNew.push(newLines[ni]);
                ni++;
            }
        }
    }
    flushHunk();

    return { diffString: diffParts.join('\n'), linesAdded, linesRemoved };
}

export async function* finalizeEditToolCall(params: {
    session: AgentSession;
    toolName: string;
    callId: string;
    modelCallId: string;
    startedArgs: Record<string, unknown>;
    input: Record<string, unknown>;
    /** streamContent: 被修改的内容片段（StrReplace: 替换后的行; Write: 全文） */
    streamContent: string;
    /** fileText: 替换后的完整文件内容 */
    fileText: string;
    /** beforeContent: 替换前的完整文件内容（server 已通过 fs.readFileSync 读取） */
    beforeContent: string;
    path: string;
    roundContext: Pick<ProviderRoundContext, 'createToolResult' | 'recordToolResult'>;
    messages: LLMMessage[];
    allocateExecMessageId: () => number;
}): AsyncGenerator<AgentServerMessage, void, void> {
    const { callId, modelCallId, path, streamContent, fileText, beforeContent } = params;
    const cursorToolType = 'editToolCall';

    // 1. editToolCallDelta → 流式发送 streamContent
    if (streamContent) {
        const CHUNK_SIZE = 2000;
        for (let i = 0; i < streamContent.length; i += CHUNK_SIZE) {
            yield editToolCallStreamDelta(callId, streamContent.slice(i, i + CHUNK_SIZE), modelCallId);
        }
    }

    // 2. toolCallStarted → EditArgs { path, streamContent }
    const editArgs = { path, streamContent };
    yield toolCallStarted(callId, cursorToolType, editArgs, modelCallId);

    // 3. readArgs exec → 读取原文件（官方流程要求）
    const readExecId = `${callId}-read`;
    const readExecMsgId = params.allocateExecMessageId();
    yield execMessage(readExecMsgId, readExecId, 'readArgs', {
        path,
        toolCallId: callId,
    });

    // 等待 readResult
    const readResult = yield* waitForExecClientMessageWithHeartbeat(
        params.session, readExecMsgId, null,
    );
    logger.debug({ tool: params.toolName, callId, hasReadResult: !!readResult }, '[EDIT] readArgs result received');

    yield* waitForExecStreamCloseWithHeartbeat(params.session, readExecMsgId, null);

    // 发 heartbeat 保持连接活跃
    yield heartbeat();

    // 4. writeArgs exec → 写入新文件
    const writeExecMsgId = params.allocateExecMessageId();
    const writeExecId = `${callId}-write`;
    yield execMessage(writeExecMsgId, writeExecId, 'writeArgs', {
        path,
        fileText,
        toolCallId: callId,
    });

    // 等待 writeResult
    const writeResult = yield* waitForExecClientMessageWithHeartbeat(
        params.session, writeExecMsgId, null,
    );
    logger.debug({ tool: params.toolName, callId, hasWriteResult: !!writeResult }, '[EDIT] writeArgs result received');

    yield* waitForExecStreamCloseWithHeartbeat(params.session, writeExecMsgId, null);

    // 5. 计算 diff
    const { diffString, linesAdded, linesRemoved } = computeDiff(beforeContent, fileText);
    const isNewFile = !beforeContent;
    const message = isNewFile
        ? `Wrote contents to ${path}`
        : `The file ${path} has been updated.`;

    // 6. toolCallCompleted → 含 diff 信息
    const editResult = {
        result: {
            case: 'success',
            value: {
                path,
                linesAdded,
                linesRemoved,
                diffString,
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

    yield finalized.frame;
    logger.info({
        tool: params.toolName,
        path,
        linesAdded,
        linesRemoved,
    }, '[EDIT] completed');
}
