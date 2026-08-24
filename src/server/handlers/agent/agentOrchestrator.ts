import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { collectExtraContextBlobIds, parseRunRequest, resolveExtraContextBlobs } from './protocol';
import type { AgentSession } from './session';
import { handleSummarizeAction } from './summarizeRuntime';
import { handleConversationRun } from './conversationRuntime';
import { clearPersistedConversationCheckpoint, getPersistedConversationCheckpoint } from '../../database/checkpoints';
import { warmupBlobsAsync } from './blobStore';
import { logger } from '../../logger';
import { isAgentRunAbortedError } from './wait';
import { applyMcpsPart, fetchMcpsPart } from './requestContextParts';

export async function* handleRunRequest(
    msg: Record<string, unknown>,
    session: AgentSession | null = null,
): AsyncIterable<AgentServerMessage> {
    const parsed = parseRunRequest(msg);
    // kvGetBlob 请求 id — 与 conversationRuntime 的 blobCounter 相互独立。
    // 用高位起始值避开后者(从 0 递增)的取值区间,防止 id 撞号。
    let nextBlobRequestId = 900_000;

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
        const blobsToWarmup = parsed.historyBlobIds.length > 0 || parsed.historyTurnBlobIds.length > 0 || extraContextBlobIds.length > 0
            ? [...parsed.historyBlobIds, ...parsed.historyTurnBlobIds, ...extraContextBlobIds]
            : [];
        if (blobsToWarmup.length > 0) {
            await warmupBlobsAsync(blobsToWarmup);
        }

        // Warmup 后做一次同步 resolve, 把 extraContextEntries 的 blobId → data 就地替换。
        // 未命中的条目会保留 blobId, 后续 preamble 用 <extra_context_pending> 占位透出。
        if (extraContextBlobIds.length > 0) {
            resolveExtraContextBlobs(parsed);
        }

        // Cursor 3.13+ ref_only 传输模式: requestContext 与顶层 mcp_tools 都不投递,
        // MCP 工具表只存在于 mcps blob 里。这里补取一次,把工具表还原到 parsed。
        // 只在"确实拿到了 blobId 且当前工具表为空"时触发,legacy/dual 模式不受影响。
        if (parsed.mcpsBlobId && parsed.mcpTools.length === 0) {
            const mcpsPart = yield* fetchMcpsPart({
                session,
                blobId: parsed.mcpsBlobId,
                allocateBlobId: () => nextBlobRequestId++,
            });
            if (mcpsPart) {
                applyMcpsPart(parsed, mcpsPart);
            }
        }

        if (parsed.isSummarize) {
            yield* handleSummarizeAction(parsed, session);
            return;
        }

        const hasUserContent = parsed.userText || parsed.selectedImages.length > 0
        if (!hasUserContent && !parsed.isResume && !parsed.isExecutePlan && !parsed.isBackgroundTaskCompletion) {
            logger.warn({ keys: Object.keys(msg) }, '[AGENT] runRequest without userText/images, resume, executePlan, summarizeAction, or backgroundTaskCompletionAction');
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
