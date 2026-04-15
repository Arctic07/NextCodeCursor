/**
 * agent.v1.AgentService — Agent 模式服务
 *
 * Transport / Session 入口适配层：
 * - 维护 bidi / SSE 生命周期
 * - 建立 session 队列
 * - 将首条 runRequest 交给 agent orchestrator
 *
 * ## 错误处理契约
 *
 * 下游 handler (handleRunRequest / conversationRuntime / ...) 抛出的 error 分两类:
 *
 *   1. **ConnectError with ErrorDetails** —— 已经构造好的客户端友好错误 (通过
 *      makeProviderError/makeToolError/makeModelNotFoundError 等工厂), 直接 rethrow
 *      让 @connectrpc/connect-fastify 序列化到 SSE trailer。客户端 Composer 的
 *      retry banner 依赖这条路径。
 *
 *   2. **其他 Error** —— 裸 Error / ModelNotFoundError / 编码 bug 等, 在顶层 catch
 *      里用 makeProviderError 兜底包装后 rethrow。
 *
 * 之前的实现 (静默 log.error + 不 rethrow) 会让所有错误消失 —— 客户端只看到 SSE
 * 突然结束, 没有 banner。这里的修复是此功能的必要前置。
 */
import type { ConnectRouter } from '@connectrpc/connect'
import { toJson } from '@bufbuild/protobuf'
import { ConnectError } from '@connectrpc/connect'
import { AgentClientMessageSchema, AgentService } from '../../gen/agent_v1_pb'
import { handleRunRequest } from '../../handlers/agent/agentOrchestrator'
import { ModelNotFoundError } from '../../handlers/models/mapper'
import { makeByokConnectError, makeModelNotFoundError, makeProviderError } from '../../handlers/errors'
import { ErrorDetails_Error } from '../../gen/aiserver_v1_pb'
import { closeSession, createEphemeralSession, getOrCreateSession, markSessionClosed, pushSessionMessage, waitForMessage } from '../../handlers/agent/session'
import { logger } from '../../logger'

/**
 * 统一错误归一化: 任何下游冒上来的 error 都要转换成带 ErrorDetails 的 ConnectError,
 * 否则客户端 retry banner 不会显示。
 *
 * 优先级:
 *   1. 已经是 ConnectError → 直接返回 (下游工厂已构造好)
 *   2. ModelNotFoundError → 专用工厂 (is_retryable=false, title 带 modelId)
 *   3. 其他 Error → makeProviderError 兜底 (走 inferRetryable 启发式)
 */
function normalizeToConnectError(error: unknown, context: Record<string, string>): ConnectError {
  if (error instanceof ConnectError)
    return error
  if (error instanceof ModelNotFoundError)
    return makeModelNotFoundError(error.modelId)
  return makeProviderError(error, context)
}

export default (router: ConnectRouter) => {
  router.service(AgentService, {
    /** Bidi streaming (HTTP/2) */
    async* run(requests) {
      logger.info('[SVC] AgentService/Run bidi started')

      const iterator = requests[Symbol.asyncIterator]()
      let firstMsg: Record<string, unknown> | null = null

      while (true) {
        const next = await iterator.next()
        if (next.done)
          return
        const msg = toJson(AgentClientMessageSchema, next.value) as Record<string, unknown>
        if ('clientHeartbeat' in msg || 'kvClientMessage' in msg)
          continue
        if ('runRequest' in msg) {
          firstMsg = msg
          break
        }
      }

      const session = createEphemeralSession(`bidi-${Date.now()}`)
      const pump = (async () => {
        try {
          while (true) {
            const next = await iterator.next()
            if (next.done)
              break
            const msg = toJson(AgentClientMessageSchema, next.value) as Record<string, unknown>
            if ('clientHeartbeat' in msg || 'kvClientMessage' in msg)
              continue
            pushSessionMessage(session, msg)
          }
        }
        finally {
          markSessionClosed(session)
        }
      })()

      try {
        for await (const frame of handleRunRequest(firstMsg, session)) {
          yield frame
        }
      }
      catch (error) {
        // Bidi (HTTP/2) 路径 —— 同 runSSE, 把下游冒上来的错归一化为 ConnectError
        // + ErrorDetails, 让客户端 retry banner 能识别。
        const sessionIdStr = session?.requestId ?? 'bidi'
        const connErr = normalizeToConnectError(error, { transport: 'bidi', sessionId: sessionIdStr })
        logger.error(
          { sessionId: sessionIdStr, error: (error as Error).message, stack: (error as Error).stack },
          '[SVC] AgentService/Run bidi handler error, rethrowing as ConnectError with ErrorDetails',
        )
        throw connErr
      }
      finally {
        markSessionClosed(session)
        await pump.catch((e) => {
          logger.warn({ error: (e as Error).message }, '[SVC] Run bidi pump error')
        })
      }
    },

    /** Server streaming SSE (HTTP/1.1 降级) */
    async* runSSE(req) {
      const requestId = req.requestId
      if (!requestId) {
        // 缺 requestId 无法关联到 bidi session, 走静默 return 让 SSE 正常结束。
        // 这是协议层问题而不是业务错, 不触发 retry banner。
        logger.warn('[SVC] RunSSE called without requestId')
        return
      }

      logger.info({ requestId }, '[SVC] AgentService/RunSSE started')
      const session = getOrCreateSession(requestId)

      try {
        const firstMsg = await waitForMessage(session)
        if (!firstMsg) {
          // Session 建立后没等到首条消息 —— 通常是 BidiAppend 协调慢或客户端问题。
          // 也构造一个 ErrorDetails 让客户端 banner 提示, 可 retry。
          logger.warn({ requestId }, '[SVC] RunSSE no message received (timeout)')
          throw makeByokConnectError({
            errorCode: ErrorDetails_Error.EXTENSION_HOST_TIMEOUT,
            title: 'Agent session timeout',
            detail: 'RunSSE waited for the first BidiAppend message but none arrived. This is usually a client-side routing issue — please retry.',
            isRetryable: true,
            additionalInfo: { requestId },
          })
        }

        logger.info({ requestId, keys: Object.keys(firstMsg) }, '[SVC] RunSSE first message')

        if ('runRequest' in firstMsg) {
          for await (const frame of handleRunRequest(firstMsg, session)) {
            yield frame
          }
        }
      }
      catch (error) {
        // 关键修复 —— 之前这里是 logger.error(...) 后静默吞掉, 导致下游抛出
        // 的任何错误都不会到达客户端, SSE 突然结束, Composer 不会显示 banner。
        //
        // 现在统一归一化为 ConnectError + aiserver.v1.ErrorDetails outgoing
        // detail, 让 @connectrpc/connect-fastify 序列化到 SSE trailer, 客户端
        // @connectrpc 解包后触发 Glass Composer 的 maybeThrowErrorAndRetry,
        // 最终渲染 input 上方的 retry banner。
        const connErr = normalizeToConnectError(error, { transport: 'sse', requestId })
        logger.error(
          { requestId, error: (error as Error).message, stack: (error as Error).stack },
          '[SVC] RunSSE handler error, rethrowing as ConnectError with ErrorDetails',
        )
        throw connErr
      }
      finally {
        closeSession(requestId)
      }
    },
  })
}
