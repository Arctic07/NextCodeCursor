import type { LLMContentBlock, LLMMessage } from '../handlers/llm/types'
import { expect, it } from 'vitest'

/**
 * 测试先行草案：本地定义一个 Anthropic tool adjacency 断言器，
 * 仅用于把“我们认为应该被检查的协议规则”固化成测试，不改生产源码。
 *
 * 规则草案：
 * 1. assistant 一旦开始输出 tool_use，当前 assistant message 后续 block 只能继续是 tool_use。
 *    - 允许 text/thinking 出现在 tool_use 之前
 *    - 不允许 text/thinking/tool_result 出现在 tool_use 之后
 * 2. 含 tool_use 的 assistant message，下一条 message 必须存在且 role === 'user'
 * 3. 下一条 user message 必须只包含 tool_result blocks
 * 4. 下一条 user message 的 tool_result.toolUseId 必须与上一条 assistant message 中的 tool_use.id 一一对应
 */
function assertAnthropicToolAdjacency(messages: LLMMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message?.role !== 'assistant' || typeof message.content === 'string')
      continue

    const blocks = message.content
    const firstToolUseIndex = blocks.findIndex(block => block.type === 'tool_use')
    if (firstToolUseIndex < 0)
      continue

    const trailingBlocks = blocks.slice(firstToolUseIndex)
    const nonToolUseTrailingBlock = trailingBlocks.find(block => block.type !== 'tool_use')
    if (nonToolUseTrailingBlock) {
      throw new Error(
        `assistant message ${index} contains non-tool block ${nonToolUseTrailingBlock.type} after tool_use; `
        + 'for Anthropic, once tool_use starts, remaining blocks in that assistant message should stay tool_use-only',
      )
    }

    const expectedToolUseIds = trailingBlocks
      .filter((block): block is Extract<LLMContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map(block => block.id)

    const nextMessage = messages[index + 1]
    if (!nextMessage) {
      throw new Error(`assistant message ${index} ends with tool_use but has no following user tool_result message`)
    }

    if (nextMessage.role !== 'user') {
      throw new Error(`assistant message ${index} with tool_use must be followed by a user message, got ${nextMessage.role}`)
    }

    if (typeof nextMessage.content === 'string') {
      throw new TypeError(`user message ${index + 1} following tool_use must contain structured tool_result blocks, got plain string`)
    }

    if (nextMessage.content.length === 0) {
      throw new Error(`user message ${index + 1} following tool_use is empty; expected tool_result blocks`)
    }

    const nonToolResultBlock = nextMessage.content.find(block => block.type !== 'tool_result')
    if (nonToolResultBlock) {
      throw new Error(
        `user message ${index + 1} following tool_use contains non-tool_result block ${nonToolResultBlock.type}`,
      )
    }

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

it('accepts assistant text before tool_use when next user message is pure matching tool_results', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '让我先检查一下。' },
        toolUse('toolu_grep', 'Grep', { pattern: 'gpu3|GPU.?3', path: 'd:\\NIPS2026' }),
        toolUse('toolu_read', 'Read', { path: 'd:\\NIPS2026\\architecture-upgrade\\ARCHITECTURE_UPGRADE_PLAN.md' }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResult('toolu_grep', 'Grep', 'grep output'),
        toolResult('toolu_read', 'Read', 'read output'),
      ],
    },
  ]

  expect(() => assertAnthropicToolAdjacency(messages)).not.toThrow()
})

it('flags the currently observed problematic ordering: text moved behind tool_use blocks', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        toolUse('toolu_grep', 'Grep', { pattern: 'gpu3|GPU.?3', path: 'd:\\NIPS2026' }),
        toolUse('toolu_read', 'Read', { path: 'd:\\NIPS2026\\architecture-upgrade\\ARCHITECTURE_UPGRADE_PLAN.md' }),
        { type: 'text', text: '让我检查是否有类似 program.md 的文档或者查看你提到的上下文。' },
      ],
    },
    {
      role: 'user',
      content: [
        toolResult('toolu_grep', 'Grep', 'grep output'),
        toolResult('toolu_read', 'Read', 'read output'),
      ],
    },
  ]

  expect(() => assertAnthropicToolAdjacency(messages)).toThrow(/non-tool block text after tool_use/)
})

it('flags missing next user tool_result message after assistant tool_use', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        toolUse('toolu_grep', 'Grep', { pattern: 'gpu3|GPU.?3', path: 'd:\\NIPS2026' }),
      ],
    },
  ]

  expect(() => assertAnthropicToolAdjacency(messages)).toThrow(/has no following user tool_result message/)
})

it('flags next message that is not a pure tool_result user message', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        toolUse('toolu_grep', 'Grep', { pattern: 'gpu3|GPU.?3', path: 'd:\\NIPS2026' }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResult('toolu_grep', 'Grep', 'grep output'),
        { type: 'text', text: '额外说明' },
      ],
    },
  ]

  expect(() => assertAnthropicToolAdjacency(messages)).toThrow(/contains non-tool_result block text/)
})

it('flags tool_result id mismatch against preceding tool_use ids', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        toolUse('toolu_grep', 'Grep', { pattern: 'gpu3|GPU.?3', path: 'd:\\NIPS2026' }),
        toolUse('toolu_read', 'Read', { path: 'd:\\NIPS2026\\architecture-upgrade\\ARCHITECTURE_UPGRADE_PLAN.md' }),
      ],
    },
    {
      role: 'user',
      content: [
        toolResult('toolu_grep', 'Grep', 'grep output'),
        toolResult('toolu_other', 'Read', 'read output'),
      ],
    },
  ]

  expect(() => assertAnthropicToolAdjacency(messages)).toThrow()
})
