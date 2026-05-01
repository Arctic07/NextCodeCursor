/**
 * Agent Session 管理
 *
 * SSE 降级模式下，Client 通过两个独立通道通信:
 *   - BidiAppend (unary) — 发送 AgentClientMessage (data=base64 proto)
 *   - RunSSE (server_streaming) — 接收 AgentServerMessage 流
 *
 * 两者通过 requestId 关联。Session 维护一个 per-requestId 的消息队列，
 * BidiAppend 写入消息，RunSSE 消费消息并驱动 LLM 调用。
 */
import { fromBinary, toJson } from '@bufbuild/protobuf';
import { AgentClientMessageSchema } from '../../gen/agent_v1_pb';
import { logger } from '../../logger';

export interface AgentSession {
    requestId: string;
    messages: Array<Record<string, unknown>>;
    /** @deprecated 保留向后兼容，新代码使用 listeners */
    notify: (() => void) | null;
    listeners: Set<() => void>;
    closed: boolean;
}

export function createEphemeralSession(requestId: string): AgentSession {
    return { requestId, messages: [], notify: null, listeners: new Set(), closed: false };
}

function notifyAll(session: AgentSession): void {
    session.notify?.();
    for (const fn of session.listeners) fn();
}

export function pushSessionMessage(session: AgentSession, json: Record<string, unknown>): void {
    session.messages.push(json);
    notifyAll(session);
}

export function markSessionClosed(session: AgentSession): void {
    session.closed = true;
    notifyAll(session);
}

const sessions = new Map<string, AgentSession>();

export function getOrCreateSession(requestId: string): AgentSession {
    let session = sessions.get(requestId);
    if (!session) {
        session = { requestId, messages: [], notify: null, listeners: new Set(), closed: false };
        sessions.set(requestId, session);
        logger.debug({ requestId }, '[SESSION] created');
    }
    return session;
}

/** BidiAppend 调用时，将消息推入 session 队列 */
export function appendMessage(requestId: string, data: string): void {
    const session = getOrCreateSession(requestId);

    // data 是 proto string 类型，实际承载的是 protobuf binary 的 hex 字符串表示。
    // "0ad88200a00012..." → hex decode → protobuf bytes
    try {
        const bytes = Buffer.from(data, 'hex');
        const clientMsg = fromBinary(AgentClientMessageSchema, bytes);
        const json = toJson(AgentClientMessageSchema, clientMsg) as Record<string, unknown>;
        const keys = Object.keys(json);
        logger.info({ requestId, keys, protoBytes: bytes.length }, '[SESSION] appendMessage');
        session.messages.push(json);
        notifyAll(session);
    } catch (e) {
        logger.warn({ requestId, dataLen: data.length, error: (e as Error).message }, '[SESSION] proto decode failed');
    }
}

/** 等待下一条消息（任意类型） */
export async function waitForMessage(
    session: AgentSession,
    timeoutMs: number | null = 30_000,
): Promise<Record<string, unknown> | null> {
    return waitForMessageMatching(session, () => true, timeoutMs);
}

/**
 * 等待匹配特定条件的消息
 *
 * 不匹配的消息会被跳过（留在队列中供后续消费）。
 * 用于在 tool call 场景下等待 execClientMessage，
 * 而不被 kvClientMessage/clientHeartbeat 干扰。
 */
export async function waitForMessageMatching(
    session: AgentSession,
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs: number | null = 30_000,
): Promise<Record<string, unknown> | null> {
    // 先检查队列中是否已有匹配消息
    const idx = session.messages.findIndex(predicate);
    if (idx >= 0) {
        return session.messages.splice(idx, 1)[0];
    }
    if (session.closed) return null;

    return new Promise<Record<string, unknown> | null>((resolve) => {
        let resolved = false;

        const cleanup = () => {
            resolved = true;
            if (timer != null)
                clearTimeout(timer);
            session.listeners.delete(listener);
        };

        const timer = timeoutMs == null ? null : setTimeout(() => {
            if (resolved)
                return;
            cleanup();
            logger.warn({ requestId: session.requestId, timeoutMs }, '[SESSION] waitForMessage timeout');
            resolve(null);
        }, timeoutMs);

        const listener = () => {
            if (resolved)
                return;
            const i = session.messages.findIndex(predicate);
            if (i >= 0) {
                cleanup();
                resolve(session.messages.splice(i, 1)[0]);
                return;
            }
            if (session.closed) {
                cleanup();
                resolve(null);
            }
        };

        session.listeners.add(listener);
    });
}

export async function waitForInteractionResponse(
    session: AgentSession,
    id: number,
    expectedCase: string,
    timeoutMs: number | null = 60_000,
): Promise<Record<string, unknown> | null> {
    return waitForMessageMatching(
        session,
        (msg) => {
            if (!('interactionResponse' in msg)) return false;
            const response = msg.interactionResponse as Record<string, unknown> | undefined;
            if (!response) return false;
            const responseId = typeof response.id === 'number' ? response.id : Number(response.id);
            return responseId === id && expectedCase in response;
        },
        timeoutMs,
    );
}

export function closeSession(requestId: string): void {
    const session = sessions.get(requestId);
    if (session) {
        session.closed = true;
        notifyAll(session);
        sessions.delete(requestId);
        logger.debug({ requestId }, '[SESSION] closed');
    }
}
