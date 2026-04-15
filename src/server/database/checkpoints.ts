import { getAgentDatabase } from './sqlite';

export interface PersistedConversationCheckpoint {
    conversationId: string;
    rootBlobIds: string[];
    summaryArchiveIds: string[];
    tokenDetails: { usedTokens: number; maxTokens: number };
    mode: string;
    updatedAt: number;
}

interface CheckpointRow {
    conversation_id: string;
    root_blob_ids_json: string;
    summary_archive_ids_json: string;
    used_tokens: number;
    max_tokens: number;
    mode: string;
    updated_at: number;
}

function parseStringArray(value: string): string[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
        return [];
    }
}

export async function persistConversationCheckpoint(checkpoint: PersistedConversationCheckpoint): Promise<void> {
    await getAgentDatabase().run(`
        INSERT INTO conversation_checkpoints (
            conversation_id,
            root_blob_ids_json,
            summary_archive_ids_json,
            used_tokens,
            max_tokens,
            mode,
            updated_at
        ) VALUES (
            $conversationId,
            $rootBlobIdsJson,
            $summaryArchiveIdsJson,
            $usedTokens,
            $maxTokens,
            $mode,
            $updatedAt
        )
        ON CONFLICT(conversation_id) DO UPDATE SET
            root_blob_ids_json = excluded.root_blob_ids_json,
            summary_archive_ids_json = excluded.summary_archive_ids_json,
            used_tokens = excluded.used_tokens,
            max_tokens = excluded.max_tokens,
            mode = excluded.mode,
            updated_at = excluded.updated_at
    `, {
        $conversationId: checkpoint.conversationId,
        $rootBlobIdsJson: JSON.stringify(checkpoint.rootBlobIds),
        $summaryArchiveIdsJson: JSON.stringify(checkpoint.summaryArchiveIds),
        $usedTokens: checkpoint.tokenDetails.usedTokens,
        $maxTokens: checkpoint.tokenDetails.maxTokens,
        $mode: checkpoint.mode,
        $updatedAt: checkpoint.updatedAt,
    });
}

export async function getPersistedConversationCheckpoint(conversationId: string): Promise<PersistedConversationCheckpoint | null> {
    if (!conversationId) return null;

    const row = await getAgentDatabase().get<CheckpointRow>(`
        SELECT conversation_id, root_blob_ids_json, summary_archive_ids_json, used_tokens, max_tokens, mode, updated_at
        FROM conversation_checkpoints
        WHERE conversation_id = ?
    `, [conversationId]);
    if (!row) return null;

    return {
        conversationId: row.conversation_id,
        rootBlobIds: parseStringArray(row.root_blob_ids_json),
        summaryArchiveIds: parseStringArray(row.summary_archive_ids_json),
        tokenDetails: {
            usedTokens: row.used_tokens,
            maxTokens: row.max_tokens,
        },
        mode: row.mode,
        updatedAt: row.updated_at,
    };
}

/**
 * 清除指定会话的 sqlite checkpoint。
 *
 * 使用场景: 客户端发送空 conversationState + sqlite 里有旧 checkpoint →
 * 判定为 revert / 用户主动重置 → 清空以避免污染下一次重建。
 *
 * 详见 analysis/checkpoint-revert-protocol.md 的 P0 修复方案。
 */
export async function clearPersistedConversationCheckpoint(conversationId: string): Promise<void> {
    if (!conversationId) return;
    await getAgentDatabase().run(
        `DELETE FROM conversation_checkpoints WHERE conversation_id = ?`,
        [conversationId],
    );
}
