import { expect, it } from 'vitest'
import { createEphemeralSession, pushSessionMessage, waitForInteractionResponse } from '../handlers/agent/session'
import {
  AgentRunAbortedError,
  waitForExecClientMessageWithHeartbeat,
  waitForExecStreamCloseWithHeartbeat,
  waitForPromiseWithHeartbeat,
} from '../handlers/agent/wait'

it('waitForInteractionResponse resolves when interaction response is pushed into session', async () => {
  const session = createEphemeralSession('bidi-test')
  const pending = waitForInteractionResponse(session, 3, 'askQuestionInteractionResponse', 1000)
  pushSessionMessage(session, {
    interactionResponse: {
      id: 3,
      askQuestionInteractionResponse: {
        result: {
          success: {
            answers: [
              {
                questionId: 'tool_test_q1',
                selectedOptionIds: ['opt1'],
              },
            ],
          },
        },
      },
    },
  })

  const response = await pending
  expect(response).toBeTruthy()
  const interaction = response?.interactionResponse as Record<string, unknown>
  expect(interaction.id).toBe(3)
  expect('askQuestionInteractionResponse' in interaction).toBeTruthy()
})

it('waitForInteractionResponse without timeout resolves after delayed response', async () => {
  const session = createEphemeralSession('bidi-test-no-timeout')
  const pending = waitForInteractionResponse(session, 7, 'askQuestionInteractionResponse', null)

  setTimeout(() => {
    pushSessionMessage(session, {
      interactionResponse: {
        id: 7,
        askQuestionInteractionResponse: {
          result: {
            success: {
              answers: [
                {
                  questionId: 'tool_test_q2',
                  selectedOptionIds: ['opt2'],
                },
              ],
            },
          },
        },
      },
    })
  }, 25)

  const response = await pending
  expect(response).toBeTruthy()
  const interaction = response?.interactionResponse as Record<string, unknown>
  expect(interaction.id).toBe(7)
  expect('askQuestionInteractionResponse' in interaction).toBeTruthy()
})

it('waitForPromiseWithHeartbeat yields heartbeat frames before resolving', async () => {
  const iterator = waitForPromiseWithHeartbeat(new Promise<string>((resolve) => {
    setTimeout(resolve, 15, 'done')
  }), 5)

  const first = await iterator.next()
  expect(first.done).toBe(false)
  if (first.done)
    throw new Error('unexpected done')
  expect(first.value.message.case).toBe('interactionUpdate')
  if (first.value.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(first.value.message.value.message.case).toBe('heartbeat')

  let final = await iterator.next()
  while (!final.done) {
    final = await iterator.next()
  }
  expect(final.value).toBe('done')
})

it('waitForExecClientMessageWithHeartbeat returns matching exec client message', async () => {
  const session = createEphemeralSession('exec-heartbeat')
  setTimeout(() => {
    pushSessionMessage(session, {
      execClientMessage: {
        id: 12,
        readResult: {
          success: {
            path: 'a.txt',
            content: 'hello',
          },
        },
      },
    })
  }, 10)

  const iterator = waitForExecClientMessageWithHeartbeat(session, 12, null, 5)
  let final = await iterator.next()
  while (!final.done) {
    final = await iterator.next()
  }

  expect(final.value).toBeTruthy()
  expect(!!(final.value as Record<string, unknown>).execClientMessage).toBe(true)
})

it('waitForExecStreamCloseWithHeartbeat returns matching stream close control message', async () => {
  const session = createEphemeralSession('exec-close-heartbeat')
  setTimeout(() => {
    pushSessionMessage(session, {
      execClientControlMessage: {
        streamClose: {
          id: 13,
        },
      },
    })
  }, 10)

  const iterator = waitForExecStreamCloseWithHeartbeat(session, 13, null, 5)
  let final = await iterator.next()
  while (!final.done) {
    final = await iterator.next()
  }

  expect(final.value).toBeTruthy()
  expect((((final.value as Record<string, unknown>).execClientControlMessage as Record<string, unknown>).streamClose as Record<string, unknown>).id).toBe(13)
})

it('waitForExecClientMessageWithHeartbeat throws AgentRunAbortedError on execClientControlMessage.throw', async () => {
  const session = createEphemeralSession('exec-throw-heartbeat')
  setTimeout(() => {
    pushSessionMessage(session, {
      execClientControlMessage: {
        throw: {
          id: 14,
          error: 'signal is aborted without reason',
          stackTrace: 'AbortError: signal is aborted without reason',
        },
      },
    })
  }, 10)

  const iterator = waitForExecClientMessageWithHeartbeat(session, 14, null, 5)
  try {
    let final = await iterator.next()
    while (!final.done) {
      final = await iterator.next()
    }
    expect.unreachable('should have thrown')
  }
  catch (error) {
    expect(error).toBeInstanceOf(AgentRunAbortedError)
    expect((error as AgentRunAbortedError).execMessageId).toBe(14)
    expect((error as Error).message).toMatch(/signal is aborted without reason/)
  }
})
