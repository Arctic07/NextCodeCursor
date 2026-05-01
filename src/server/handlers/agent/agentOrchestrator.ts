import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { collectExtraContextBlobIds, parseRunRequest, resolveExtraContextBlobs } from './protocol';
import type { AgentSession } from './session';
import { handleSummarizeAction } from './summarizeRuntime';
import { handleConversationRun } from './conversationRuntime';
import { clearPersistedConversationCheckpoint, getPersistedConversationCheckpoint } from '../../database/checkpoints';
import { warmupBlobsAsync } from './blobStore';
import { logger } from '../../logger';
import { isAgentRunAbortedError } from './wait';

export async function* handleRunRequest(
    msg: Record<string, unknown>,
    session: AgentSession | null = null,
): AsyncIterable<AgentServerMessage> {
    const parsed = parseRunRequest(msg);

    try {
        const persistedCheckpoint = await getPersistedConversationCheckpoint(parsed.conversationId);
        if (persistedCheckpoint) {
            // 客户端是 source of truth。sqlite checkpoint 仅用于 auto-summarize 持久化,
            // 不用于覆盖客户端的 conversationState。
            const clientSentHistory = parsed.historyBlobIds.length > 0;

            if (!clientSentHistory) {
                // 客户端是 source of truth — 发空就用空, 不从 sqlite 恢复。
                // 空 CS 场景: revert / 新会话。跨模型切换时客户端始终携带 history (日志实证)。
                // sqlite checkpoint 保留不删, 仅用于 auto-summarize 和灾难恢复备份。
                logger.info({
                    conversationId: parsed.conversationId,
                    persistedBlobIds: persistedCheckpoint.rootBlobIds.length,
                }, '[AGENT] empty conversationState with existing checkpoint — trusting client, skipping restore');
            } else {
                // 客户端主动回传了历史 blob → 以客户端为 source of truth。
                // 只在客户端未携带 tokenDetails 时补充一下 sqlite 里缓存的值, 避免上下文用量显示跳变。
                // 注意: summaryArchiveIds 也不做 fallback, 因为客户端已经决定了本轮要带哪些 summary。
                if (!parsed.historyTokenDetails) {
                    parsed.historyTokenDetails = persistedCheckpoint.tokenDetails;
                    logger.debug({
                        conversationId: parsed.conversationId,
                        tokenDetails: parsed.historyTokenDetails,
                    }, '[AGENT] merged tokenDetails from sqlite (client did not provide)');
                }
            }
        }

        // 预热: 将历史 blobs 从 DB 加载到内存缓存, 确保后续 generator 中 getCachedBlob 同步命中。
        // 合并 historyBlobIds + extraContextEntries 的 blob 引用, 一次 warmup 避免多轮磁盘 IO。
        const extraContextBlobIds = collectExtraContextBlobIds(parsed);
        const blobsToWarmup = parsed.historyBlobIds.length > 0 || extraContextBlobIds.length > 0
            ? [...parsed.historyBlobIds, ...extraContextBlobIds]
            : [];
        if (blobsToWarmup.length > 0) {
            await warmupBlobsAsync(blobsToWarmup);
        }

        // Warmup 后做一次同步 resolve, 把 extraContextEntries 的 blobId → data 就地替换。
        // 未命中的条目会保留 blobId, 后续 preamble 用 <extra_context_pending> 占位透出。
        if (extraContextBlobIds.length > 0) {
            resolveExtraContextBlobs(parsed);
        }

        if (parsed.isSummarize) {
            yield* handleSummarizeAction(parsed, session);
            return;
        }

        if (!parsed.userText && !parsed.isResume && !parsed.isExecutePlan && !parsed.isBackgroundTaskCompletion) {
            logger.warn({ keys: Object.keys(msg) }, '[AGENT] runRequest without userText, resume, executePlan, summarizeAction, or backgroundTaskCompletionAction');
            return;
        }

        yield* handleConversationRun(parsed, session);
    } catch (error) {
        if (isAgentRunAbortedError(error)) {
            logger.info({
                conversationId: parsed.conversationId,
                execMessageId: error.execMessageId,
                error: error.message,
            }, '[AGENT] run aborted by client exec control message');
            return;
        }
        throw error;
    }
}
