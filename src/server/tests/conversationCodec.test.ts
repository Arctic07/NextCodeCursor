import type { LLMContentBlock } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { llmMessageToBlobMessage, normalizeBlobMessage, restoreBlobMessageToLLMMessage } from '../handlers/agent/transcript'
import {
  encodeAnthropicRequestMessages,
  encodeGeminiRequestMessages,
  openAIChatConversationCodec,
} from '../handlers/llm/conversationCodec'
import { normalizeStoredTranscript } from '../handlers/llm/semanticConversation'

it('transcript normalization preserves tool-result toolName and error flags', () => {
  const normalized = normalizeBlobMessage({
    role: 'user',
    content: [{
      type: 'tool_result',
      toolUseId: 'call-blob',
      toolName: 'grep_search',
      content: 'grep output',
      isError: true,
    }],
  })

  const restored = restoreBlobMessageToLLMMessage(normalized as unknown as Record<string, unknown>)
  expect(restored).toBeTruthy()
  expect(Array.isArray(restored?.content)).toBeTruthy()
  const block = restored?.content[0] as { toolName: string, isError: boolean }
  expect(block.toolName).toBe('grep_search')
  expect(block.isError).toBe(true)
})

it('stored transcript normalization keeps reasoning signatures and semantic tool batches', () => {
  const blob = normalizeBlobMessage(llmMessageToBlobMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'reason', signature: 'sig-1', providerOptions: { cursor: { modelName: 'gpt-5.4-medium' } } },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'call-1', name: 'ReadFile', input: { path: 'a.ts' } },
    ],
  }))

  const restored = restoreBlobMessageToLLMMessage(blob as unknown as Record<string, unknown>)
  expect(restored).toBeTruthy()
  const turns = normalizeStoredTranscript([blob])
  expect(turns.length).toBe(1)
  expect(turns[0]?.kind).toBe('assistant')
  if (turns[0]?.kind !== 'assistant')
    throw new Error('expected assistant turn')
  expect(turns[0].reasoningBlocks[0]?.signature).toBe('sig-1')
  expect(turns[0].toolCalls[0]?.toolName).toBe('ReadFile')
})

it('gemini provider encodes tool response with tool name for functionResponse replay', () => {
  const encoded = encodeGeminiRequestMessages([
    {
      role: 'tool',
      content: 'tool ok',
      toolCallId: 'call-g1',
      toolName: 'web_search',
      isError: false,
    },
  ])

  const content = encoded.contents[0]
  expect(content?.role).toBe('user')
  const functionResponse = content?.parts?.[0]?.functionResponse as { name: string, response: Record<string, unknown> }
  expect(functionResponse.name).toBe('web_search')
  expect(functionResponse.response.toolUseId).toBe('call-g1')
  expect(functionResponse.response.content).toBe('tool ok')
})

it('openai conversation codec collapses user/tool messages and strips assistant thinking blocks', () => {
  const normalized = openAIChatConversationCodec.normalizeMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: '<open_files>ctx</open_files>' },
        { type: 'text', text: '<user_query>hi</user_query>' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'hidden thought', signature: 'sig-x' },
        { type: 'text', text: 'visible text' },
        { type: 'tool_use', id: 'call-1', name: 'ReadFile', input: { path: 'a.ts' } },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool_result', toolUseId: 'call-1', toolName: 'ReadFile', content: 'file body' },
      ],
      toolCallId: 'call-1',
      toolName: 'ReadFile',
    },
  ])

  expect(normalized.length).toBe(3)
  expect(typeof normalized[0]?.content).toBe('string')
  expect(String(normalized[0]?.content)).toMatch(/<user_query>hi<\/user_query>/)
  expect(Array.isArray(normalized[1]?.content)).toBeTruthy()
  const assistantBlocks = normalized[1]?.content as LLMContentBlock[]
  expect(assistantBlocks.some(block => block.type === 'thinking')).toBe(false)
  expect(assistantBlocks.some(block => block.type === 'tool_use')).toBe(true)
  expect(normalized[2]?.role).toBe('tool')
  expect(typeof normalized[2]?.content).toBe('string')
  expect(String(normalized[2]?.content)).toMatch(/file body/)
})

it('openai conversation codec normalizes stored transcript through provider-specific semantic pipeline', () => {
  const turns = openAIChatConversationCodec.normalizeStoredTranscript([
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'hidden thought', signature: 'sig-1' },
        { type: 'text', text: 'visible text' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'ReadFile', args: { path: 'a.ts' } },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'call-1', toolName: 'ReadFile', result: 'first result' },
        { type: 'tool-result', toolCallId: 'call-2', toolName: 'Grep', result: 'second result' },
      ],
    },
  ])

  expect(turns.length).toBe(3)
  expect(turns[0]?.kind).toBe('assistant')
  if (turns[0]?.kind !== 'assistant')
    throw new Error('expected assistant turn')
  expect(turns[0].reasoningBlocks.length).toBe(0)
  expect(turns[0].textBlocks[0]).toBe('visible text')
  expect(turns[0].toolCalls[0]?.toolName).toBe('ReadFile')
  expect(turns[1]?.kind).toBe('tool_results')
  expect(turns[2]?.kind).toBe('tool_results')
})

it('anthropic request encoding keeps system text and tool error metadata', () => {
  const encoded = encodeAnthropicRequestMessages([
    { role: 'system', content: 'sys prompt' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'ReadFile', input: { path: 'a.ts' } }] },
    { role: 'tool', content: 'ENOENT', toolCallId: 'tool-1', toolName: 'ReadFile', isError: true },
  ])

  expect(encoded.system).toBe('sys prompt')
  expect(encoded.messages.length).toBe(2)
  const toolResultMessage = encoded.messages[1] as { content: Array<{ type: string, is_error?: boolean, tool_use_id?: string }> }
  expect(toolResultMessage.content[0]?.type).toBe('tool_result')
  expect(toolResultMessage.content[0]?.tool_use_id).toBe('tool-1')
  expect(toolResultMessage.content[0]?.is_error).toBe(true)
})

it('gemini request encoding separates system instruction from conversation contents', () => {
  const encoded = encodeGeminiRequestMessages([
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'tool output', toolCallId: 'tool-2', toolName: 'grep', isError: false },
  ])

  expect(encoded.systemInstruction).toBe('sys prompt')
  expect(encoded.contents.length).toBe(2)
  expect(encoded.contents[0]?.role).toBe('user')
  expect(encoded.contents[1]?.parts?.[0] ? 'functionResponse' in encoded.contents[1].parts[0] : false).toBe(true)
})
