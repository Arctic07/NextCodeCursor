import type Anthropic from '@anthropic-ai/sdk'
import type { LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { assertValidAnthropicToolUseContract } from '../handlers/llm/anthropicContract'
import { anthropicStateStrategy } from '../handlers/llm/stateStrategy'

it('accepts tool_result-first combined user message after tool_use', () => {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先查一下。' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.md' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
        { type: 'text', text: '继续' },
      ],
    },
  ]

  expect(() => assertValidAnthropicToolUseContract(messages)).not.toThrow()
})

it('rejects assistant text after tool_use', () => {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.md' } },
        { type: 'text', text: '这段文本不应出现在 tool_use 后' },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
    },
  ]

  expect(() => assertValidAnthropicToolUseContract(messages)).toThrow(/contains text after tool_use/)
})

it('rejects non-tool_result content appearing before a required tool_result prefix', () => {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.md' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '我先说一句话' },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
      ],
    },
  ]

  expect(() => assertValidAnthropicToolUseContract(messages)).toThrow(/contains tool_result after non-tool_result content/)
})

it('rejects out-of-order tool_result prefix in next user message', () => {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-A', name: 'Read', input: { path: 'a.md' } },
        { type: 'tool_use', id: 'tool-B', name: 'Grep', input: { path: '.' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-B', content: 'grep ok' },
        { type: 'tool_result', tool_use_id: 'tool-A', content: 'read ok' },
      ],
    },
  ]

  expect(() => assertValidAnthropicToolUseContract(messages)).toThrow(/tool_result order mismatch/)
})

it('accepts multiple tool_results followed by user text when the tool_result prefix matches tool_use order', () => {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '先跑两个工具。' },
        { type: 'tool_use', id: 'tool-A', name: 'Read', input: { path: 'a.md' } },
        { type: 'tool_use', id: 'tool-B', name: 'Grep', input: { path: '.' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-A', content: 'read ok' },
        { type: 'tool_result', tool_use_id: 'tool-B', content: 'grep ok' },
        { type: 'text', text: '继续分析这些结果' },
      ],
    },
  ]

  expect(() => assertValidAnthropicToolUseContract(messages)).not.toThrow()
})

it('anthropic state strategy reorders pending tool_results to match prior tool_use order', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '先跑两个工具。' },
        { type: 'tool_use', id: 'tool-A', name: 'Read', input: { path: 'a.md' } },
        { type: 'tool_use', id: 'tool-B', name: 'Grep', input: { path: '.' } },
      ],
    },
  ]
  const pending: LLMToolResultBlock[] = [
    anthropicStateStrategy.createToolResult({
      toolCallId: 'tool-B',
      toolName: 'Grep',
      content: 'grep ok',
      isError: false,
    }),
    anthropicStateStrategy.createToolResult({
      toolCallId: 'tool-A',
      toolName: 'Read',
      content: 'read ok',
      isError: false,
    }),
  ]

  anthropicStateStrategy.flushToolResults(messages, pending)

  expect(pending).toEqual([])
  expect(messages[1]).toEqual({
    role: 'user',
    content: [
      { type: 'tool_result', toolUseId: 'tool-A', toolName: 'Read', content: 'read ok' },
      { type: 'tool_result', toolUseId: 'tool-B', toolName: 'Grep', content: 'grep ok' },
    ],
  })
})
