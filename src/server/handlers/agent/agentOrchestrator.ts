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
            // 客户端回传的 conversationState 是唯一可信的 source of truth。
            //
            // 两种"客户端发空 historyBlobIds"的场景:
            //   1. 首次新会话: sqlite 里也没有这个 conversationId → 上面 getPersisted 返回 null,不走此分支
            //   2. revert / 用户显式重置: sqlite 里有旧 checkpoint,但客户端已经"忘了"它
            //
            // 历史做法是"fallback 到 sqlite 恢复 blob",但这会让 revert 完全失效 ——
            // LLM 会看到被 revert 掉的消息仍然存在。
            //
            // 现在的策略: 客户端发空 historyBlobIds 时, 判定为重置信号 → 清空 sqlite 对应行
            // 避免污染本次或后续的重建流程。
            //
            // 详见 analysis/checkpoint-revert-protocol.md
            const clientSentHistory = parsed.historyBlobIds.length > 0;

            if (!clientSentHistory) {
                // 客户端发来空 conversationState 可能是:
                //   1. revert (checkpoint 回退) — 需要清空历史
                //   2. 切换模型 — 客户端重新初始化, 后续会带上 history
                //   3. 新会话首条消息 — 正常的空状态
                //
                // 不主动清空 sqlite checkpoint, 而是从 sqlite 恢复历史。
                // 如果客户端真的要 revert, 它会在后续请求中发送 revert 的目标 checkpoint。
                // 如果是切换模型, 恢复的历史能让 LLM 看到之前的上下文。
                logger.info({
                    conversationId: parsed.conversationId,
                    kind: persistedCheckpoint.kind,
                    persistedBlobIds: persistedCheckpoint.rootBlobIds.length,
                    persistedSummaryArchives: persistedCheckpoint.summaryArchiveIds.length,
                }, '[AGENT] empty conversationState → restoring from committed checkpoint');

                parsed.historyBlobIds = persistedCheckpoint.rootBlobIds;
                parsed.historySummaryArchiveIds = persistedCheckpoint.summaryArchiveIds;
                if (!parsed.historyTokenDetails) {
                    parsed.historyTokenDetails = persistedCheckpoint.tokenDetails;
                }
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

        if (!parsed.userText && !parsed.isResume && !parsed.isExecutePlan) {
            logger.warn({ keys: Object.keys(msg) }, '[AGENT] runRequest without userText, resume, executePlan, or summarizeAction');
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
