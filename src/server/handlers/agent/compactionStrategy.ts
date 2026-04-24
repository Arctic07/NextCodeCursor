import { createHash } from 'crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { ConversationSummaryArchiveSchema } from '../../gen/agent_v1_pb';
import { cacheBlob } from './blobStore';
import { encodeBlob } from './blob';
import {
    COMPACTION_LONG_BODY_KEEP_TAIL,
    COMPACTION_LONG_BODY_THRESHOLD,
    COMPACTION_MEDIUM_BODY_KEEP_TAIL,
    COMPACTION_MEDIUM_BODY_THRESHOLD,
} from './constants';
import type { LLMMessage } from '../llm/types';
import type { HistoryEntry } from './historyManager';
import { isPreambleUserMessage, isSummaryBlobMessage } from './historyManager';

export interface CompactionPlan {
    leading: HistoryEntry[];
    summarizeEntries: HistoryEntry[];
    keepTail: HistoryEntry[];
}

export interface CompactionArtifacts {
    summaryText: string;
    summaryBlobId: string;
    summaryBlobData: string;
    archiveBlobs: Array<{ blobId: string; blobData: string }>;
    nextRootBlobIds: string[];
    nextSummaryArchiveIds: string[];
}

export function formatMessageForSummary(message: LLMMessage): string {
    const lines: string[] = [];

    if (typeof message.content === 'string') {
        const text = message.content.trim();
        if (text) lines.push(text);
    } else {
        for (const block of message.content) {
            switch (block.type) {
                case 'text':
                    if (block.text.trim()) lines.push(block.text.trim());
                    break;
                case 'thinking':
                    if (block.text.trim()) lines.push(`[thinking] ${block.text.trim()}`);
                    break;
                case 'tool_use':
                    lines.push(`[tool call] ${block.name} ${JSON.stringify(block.input)}`);
                    break;
                case 'tool_result':
                    lines.push(`[tool result] ${block.toolName ?? block.toolUseId}: ${block.content.trim()}`);
                    break;
            }
        }
    }

    const text = lines.join('\n').trim();
    return text ? `${message.role}:\n${text}` : '';
}

export function estimateTextTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessagesTokens(messages: Array<LLMMessage | { role: string; content: string }>): number {
    return messages.reduce((sum, message) => sum + estimateTextTokens(typeof message.content === 'string' ? message.content : formatMessageForSummary(message as LLMMessage)), 0);
}

export function planCompaction(entries: HistoryEntry[]): CompactionPlan {
    const leading: HistoryEntry[] = [];
    let index = 0;

    if (entries[index]?.message.role === 'system') {
        leading.push(entries[index]);
        index += 1;
    }
    if (entries[index] && isPreambleUserMessage(entries[index].message)) {
        leading.push(entries[index]);
        index += 1;
    }

    const body = entries.slice(index);
    let keepTailCount = body.length > COMPACTION_LONG_BODY_THRESHOLD
        ? COMPACTION_LONG_BODY_KEEP_TAIL
        : body.length > COMPACTION_MEDIUM_BODY_THRESHOLD
            ? COMPACTION_MEDIUM_BODY_KEEP_TAIL
            : 0;
    let summarizeCount = Math.max(0, body.length - keepTailCount);

    if (summarizeCount === 0 && body.length > COMPACTION_MEDIUM_BODY_THRESHOLD) {
        keepTailCount = COMPACTION_MEDIUM_BODY_KEEP_TAIL;
        summarizeCount = Math.max(0, body.length - keepTailCount);
    }

    // tool 配对完整性: 确保切分点不在 tool call/result 之间。
    //
    // 消息序列: assistant(tool_use:A) → tool(result:A) → assistant(tool_use:B) → tool(result:B)
    //
    // 如果 keepTail 以 tool role 开头, 其配对的 assistant(tool_use) 在 summarize 侧,
    // 发给 OpenAI 时报 "No tool call found for function call output"。
    //
    // 同理, 如果 keepTail 以 assistant(含 tool_use) 开头, 但下一条 tool(result)
    // 被切到 summarize 侧, assistant 的 tool_use 就没有配对结果。
    //
    // 修复: 向前扩展 keepTail 到最近的安全边界 (user 或无 tool_use 的 assistant)。
    while (summarizeCount > 0) {
        const first = body[summarizeCount];
        if (!first) break;
        // keepTail 首条是 tool result → 配对的 tool_call 在 summarize 侧
        if (first.message.role === 'tool') {
            summarizeCount--;
            continue;
        }
        // keepTail 首条是 assistant 且含 tool_use → 下面的 tool result 可能被切走
        if (first.message.role === 'assistant' && hasToolUse(first.message)) {
            summarizeCount--;
            continue;
        }
        break;
    }

    return {
        leading,
        summarizeEntries: body.slice(0, summarizeCount),
        keepTail: body.slice(summarizeCount),
    };
}

function hasToolUse(message: LLMMessage): boolean {
    if (typeof message.content === 'string') return false;
    return message.content.some(b => b.type === 'tool_use');
}

function encodeBinaryBlob(bytes: Uint8Array): { blobId: string; blobData: string } {
    const blobData = Buffer.from(bytes).toString('base64');
    const blobId = createHash('sha256').update(blobData).digest('base64');
    return { blobId, blobData };
}

export function createCompactionArtifacts(params: {
    plan: CompactionPlan;
    summaryText: string;
    previousSummaryArchiveIds: string[];
}): CompactionArtifacts {
    const summaryBlob = encodeBlob({
        role: 'assistant',
        content: `Previous conversation summary:\n${params.summaryText}`,
        providerOptions: { cursor: { isSummary: true } },
    });
    cacheBlob(summaryBlob.blobId, summaryBlob.blobData);

    const archiveSourceBlobIds = params.plan.summarizeEntries
        .filter(entry => !isSummaryBlobMessage(entry.raw))
        .map(entry => entry.blobId);

    const archiveBlobs: Array<{ blobId: string; blobData: string }> = [];
    let nextSummaryArchiveIds = [...params.previousSummaryArchiveIds];
    if (archiveSourceBlobIds.length > 0) {
        const encoder = new TextEncoder();
        const archiveMessage = create(ConversationSummaryArchiveSchema, {
            summarizedMessages: archiveSourceBlobIds.map(blobId => encoder.encode(blobId)),
            summary: params.summaryText,
            windowTail: params.plan.keepTail.length,
            summaryMessage: encoder.encode(summaryBlob.blobId),
        });
        const archiveBlob = encodeBinaryBlob(toBinary(ConversationSummaryArchiveSchema, archiveMessage));
        cacheBlob(archiveBlob.blobId, archiveBlob.blobData);
        archiveBlobs.push(archiveBlob);
        nextSummaryArchiveIds = [...nextSummaryArchiveIds, archiveBlob.blobId];
    }

    return {
        summaryText: params.summaryText,
        summaryBlobId: summaryBlob.blobId,
        summaryBlobData: summaryBlob.blobData,
        archiveBlobs,
        nextRootBlobIds: [
            ...params.plan.leading.map(entry => entry.blobId),
            summaryBlob.blobId,
            ...params.plan.keepTail.map(entry => entry.blobId),
        ],
        nextSummaryArchiveIds,
    };
}
