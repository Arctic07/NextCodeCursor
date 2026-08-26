/**
 * Clone 血缘 Registry — 记录 Fork Chat 的 source → new 对话映射
 *
 * 背景:
 *   用户在 Cursor 客户端 "Fork Chat" 时,deepCloneComposer 在客户端本地把整个
 *   对话复制成一个新 composer(重映射所有 bubbleId/blobId)。复制完成后,客户端
 *   会调用 agent.v1.AgentService/NotifyConversationClone 向后端登记这次克隆的
 *   血缘关系(新 conversationId ← 源 conversationId + 源 requestId)。
 *
 *   cloned blob 本身走 UploadConversationBlobs 上传并由 blobStore 缓存,所以 fork
 *   出的对话首次发 Run 时,历史 blob 已在缓存中、可正常重建。NotifyConversationClone
 *   只承载血缘元数据,不含 blob 内容。
 *
 * 用途:
 *   1. ACK 客户端调用,避免 unimplemented 报错 + 客户端 3 次重试噪音。
 *   2. 血缘可观测性 — 日志/诊断时能看出某对话是从哪 fork 来的。
 *   3. 为未来扩展留接口(如 transcript 聚合、Privacy Mode 下经 getBlobArgs 回源)。
 *
 * 设计与 blobStore 一致:纯内存 Map,简单 LRU 防泄漏。血缘是辅助元数据,
 * 进程重启丢失无碍(fork 对话的历史靠已缓存/已上传的 blob,不依赖此 registry)。
 */
import { logger } from '../../logger'

export interface CloneLineage {
  /** 源对话 id(被 fork 的那个) */
  sourceConversationId: string
  /** 源对话最后一个带 requestId 的 bubble 的 requestId(fork 分叉点定位) */
  sourceRequestId: string
}

/** newConversationId → 血缘 */
const cloneLineage = new Map<string, CloneLineage>()

const MAX_LINEAGE_ENTRIES = 5000

export function registerCloneLineage(newConversationId: string, lineage: CloneLineage): void {
  if (!newConversationId)
    return
  cloneLineage.set(newConversationId, lineage)
  if (cloneLineage.size > MAX_LINEAGE_ENTRIES) {
    // 简单 LRU:删除最早插入的若干条(Map 保持插入顺序)
    const overflow = cloneLineage.size - MAX_LINEAGE_ENTRIES
    let removed = 0
    for (const key of cloneLineage.keys()) {
      cloneLineage.delete(key)
      if (++removed >= overflow)
        break
    }
  }
  logger.debug(
    { newConversationId, ...lineage, total: cloneLineage.size },
    '[CLONE] registered fork lineage',
  )
}

/** 查某对话是否 fork 自其他对话,返回血缘或 undefined */
export function getCloneLineage(conversationId: string): CloneLineage | undefined {
  return cloneLineage.get(conversationId)
}

export function resetCloneRegistryForTests(): void {
  cloneLineage.clear()
}
