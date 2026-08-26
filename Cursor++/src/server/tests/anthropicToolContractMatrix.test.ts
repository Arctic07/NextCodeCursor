import type { LLMContentBlock, LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { anthropicStateStrategy } from '../handlers/llm/stateStrategy'

/**
 * Anthropic tool-use contract matrix
 *
 * 目的：把当前排查中最关键的协议约束拆成更细的测试矩阵，
 * 用测试结果确认目前代码真正敏感的点，以及未来若改为并发工具执行时的风险面。
 */
function assertAnthropicToolContract(messages: LLMMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== 'assistant' || typeof message.content === 'string')
      continue

    const firstToolUseIndex = message.content.findIndex(block => block.type === 'tool_use')
    if (firstToolUseIndex < 0)
      continue

    const trailingBlocks = message.content.slice(firstToolUseIndex)
    const nonToolUseTrailingBlock = trailingBlocks.find(block => block.type !== 'tool_use')
    if (nonToolUseTrailingBlock) {
      throw new Error(
        `assistant message ${index} contains ${nonToolUseTrailingBlock.type} after tool_use`,
      )
    }

    const expectedToolUseIds = trailingBlocks
      .filter((block): block is Extract<LLMContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map(block => block.id)

    const nextMessage = messages[index + 1]
    if (!nextMessage)
      throw new Error(`assistant message ${index} with tool_use is missing the following user tool_result message`)

    if (nextMessage.role !== 'user')
      throw new Error(`assistant message ${index} with tool_use must be followed by a user message, got ${nextMessage.role}`)

    if (typeof nextMessage.content === 'string')
      throw new Error(`user message ${index + 1} after tool_use must be structured tool_result blocks, got plain string`)

    if (nextMessage.content.length === 0)
      throw new Error(`user message ${index + 1} after tool_use is empty`)

    const nonToolResult = nextMessage.content.find(block => block.type !== 'tool_result')
    if (nonToolResult)
      throw new Error(`user message ${index + 1} after tool_use contains ${nonToolResult.type} instead of only tool_result blocks`)

    const actualToolResultIds = nextMessage.content
      .filter((block): block is Extract<LLMContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
      .map(block => block.toolUseId)

    if (actualToolResultIds.length !== expectedToolUseIds.length) {
      throw new Error(
        `tool_result count mismatch after assistant message ${index}: expected ${expectedToolUseIds.length}, got ${actualToolResultIds.length}`,
      )
    }

    expect(actualToolResultIds).toEqual(expectedToolUseIds)
  }
}

function toolUse(id: string, name: string, input: Record<string, unknown>): Extract<LLMContentBlock, { type: 'tool_use' }> {
  return { type: 'tool_use', id, name, input }
}

function toolResult(toolUseId: string, toolName: string, content: string): Extract<LLMContentBlock, { type: 'tool_result' }> {
  return { type: 'tool_result', toolUseId, toolName, content }
}

function makePendingResult(toolUseId: string, toolName: string, content: string): LLMToolResultBlock {
  return anthropicStateStrategy.createToolResult({
    toolCallId: toolUseId,
    toolName,
    content,
    isError: false,
  })
}

it('allows assistant thinking/text before tool_use as long as trailing blocks stay tool_use-only', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: '先检查文档和日志' },
        { type: 'text', text: '我先查一下。' },
        toolUse('tool-A', 'Read', { path: 'a.md' }),
        toolUse('tool-B', 'Grep', { pattern: 'gpu3', path: '.' }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResult('tool-A', 'Read', 'read ok'),
        toolResult('tool-B', 'Grep', 'grep ok'),
      ],
    },
  ]

  expect(() => assertAnthropicToolContract(messages)).not.toThrow()
})

it('rejects assistant thinking after tool_use', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        toolUse('tool-A', 'Read', { path: 'a.md' }),
        { type: 'thinking', text: '我再想想' },
      ],
    },
    {
      role: 'user',
      content: [toolResult('tool-A', 'Read', 'read ok')],
    },
  ]

  expect(() => assertAnthropicToolContract(messages)).toThrow(/contains thinking after tool_use/)
})

it('rejects plain-string user message after assistant tool_use', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [toolUse('tool-A', 'Read', { path: 'a.md' })],
    },
    {
      role: 'user',
      content: 'tool finished',
    },
  ]

  expect(() => assertAnthropicToolContract(messages)).toThrow(/must be structured tool_result blocks, got plain string/)
})

it('rejects missing tool_result count for multi-tool assistant turn', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        toolUse('tool-A', 'Read', { path: 'a.md' }),
        toolUse('tool-B', 'Grep', { pattern: 'gpu3', path: '.' }),
      ],
    },
    {
      role: 'user',
      content: [toolResult('tool-A', 'Read', 'read ok')],
    },
  ]

  expect(() => assertAnthropicToolContract(messages)).toThrow(/tool_result count mismatch/)
})

it('anthropic flush reorders concurrent completion results back to assistant tool_use order', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        toolUse('tool-A', 'Read', { path: 'a.md' }),
        toolUse('tool-B', 'Grep', { pattern: 'gpu3', path: '.' }),
      ],
    },
  ]

  // 模拟未来并发执行：tool-B 先完成，再 tool-A 完成
  const pendingResults: LLMToolResultBlock[] = [
    makePendingResult('tool-B', 'Grep', 'grep ok'),
    makePendingResult('tool-A', 'Read', 'read ok'),
  ]

  anthropicStateStrategy.flushToolResults(messages, pendingResults)

  expect(messages.slice(1).map(message => message.toolCallId)).toEqual(['tool-A', 'tool-B'])
})
