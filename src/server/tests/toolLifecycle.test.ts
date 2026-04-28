import type { AgentServerMessage } from '../gen/agent_v1_pb'
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

it('runToolCall edit tool uses client readResult before writeArgs', async () => {
  const session = createEphemeralSession('edit-runtime')
  pushSessionMessage(session, {
    execClientMessage: {
      id: 1,
      readResult: {
        success: {
          path: '/workspace/a.txt',
          content: 'hello\nold\n',
          totalLines: 2,
          fileSize: '10',
        },
      },
    },
  })
  pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: 1 } } })
  pushSessionMessage(session, {
    execClientMessage: {
      id: 2,
      writeResult: {
        success: {
          path: '/workspace/a.txt',
          linesCreated: 2,
          fileSize: 10,
        },
      },
    },
  })
  pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: 2 } } })

  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  let execId = 0
  const iterator = runToolCall({
    toolCall: {
      callId: 'call-edit-runtime',
      name: 'Edit',
      input: { path: 'a.txt', old_string: 'old', new_string: 'new' },
    },
    availableMcpTools: [],
    conversationId: 'conv-runtime',
    currentModelId: 'claude-sonnet-4',
    workspacePath: '/workspace',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId: () => ++execId,
    allocateInteractionId: () => 1,
  })

  const frames: AgentServerMessage[] = []
  for await (const frame of iterator) frames.push(frame)

  const execFrames = frames.filter(frame => frame.message.case === 'execServerMessage')
  expect(execFrames).toHaveLength(2)
  const readFrame = execFrames[0]
  const writeFrame = execFrames[1]
  if (readFrame.message.case !== 'execServerMessage' || writeFrame.message.case !== 'execServerMessage')
    throw new Error('expected exec frames')
  expect(readFrame.message.value.message.case).toBe('readArgs')
  expect(writeFrame.message.value.message.case).toBe('writeArgs')
  expect((writeFrame.message.value.message.value as any).fileText).toBe('hello\nnew\n')

  const completed = frames.find(frame => frame.message.case === 'interactionUpdate'
    && frame.message.value.message.case === 'toolCallCompleted')
  expect(completed).toBeTruthy()
  expect(roundContext.pendingToolResults.length).toBe(1)
  expect(roundContext.pendingToolResults[0].content).toContain('hello\nnew\n')
})

it('runToolCall ApplyPatch Add File fails when client readResult says target exists', async () => {
  const session = createEphemeralSession('applypatch-add-exists')
  pushSessionMessage(session, {
    execClientMessage: {
      id: 1,
      readResult: {
        success: {
          path: '/workspace/new.txt',
          content: 'already here\n',
          totalLines: 1,
          fileSize: '13',
        },
      },
    },
  })
  pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: 1 } } })

  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  let execId = 0
  const iterator = runToolCall({
    toolCall: {
      callId: 'call-patch-add-exists',
      name: 'ApplyPatch',
      input: {
        patch: `*** Begin Patch
*** Add File: new.txt
+created
*** End Patch
`,
      },
    },
    availableMcpTools: [],
    conversationId: 'conv-runtime',
    currentModelId: 'gpt-5',
    workspacePath: '/workspace',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId: () => ++execId,
    allocateInteractionId: () => 1,
  })

  const frames: AgentServerMessage[] = []
  for await (const frame of iterator) frames.push(frame)
  const execFrames = frames.filter(frame => frame.message.case === 'execServerMessage')
  expect(execFrames).toHaveLength(1)
  expect(roundContext.pendingToolResults).toHaveLength(1)
  expect(roundContext.pendingToolResults[0].isError).toBe(true)
  expect(roundContext.pendingToolResults[0].content).toContain('target already exists')
})

it('runToolCall ApplyPatch Delete File is rejected before writeArgs', async () => {
  const session = createEphemeralSession('applypatch-delete-reject')
  pushSessionMessage(session, {
    execClientMessage: {
      id: 1,
      readResult: {
        success: {
          path: '/workspace/delete-me.txt',
          content: 'delete me\n',
          totalLines: 1,
          fileSize: '10',
        },
      },
    },
  })
  pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: 1 } } })

  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  let execId = 0
  const iterator = runToolCall({
    toolCall: {
      callId: 'call-patch-delete',
      name: 'ApplyPatch',
      input: {
        patch: `*** Begin Patch
*** Delete File: delete-me.txt
*** End Patch
`,
      },
    },
    availableMcpTools: [],
    conversationId: 'conv-runtime',
    currentModelId: 'gpt-5',
    workspacePath: '/workspace',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId: () => ++execId,
    allocateInteractionId: () => 1,
  })

  const frames: AgentServerMessage[] = []
  for await (const frame of iterator) frames.push(frame)
  const execFrames = frames.filter(frame => frame.message.case === 'execServerMessage')
  expect(execFrames).toHaveLength(1)
  expect(roundContext.pendingToolResults).toHaveLength(1)
  expect(roundContext.pendingToolResults[0].isError).toBe(true)
  expect(roundContext.pendingToolResults[0].content).toContain('use the Delete tool instead')
})

it('runToolCall Write creates file when client readResult is fileNotFound', async () => {
  const session = createEphemeralSession('write-new-file')
  pushSessionMessage(session, {
    execClientMessage: {
      id: 1,
      readResult: {
        fileNotFound: {
          path: '/workspace/new.txt',
        },
      },
    },
  })
  pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: 1 } } })
  pushSessionMessage(session, {
    execClientMessage: {
      id: 2,
      writeResult: {
        success: {
          path: '/workspace/new.txt',
          linesCreated: 1,
          fileSize: 8,
        },
      },
    },
  })
  pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: 2 } } })

  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  let execId = 0
  const iterator = runToolCall({
    toolCall: {
      callId: 'call-write-new',
      name: 'Write',
      input: { path: 'new.txt', contents: 'created\n' },
    },
    availableMcpTools: [],
    conversationId: 'conv-runtime',
    currentModelId: 'claude-sonnet-4',
    workspacePath: '/workspace',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId: () => ++execId,
    allocateInteractionId: () => 1,
  })

  const frames: AgentServerMessage[] = []
  for await (const frame of iterator) frames.push(frame)
  const execFrames = frames.filter(frame => frame.message.case === 'execServerMessage')
  expect(execFrames).toHaveLength(2)
  const writeFrame = execFrames[1]
  if (writeFrame.message.case !== 'execServerMessage')
    throw new Error('expected write frame')
  expect(writeFrame.message.value.message.case).toBe('writeArgs')
  expect((writeFrame.message.value.message.value as any).fileText).toBe('created\n')
  expect(roundContext.pendingToolResults).toHaveLength(1)
  expect(roundContext.pendingToolResults[0].content).toContain('created\n')
})

it('runToolCall Edit reports old_string not found from client content without writeArgs', async () => {
  const session = createEphemeralSession('edit-old-string-missing')
  pushSessionMessage(session, {
    execClientMessage: {
      id: 1,
      readResult: {
        success: {
          path: '/workspace/a.txt',
          content: 'hello\n',
          totalLines: 1,
          fileSize: '6',
        },
      },
    },
  })
  pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: 1 } } })

  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  let execId = 0
  const iterator = runToolCall({
    toolCall: {
      callId: 'call-edit-missing',
      name: 'Edit',
      input: { path: 'a.txt', old_string: 'absent', new_string: 'new' },
    },
    availableMcpTools: [],
    conversationId: 'conv-runtime',
    currentModelId: 'claude-sonnet-4',
    workspacePath: '/workspace',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId: () => ++execId,
    allocateInteractionId: () => 1,
  })

  const frames: AgentServerMessage[] = []
  for await (const frame of iterator) frames.push(frame)
  const execFrames = frames.filter(frame => frame.message.case === 'execServerMessage')
  expect(execFrames).toHaveLength(1)
  expect(roundContext.pendingToolResults).toHaveLength(1)
  expect(roundContext.pendingToolResults[0].isError).toBe(true)
  expect(roundContext.pendingToolResults[0].content).toContain('String to replace not found')
})

it('runToolCall Edit rejects multiple matches from client content without writeArgs', async () => {
  const session = createEphemeralSession('edit-multiple-matches')
  pushSessionMessage(session, {
    execClientMessage: {
      id: 1,
      readResult: {
        success: {
          path: '/workspace/a.txt',
          content: 'same\nsame\n',
          totalLines: 2,
          fileSize: '10',
        },
      },
    },
  })
  pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: 1 } } })

  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  let execId = 0
  const iterator = runToolCall({
    toolCall: {
      callId: 'call-edit-multiple',
      name: 'Edit',
      input: { path: 'a.txt', old_string: 'same', new_string: 'new' },
    },
    availableMcpTools: [],
    conversationId: 'conv-runtime',
    currentModelId: 'claude-sonnet-4',
    workspacePath: '/workspace',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId: () => ++execId,
    allocateInteractionId: () => 1,
  })

  const frames: AgentServerMessage[] = []
  for await (const frame of iterator) frames.push(frame)
  const execFrames = frames.filter(frame => frame.message.case === 'execServerMessage')
  expect(execFrames).toHaveLength(1)
  expect(roundContext.pendingToolResults).toHaveLength(1)
  expect(roundContext.pendingToolResults[0].isError).toBe(true)
  expect(roundContext.pendingToolResults[0].content).toContain('Found 2 matches')
})

it('runToolCall ApplyPatch Update File fails on fileNotFound without writeArgs', async () => {
  const session = createEphemeralSession('applypatch-update-missing')
  pushSessionMessage(session, {
    execClientMessage: {
      id: 1,
      readResult: {
        fileNotFound: {
          path: '/workspace/missing.txt',
        },
      },
    },
  })
  pushSessionMessage(session, { execClientControlMessage: { streamClose: { id: 1 } } })

  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(anthropicStateStrategy)
  let execId = 0
  const iterator = runToolCall({
    toolCall: {
      callId: 'call-patch-update-missing',
      name: 'ApplyPatch',
      input: {
        patch: `*** Begin Patch
*** Update File: missing.txt
@@
-old
+new
*** End Patch
`,
      },
    },
    availableMcpTools: [],
    conversationId: 'conv-runtime',
    currentModelId: 'gpt-5',
    workspacePath: '/workspace',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId: () => ++execId,
    allocateInteractionId: () => 1,
  })

  const frames: AgentServerMessage[] = []
  for await (const frame of iterator) frames.push(frame)
  const execFrames = frames.filter(frame => frame.message.case === 'execServerMessage')
  expect(execFrames).toHaveLength(1)
  expect(roundContext.pendingToolResults).toHaveLength(1)
  expect(roundContext.pendingToolResults[0].isError).toBe(true)
  expect(roundContext.pendingToolResults[0].content).toContain('File not found')
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
