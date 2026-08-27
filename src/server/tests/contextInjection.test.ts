import { create, toJson } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { AgentClientMessageSchema } from '../gen/agent_v1_pb'
import { createEphemeralSession, pushSessionMessage, waitForMessageMatching } from '../handlers/agent/session'

/**
 * steer 注入 (injectContextAction) 的丢弃。
 *
 * 客户端 3.14.27 起,生成中提交的消息会先尝试 steer —— 乐观渲染人类气泡,
 * 发 ConversationAction{injectContextAction},等服务端应答。
 *
 * 我们不支持运行中注入,也不应答: 客户端对此本就有兜底 —— run 结束时
 * reconcileSteerItemsWhenIdle 判定 serverConfirmed !== true,撤掉乐观气泡、
 * 把消息退回队列,随后 tryDispatchNextQueueItem 自动发出,消息不会丢。
 *
 * 但这条消息没有任何 waitForMessageMatching 的 predicate 会匹配,留在
 * messages 里只会无限堆积,所以必须在入口丢弃。
 */

function injectMessage(injectionId: string): Record<string, unknown> {
  return {
    conversationAction: {
      injectContextAction: {
        injectionId,
        expectedRunId: 'run-1',
        userContext: { userMessage: { text: 'steered text', messageId: 'msg-1' } },
      },
    },
  }
}

describe('injectContextAction 的处理', () => {
  it('不进消息队列 —— 否则无人消费,永久积压', () => {
    const session = createEphemeralSession('steer-1')
    pushSessionMessage(session, injectMessage('inj-1'))
    pushSessionMessage(session, injectMessage('inj-2'))

    expect(session.messages).toHaveLength(0)
  })

  it('不干扰同一队列上的 exec 结果等待', async () => {
    const session = createEphemeralSession('steer-2')
    const pending = waitForMessageMatching(session, msg => 'execClientMessage' in msg, 1000)

    pushSessionMessage(session, injectMessage('inj-3'))
    pushSessionMessage(session, { execClientMessage: { id: 1, readResult: {} } })

    const got = await pending
    expect(got).toBeTruthy()
    expect('execClientMessage' in (got as Record<string, unknown>)).toBe(true)
  })

  it('普通 conversationAction 不受影响', () => {
    const session = createEphemeralSession('steer-3')
    pushSessionMessage(session, {
      conversationAction: { userMessageAction: { userMessage: { text: 'hi' } } },
    })
    expect(session.messages).toHaveLength(1)
  })

  it('从真实 proto 编解码后仍能识别 —— 字段名不是我们杜撰的', () => {
    const msg = create(AgentClientMessageSchema, {
      message: {
        case: 'conversationAction',
        value: {
          action: {
            case: 'injectContextAction',
            value: { injectionId: 'inj-proto', expectedRunId: 'run-x' },
          },
        },
      },
    })
    const session = createEphemeralSession('steer-4')
    pushSessionMessage(session, toJson(AgentClientMessageSchema, msg) as Record<string, unknown>)

    expect(session.messages).toHaveLength(0)
  })
})
