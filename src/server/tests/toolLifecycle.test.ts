import type { LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { finalizeExecTool } from '../handlers/agent/execRuntime'
import { finalizeInteractionTool } from '../handlers/agent/interactionRuntime'
import { createEphemeralSession, pushSessionMessage } from '../handlers/agent/session'
import { buildWebFetchResult, buildWebSearchResult } from '../handlers/agent/toolBuilders'
import { finalizeToolCall } from '../handlers/agent/toolLifecycle'
import { runToolCall } from '../handlers/agent/toolRuntime'
import { AgentRunAbortedError } from '../handlers/agent/wait'
import { anthropicStateStrategy } from '../handlers/llm/stateStrategy'

function createTestRoundContext(strategy: typeof anthropicStateStrategy) {
  const pendingToolResults: LLMToolResultBlock[] = []
  return {
    pendingToolResults,
    createToolResult: strategy.createToolResult.bind(strategy),
    recordToolResult(messages: LLMMessage[], result: LLMToolResultBlock) {
      strategy.addToolResult(messages, pendingToolResults, result)
    },
  }
}

it('finalizeInteractionTool finalizes without session using fallback raw tool result', async () => {
  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  const iterator = finalizeInteractionTool({
    session: null,
    buildRawToolResult: () => buildWebFetchResult({ url: 'https://example.com/x' }),
    roundContext,
    messages,
    cursorToolType: 'webFetchToolCall',
    toolName: 'web_fetch',
    callId: 'call-interaction',
    startedArgs: { url: 'https://example.com/x', toolCallId: 'call-interaction' },
    input: { url: 'https://example.com/x' },
    modelCallId: 'model-interaction',
  })

  const first = await iterator.next()
  expect(first.done).toBe(false)
  if (first.done)
    throw new Error('unexpected done')
  expect(first.value.message.case).toBe('interactionUpdate')
  if (first.value.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(first.value.message.value.message.case).toBe('toolCallCompleted')
})

it('finalizeExecTool finalizes generic exec tool result and returns completion frame', async () => {
  const session = createEphemeralSession('exec-finalize')
  pushSessionMessage(session, {
    execClientMessage: {
      id: 21,
      readResult: {
        success: {
          path: 'a.txt',
          content: 'hello',
          totalLines: 1,
          fileSize: '5',
        },
      },
    },
  })
  pushSessionMessage(session, {
    execClientControlMessage: {
      streamClose: {
        id: 21,
      },
    },
  })

  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  const iterator = finalizeExecTool({
    session,
    toolName: 'read_file',
    callId: 'call-exec',
    cursorToolType: 'readToolCall',
    execMessageId: 21,
    modelCallId: 'model-exec',
    startedArgs: { path: 'a.txt', toolCallId: 'call-exec' },
    input: { path: 'a.txt' },
    roundContext,
    messages,
  })

  const first = await iterator.next()
  expect(first.done).toBe(false)
  if (first.done)
    throw new Error('unexpected done')
  expect(first.value.message.case).toBe('interactionUpdate')
  if (first.value.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(first.value.message.value.message.case).toBe('toolCallCompleted')
  expect(roundContext.pendingToolResults.length).toBe(1)
})

it('finalizeExecTool aborts current run when client sends execClientControlMessage.throw', async () => {
  const session = createEphemeralSession('exec-finalize-abort')
  pushSessionMessage(session, {
    execClientControlMessage: {
      throw: {
        id: 22,
        error: 'signal is aborted without reason',
        stackTrace: 'AbortError: signal is aborted without reason',
      },
    },
  })

  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  const iterator = finalizeExecTool({
    session,
    toolName: 'edit_file',
    callId: 'call-exec-abort',
    cursorToolType: 'editToolCall',
    execMessageId: 22,
    modelCallId: 'model-exec-abort',
    startedArgs: { targetFile: 'a.txt', codeBlock: 'x', toolCallId: 'call-exec-abort' },
    input: { targetFile: 'a.txt', codeBlock: 'x' },
    roundContext,
    messages,
  })

  try {
    await iterator.next()
    expect.unreachable('should have thrown')
  }
  catch (error) {
    expect(error).toBeInstanceOf(AgentRunAbortedError)
    expect((error as AgentRunAbortedError).execMessageId).toBe(22)
    expect((error as Error).message).toMatch(/signal is aborted without reason/)
  }
  expect(roundContext.pendingToolResults.length).toBe(0)
})

it('runToolCall dispatches local webFetch fallback without session', async () => {
  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  const iterator = runToolCall({
    toolCall: {
      callId: 'call-runtime',
      name: 'web_fetch',
      input: { url: 'https://example.com/fallback' },
    },
    availableMcpTools: [],
    conversationId: 'conv-runtime',
    currentModelId: 'claude-sonnet-4',
    round: 0,
    session: null,
    roundContext,
    messages,
    allocateExecMessageId: () => 1,
    allocateInteractionId: () => 1,
  })

  const started = await iterator.next()
  expect(started.done).toBe(false)
  if (started.done)
    throw new Error('unexpected done')
  expect(started.value.message.case).toBe('interactionUpdate')
  if (started.value.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(started.value.message.value.message.case).toBe('toolCallStarted')

  const completed = await iterator.next()
  expect(completed.done).toBe(false)
  if (completed.done)
    throw new Error('unexpected done')
  expect(completed.value.message.case).toBe('interactionUpdate')
  if (completed.value.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(completed.value.message.value.message.case).toBe('toolCallCompleted')
  expect(roundContext.pendingToolResults.length).toBe(1)
})

it('runToolCall injects workspace workingDirectory into shell tool args when model omits it', async () => {
  const session = createEphemeralSession('shell-runtime')
  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  const iterator = runToolCall({
    toolCall: {
      callId: 'call-shell-runtime',
      name: 'Shell',
      input: { command: 'mkdir tmp-test-dir', description: 'Create temp dir' },
    },
    availableMcpTools: [],
    conversationId: 'conv-runtime',
    currentModelId: 'claude-sonnet-4',
    workspacePath: '/workspace/project',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId: () => 41,
    allocateInteractionId: () => 1,
  })

  const started = await iterator.next()
  expect(started.done).toBe(false)
  if (started.done)
    throw new Error('unexpected done')
  expect(started.value.message.case).toBe('interactionUpdate')
  if (started.value.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(started.value.message.value.message.case).toBe('toolCallStarted')
  if (started.value.message.value.message.case !== 'toolCallStarted')
    throw new Error('unexpected case')
  const startedArgs = (started.value.message.value.message.value.toolCall as any)?.tool?.value?.args
  expect(startedArgs.workingDirectory).toBe('/workspace/project')

  const exec = await iterator.next()
  expect(exec.done).toBe(false)
  if (exec.done)
    throw new Error('unexpected done')
  expect(exec.value.message.case).toBe('execServerMessage')
  if (exec.value.message.case !== 'execServerMessage')
    throw new Error('unexpected case')
  const execArgs = exec.value.message.value.message.value as Record<string, unknown>
  expect(execArgs.workingDirectory).toBe('/workspace/project')
  expect(execArgs.command).toBe('mkdir tmp-test-dir')
})

it('finalizeToolCall normalizes result, appends pending tool result, and returns completion frame', () => {
  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)

  const finalized = finalizeToolCall({
    roundContext,
    messages,
    cursorToolType: 'webSearchToolCall',
    toolName: 'web_search',
    callId: 'call-1',
    startedArgs: { searchTerm: 'cursor byok', toolCallId: 'call-1' },
    rawToolResult: buildWebSearchResult({ searchTerm: 'cursor byok' }),
    input: { searchTerm: 'cursor byok' },
    modelCallId: 'model-1',
  })

  expect(finalized.toolResult.result.case).toBe('success')
  expect(roundContext.pendingToolResults.length).toBe(1)
  expect(roundContext.pendingToolResults[0]?.toolUseId).toBe('call-1')
  expect(roundContext.pendingToolResults[0]?.content ?? '').toMatch(/mock-web-search/)
  expect(finalized.frame.message.case).toBe('interactionUpdate')
  if (finalized.frame.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(finalized.frame.message.value.message.case).toBe('toolCallCompleted')
})
