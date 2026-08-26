import type { LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { anthropicStateStrategy } from '../handlers/llm/stateStrategy'

/**
 * 这个测试文件的目的：
 * 把当前 Cursor++ Anthropic 路径，与 Roo/Vercel 两类修复点区分开。
 *
 * - Vercel #8474 关注：同一个 user message 内，tool_result 与 user text 混合时，
 *   tool_result 必须排在前面。
 * - Roo #11806 关注：多个 tool_result 可能按“完成顺序”而不是“tool_use 顺序”进入同一条 user message。
 *
 * 当前 Cursor++ 路径已切到 canonical transcript：flush 阶段先写 role=tool，
 * Anthropic 专属的 user.tool_result[] 聚合延后到 transformMessages(..., 'anthropic') 编译时进行。
 */

function makeToolResult(toolUseId: string, toolName: string, content: string): LLMToolResultBlock {
  return anthropicStateStrategy.createToolResult({
    toolCallId: toolUseId,
    toolName,
    content,
    isError: false,
  })
}

it('current anthropic flush path emits canonical tool-role messages rather than mixed user blocks', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.md' } },
      ],
    },
  ]
  const pending: LLMToolResultBlock[] = [
    makeToolResult('tool-1', 'Read', 'file body'),
  ]

  anthropicStateStrategy.flushToolResults(messages, pending)

  expect(messages).toHaveLength(2)
  expect(messages[1]).toEqual({
    role: 'tool',
    toolCallId: 'tool-1',
    toolName: 'Read',
    content: 'file body',
  })
})

it('current anthropic flush path preserves insertion order of canonical tool-role messages', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.md' } },
        { type: 'tool_use', id: 'tool-2', name: 'Grep', input: { pattern: 'x', path: '.' } },
      ],
    },
  ]
  const pending: LLMToolResultBlock[] = [
    makeToolResult('tool-1', 'Read', 'read result'),
    makeToolResult('tool-2', 'Grep', 'grep result'),
  ]

  anthropicStateStrategy.flushToolResults(messages, pending)

  expect(messages.slice(1).map(message => message.toolCallId)).toEqual(['tool-1', 'tool-2'])
})

it('current flush strategy itself does not reproduce Vercel-style mixed user text + tool_result ordering issue', () => {
  const messages: LLMMessage[] = []
  const pending: LLMToolResultBlock[] = [
    makeToolResult('tool-1', 'Read', 'read result'),
    makeToolResult('tool-2', 'Grep', 'grep result'),
  ]

  anthropicStateStrategy.flushToolResults(messages, pending)

  expect(messages).toEqual([
    { role: 'tool', toolCallId: 'tool-1', toolName: 'Read', content: 'read result' },
    { role: 'tool', toolCallId: 'tool-2', toolName: 'Grep', content: 'grep result' },
  ])
})
