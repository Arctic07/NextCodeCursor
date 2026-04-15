import type { ToolResultEnvelope } from '../handlers/agent/toolBuilders'
import { toBinary, toJsonString } from '@bufbuild/protobuf'
import { expect, it } from 'vitest'
import { AgentServerMessageSchema } from '../gen/agent_v1_pb'
import { execMessage, partialToolCall, toolCallCompleted, toolCallStarted } from '../handlers/agent/stream'
import {
  buildExecToolResult,
  buildToolResultText,
  buildWebFetchResult,
  buildWebSearchResult,
  isToolResultError,
  normalizeToolResult,
} from '../handlers/agent/toolBuilders'
import { buildExecArgs, resolveToolCall } from '../handlers/agent/tools'

it('normalizeToolResult wraps grep workspaceResults map values as GrepUnionResult oneof', () => {
  const normalized = normalizeToolResult('grepToolCall', {
    result: {
      case: 'success',
      value: {
        pattern: 'needle',
        path: '/workspace',
        workspaceResults: {
          '/workspace': {
            content: {
              matches: [
                {
                  file: 'src/index.ts',
                  matches: [
                    {
                      lineNumber: 12,
                      content: 'needle here',
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  }, {
    pattern: 'needle',
    path: '/workspace',
  })

  expect(normalized.result.case).toBe('success')
  const workspace = (normalized.result.value.workspaceResults as Record<string, unknown>)['/workspace'] as Record<string, unknown>
  const union = workspace.result as { case: string, value: Record<string, unknown> }
  expect(union.case).toBe('content')
  expect((union.value.matches as Array<Record<string, unknown>>)[0]?.file).toBe('src/index.ts')

  const text = buildToolResultText('grepToolCall', normalized, { pattern: 'needle' })
  expect(text).toMatch(/src\/index\.ts:12 needle here/)
})

it('normalizeToolResult wraps read success output as oneof and text reads content', () => {
  const normalized = normalizeToolResult('readToolCall', {
    result: {
      case: 'success',
      value: {
        path: '/tmp/file.txt',
        totalLines: 2,
        fileSize: 11,
        truncated: false,
        rangeApplied: false,
        output: {
          content: 'hello world',
        },
      },
    },
  }, {
    path: '/tmp/file.txt',
  })

  expect(normalized.result.case).toBe('success')
  const output = normalized.result.value.output as { case: string, value: unknown }
  expect(output.case).toBe('content')
  expect(output.value).toBe('hello world')
  expect(buildToolResultText('readToolCall', normalized, { path: '/tmp/file.txt' })).toBe('hello world')
})

it('buildExecToolResult keeps flat exec readResult.success.content instead of blanking it', async () => {
  const { buildExecToolResult } = await import('../handlers/agent/toolBuilders')
  const built = buildExecToolResult('readToolCall', {
    readResult: {
      success: {
        path: 'test_file.txt',
        content: 'Hello read tool',
        totalLines: 1,
        fileSize: '15',
      },
    },
  }, {
    path: 'test_file.txt',
  })

  expect(built.result.case).toBe('success')
  const output = built.result.value.output as { case: string, value: unknown }
  expect(output.case).toBe('content')
  expect(output.value).toBe('Hello read tool')

  const normalized = normalizeToolResult('readToolCall', built, { path: 'test_file.txt' })
  const normalizedOutput = normalized.result.value.output as { case: string, value: unknown }
  expect(normalizedOutput.case).toBe('content')
  expect(normalizedOutput.value).toBe('Hello read tool')
  expect(buildToolResultText('readToolCall', normalized, { path: 'test_file.txt' })).toBe('Hello read tool')
})

it('normalizeToolResult wraps mcp content items as nested oneof content blocks', () => {
  const normalized = normalizeToolResult('mcpToolCall', {
    result: {
      case: 'success',
      value: {
        content: [
          {
            text: {
              text: 'plain text result',
            },
          },
          {
            image: {
              data: 'ZmFrZQ==',
              mimeType: 'image/png',
            },
          },
        ],
        isError: false,
        structuredContent: {
          foo: 'bar',
        },
      },
    },
  }, {})

  expect(normalized.result.case).toBe('success')
  const content = normalized.result.value.content as Array<Record<string, unknown>>
  expect((content[0]?.content as { case: string }).case).toBe('text')
  expect(((content[0]?.content as { value: Record<string, unknown> }).value.text)).toBe('plain text result')
  expect((content[1]?.content as { case: string }).case).toBe('image')
})

it('resolveToolCall maps descriptor-provided external tools onto mcpToolCall with provider metadata', () => {
  const resolved = resolveToolCall('user-Context7-query-docs', {
    libraryId: '/vercel/next.js',
    query: 'routing',
  }, [
    {
      name: 'user-Context7-query-docs',
      providerIdentifier: 'Context7',
      toolName: 'query-docs',
    },
  ])

  expect(resolved.cursorToolType).toBe('mcpToolCall')
  expect(resolved.sanitizedInput.name).toBe('user-Context7-query-docs')
  expect(resolved.sanitizedInput.providerIdentifier).toBe('Context7')
  expect(resolved.sanitizedInput.toolName).toBe('query-docs')
  expect(resolved.sanitizedInput.args).toEqual({
    libraryId: '/vercel/next.js',
    query: 'routing',
  })
})

it('mcp tool args serialize correctly as google.protobuf.Value map entries', async () => {
  const { buildToolArgs } = await import('../handlers/agent/toolBuilders')
  const resolved = resolveToolCall('user-brave-search-brave_web_search', {
    query: 'cursor',
    count: 3,
    includeDomains: ['example.com'],
    freshness: null,
    safe: true,
  }, [
    {
      name: 'user-brave-search-brave_web_search',
      providerIdentifier: 'brave-search',
      toolName: 'brave_web_search',
    },
  ])

  const startedArgs = buildToolArgs('CallMcpTool', resolved.sanitizedInput, 'call-1')
  const execArgs = buildExecArgs('CallMcpTool', resolved.sanitizedInput, 'call-1')

  const startedFrame = toolCallStarted('call-1', resolved.cursorToolType, startedArgs, 'model-1')
  const execFrame = execMessage(1, 'exec-1', 'mcpArgs', execArgs)

  const startedJson = toJsonString(AgentServerMessageSchema, startedFrame)
  const execJson = toJsonString(AgentServerMessageSchema, execFrame)

  expect(startedJson).toMatch(/"providerIdentifier":"brave-search"/)
  expect(startedJson).toMatch(/"toolName":"brave_web_search"/)
  expect(startedJson).toMatch(/"query":"cursor"/)
  expect(execJson).toMatch(/"mcpArgs"/)
  expect(execJson).toMatch(/"includeDomains":\["example.com"\]/)
  expect(toBinary(AgentServerMessageSchema, startedFrame).length > 0).toBeTruthy()
})

it('partialToolCall maps dynamic external tool names to valid proto tool cases', () => {
  const frame = partialToolCall('call-1', 'mcpToolCall', 'model-1')
  const json = toJsonString(AgentServerMessageSchema, frame)
  expect(json).toMatch(/"mcpToolCall"/)
})

it('buildWebSearchResult returns Cursor-compatible success shape', () => {
  const result = buildWebSearchResult({ searchTerm: 'cursor byok' })
  expect(result.result.case).toBe('success')
  const refs = result.result.value.references as Array<Record<string, unknown>>
  expect(refs.length).toBe(1)
  expect(refs[0]?.url).toBe('https://example.com/mock-web-search')
  expect(String(refs[0]?.chunk)).toMatch(/cursor byok/)
})

it('buildWebFetchResult returns Cursor-compatible success shape', () => {
  const result = buildWebFetchResult({ url: 'https://example.com/x' })
  expect(result.result.case).toBe('success')
  expect(result.result.value.url).toBe('https://example.com/x')
  expect(String(result.result.value.markdown)).toMatch(/Mock Web Fetch Response/)
})

it('normalizeToolResult preserves shell failure semantics and error classification', () => {
  const toolResult: ToolResultEnvelope = normalizeToolResult('shellToolCall', {
    result: {
      case: 'failure',
      value: {
        command: 'grep foo missing.txt',
        workingDirectory: '/workspace',
        stdout: '',
        stderr: 'No such file',
        output: 'No such file',
        exitCode: 2,
      },
    },
  }, {
    command: 'grep foo missing.txt',
    workingDirectory: '/workspace',
  })

  expect(toolResult.result.case).toBe('failure')
  expect(toolResult.result.value.exitCode).toBe(2)
  expect(isToolResultError(toolResult)).toBe(true)
  expect(buildToolResultText('shellToolCall', toolResult, { command: 'grep foo missing.txt' })).toMatch(/exit_code: 2/)
})

it('buildExecArgs for readLintsToolCall uses first path from paths[]', () => {
  const args = buildExecArgs('ReadLints', {
    paths: ['/tmp/a.ts', '/tmp/b.ts'],
  }, 'call-2')

  expect(args.path).toBe('/tmp/a.ts')
  expect(args.toolCallId).toBe('call-2')
})

it('task tool exec args match official subagent launch fields (方案 A: LLM 传入的 model 被忽略, 强制继承 currentModelId)', () => {
  // 输入里故意塞一个 "composer-2-fast" 模拟 LLM 被原 schema 描述诱导的行为。
  // 方案 A 下 buildExecArgs 应当完全忽略这个字段, 改用 options.currentModelId。
  const args = buildExecArgs('Task', {
    description: 'Find python script',
    prompt: 'Please find the name of the Python script that captures Claude status in this repository. Return just the filename.',
    subagentType: 'explore',
    model: 'composer-2-fast',
  }, 'call-task', {
    conversationId: 'conv-parent',
    currentModelId: 'claude-sonnet-4',
  })

  expect(args.toolCallId).toBe('call-task')
  expect(args.subagentType).toBe('explore')
  expect(args.modelId).toBe('claude-sonnet-4')
  expect(args.prompt).toBe('Please find the name of the Python script that captures Claude status in this repository. Return just the filename.')
  expect(args.readonly).toBe(true)
  expect(args.parentConversationId).toBe('conv-parent')
})

it('task tool exec args fall back to current run model when subagent model is unspecified', () => {
  const args = buildExecArgs('Task', {
    description: 'Find python script',
    prompt: 'Find the Python script filename.',
    subagentType: 'explore',
  }, 'call-task-fallback', {
    conversationId: 'conv-parent',
    currentModelId: 'claude-sonnet-4',
  })

  expect(args.modelId).toBe('claude-sonnet-4')
  expect(args.parentConversationId).toBe('conv-parent')
})

it('task tool result maps subagent success into official task success shape', () => {
  const result = normalizeToolResult('taskToolCall', buildExecToolResult('taskToolCall', {
    subagentResult: {
      success: {
        agentId: 'subagent-1',
        finalMessage: 'capture_claude_status.py',
        toolCallCount: 1,
        durationMs: '10101',
      },
    },
  }, {
    description: 'Find python script',
    prompt: 'Find the Claude status script',
    subagentType: 'explore',
  }), {
    description: 'Find python script',
    prompt: 'Find the Claude status script',
    subagentType: 'explore',
  })

  expect(result.result.case).toBe('success')
  const value = result.result.value
  const steps = value.conversationSteps as Array<Record<string, unknown>>
  const firstMessage = steps[0]?.message as { case: string, value: Record<string, unknown> }
  expect(firstMessage?.case).toBe('assistantMessage')
  expect(firstMessage?.value?.text).toBe('capture_claude_status.py')
  expect(value.agentId).toBe('subagent-1')
  expect(value.durationMs).toBe(10101n)
})

it('normalizeToolResult keeps updateTodos status values so Cursor can diff progress', () => {
  const normalized = normalizeToolResult('updateTodosToolCall', {
    result: {
      case: 'success',
      value: {
        todos: [
          { id: '1', content: 'todo 1', status: 2 },
          { id: '2', content: 'todo 2', status: 'TODO_STATUS_COMPLETED' },
        ],
        totalCount: 2,
        wasMerge: false,
      },
    },
  }, {})

  expect(normalized.result.case).toBe('success')
  const todos = normalized.result.value.todos as Array<Record<string, unknown>>
  expect(todos[0]?.status).toBe(2)
  expect(todos[1]?.status).toBe('TODO_STATUS_COMPLETED')
})

it('task tool args serialize subagentType as official oneof shape', () => {
  const frame = toolCallStarted('call-task-json', 'taskToolCall', {
    description: 'd',
    prompt: 'p',
    subagentType: { type: { case: 'shell', value: {} } },
    model: 'qwen3.5-plus',
  }, 'model-1')
  const json = toJsonString(AgentServerMessageSchema, frame)
  expect(json).toMatch(/"subagentType":\{"shell":\{\}\}/)
})

it('task tool completed result serializes conversationSteps assistantMessage text', () => {
  const frame = toolCallCompleted('call-task-json', 'taskToolCall', {
    description: 'd',
    prompt: 'p',
    subagentType: { type: { case: 'shell', value: {} } },
    model: 'qwen3.5-plus',
  }, {
    result: {
      case: 'success',
      value: {
        conversationSteps: [{ message: { case: 'assistantMessage', value: { text: 'hello from subagent' } } }],
        agentId: 'subagent-1',
      },
    },
  }, 'model-1')
  const json = toJsonString(AgentServerMessageSchema, frame)
  expect(json).toMatch(/"assistantMessage":\{"text":"hello from subagent"\}/)
})
