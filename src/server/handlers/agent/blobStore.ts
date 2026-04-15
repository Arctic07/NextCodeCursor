/**
 * Blob Store — Server 端 blob 缓存
 *
 * 双层存储:
 *   1. 内存 Map (主要路径) — 同步读写，保证 generator/hot path 无阻塞
 *   2. SQLite (持久化) — 异步写入，启动时预热
 *
 * Server 每次发出 setBlobArgs 时，同时缓存 blob 内容。
 * 下一轮 Client 带回 blob IDs 时，Server 直接从内存缓存读取，
 * 无需通过 getBlobArgs 握手向 Client 取回。
 *
 * SSE 降级模式下 getBlobArgs 握手不可靠（Server 无法在 yield 中间等待 Client 回传），
 * 因此 Server 端缓存是必要的。
 */
import { logger } from '../../logger';
import { loadPersistedBlob, persistBlob } from '../../database/blobs';

/** blobId → blobData (base64) */
const blobCache = new Map<string, string>();

/**
 * 同步写内存缓存 + fire-and-forget 持久化到 DB。
 * 调用方无需 await，DB 失败仅记录日志不中断流程。
 */
export function cacheBlob(blobId: string, blobData: string): void {
    blobCache.set(blobId, blobData);
    persistBlob(blobId, blobData).catch(err => {
        logger.warn({ blobId, error: (err as Error).message }, '[SESSION] persistBlob failed (continuing)');
    });
}

/**
 * 同步从内存缓存读取。
 * 若 miss，返回 undefined — 调用方应在进入 hot path 前先调用 warmupBlobsAsync 预热。
 */
export function getCachedBlob(blobId: string): string | undefined {
    return blobCache.get(blobId);
}

/**
 * 异步预热: 从 DB 加载指定 blobs 到内存缓存。
 * 应在进入 generator/hot path 之前调用一次，确保后续 getCachedBlob 同步命中。
 */
export async function warmupBlobsAsync(blobIds: string[]): Promise<void> {
    const missing = blobIds.filter(id => !blobCache.has(id));
    if (missing.length === 0) return;

    await Promise.all(missing.map(async id => {
        try {
            const data = await loadPersistedBlob(id);
            if (data !== undefined) {
                blobCache.set(id, data);
            }
        } catch (err) {
            logger.warn({ blobId: id, error: (err as Error).message }, '[SESSION] warmupBlob failed');
        }
    }));
}

/** 从缓存获取多个 blob，返回解码后的 JSON 对象数组 */
export function getCachedBlobsAsMessages(blobIds: string[]): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    if (blobIds.length > 0) {
        const cacheKeys = [...blobCache.keys()].slice(0, 3);
        logger.debug({ requestedFirst: blobIds[0], cacheKeySamples: cacheKeys, cacheSize: blobCache.size }, '[SESSION] blob cache lookup');
    }
    for (const id of blobIds) {
        const data = blobCache.get(id);
        if (data) {
            try {
                const json = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'));
                messages.push(json);
            } catch (e) {
                logger.warn({ blobId: id, error: (e as Error).message }, '[SESSION] failed to decode cached blob');
            }
        } else {
            logger.debug({ blobId: id }, '[SESSION] blob not in cache');
        }
    }
    return messages;
}

/** 清理过期缓存 (简单 LRU，防止内存泄漏) */
export function cleanupBlobCache(maxSize = 10000): void {
    if (blobCache.size > maxSize) {
        const keysToDelete = [...blobCache.keys()].slice(0, blobCache.size - maxSize);
        for (const key of keysToDelete) {
            blobCache.delete(key);
        }
        logger.debug({ removed: keysToDelete.length, remaining: blobCache.size }, '[SESSION] blob cache cleanup');
    }
}

export function resetBlobCacheForTests(): void {
    blobCache.clear();
}
