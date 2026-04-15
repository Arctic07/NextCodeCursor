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
 * 当前 Cursor++ 路径下，AnthropicStateStrategy.flushToolResults() 只会把 pendingToolResults
 * 作为一个纯 tool_result user message 推入 messages，不会在 flush 阶段和 user text 混合。
 */

function makeToolResult(toolUseId: string, toolName: string, content: string): LLMToolResultBlock {
  return anthropicStateStrategy.createToolResult({
    toolCallId: toolUseId,
    toolName,
    content,
    isError: false,
  })
}

it('current anthropic flush path emits a pure user tool_result message without mixing text blocks', () => {
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
  expect(messages[1]?.role).toBe('user')
  expect(Array.isArray(messages[1]?.content)).toBe(true)
  const content = messages[1]?.content as LLMToolResultBlock[]
  expect(content.every(block => block.type === 'tool_result')).toBe(true)
  expect(content.map(block => block.toolUseId)).toEqual(['tool-1'])
})

it('current anthropic flush path preserves insertion order of pendingToolResults', () => {
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

  const content = messages[1]?.content as LLMToolResultBlock[]
  expect(content.map(block => block.toolUseId)).toEqual(['tool-1', 'tool-2'])
})

it('current flush strategy itself does not reproduce Vercel-style mixed user text + tool_result ordering issue', () => {
  const messages: LLMMessage[] = []
  const pending: LLMToolResultBlock[] = [
    makeToolResult('tool-1', 'Read', 'read result'),
    makeToolResult('tool-2', 'Grep', 'grep result'),
  ]

  anthropicStateStrategy.flushToolResults(messages, pending)

  expect(messages).toEqual([
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'tool-1', toolName: 'Read', content: 'read result' },
        { type: 'tool_result', toolUseId: 'tool-2', toolName: 'Grep', content: 'grep result' },
      ],
    },
  ])
})
