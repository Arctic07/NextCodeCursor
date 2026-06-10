import type { LLMMessage } from '../handlers/llm/types'
import { describe, expect, it } from 'vitest'
import {
  normalizeToolCallIdForAnthropic,
  normalizeToolCallIdForOpenAIChat,
  normalizeToolCallIdForOpenAIResponses,
  repairConversationHistory,
  shortHash,
  transformMessages,
} from '../handlers/llm/transformMessages'

describe('shortHash', () => {
  it('产生确定性结果', () => {
    expect(shortHash('hello')).toBe(shortHash('hello'))
  })

  it('不同输入产生不同哈希', () => {
    expect(shortHash('hello')).not.toBe(shortHash('world'))
  })

  it('输出为短字符串', () => {
    const h = shortHash('a very long string that would be problematic as an ID')
    expect(h.length).toBeLessThan(20)
  })
})

describe('normalizeToolCallId', () => {
  it('anthropic: 保留合法字符, 截断到64', () => {
    expect(normalizeToolCallIdForAnthropic('toolu_abc123')).toBe('toolu_abc123')
    expect(normalizeToolCallIdForAnthropic('call|special+chars/here=now')).toBe('call_special_chars_here_now')
    const long = 'a'.repeat(100)
    expect(normalizeToolCallIdForAnthropic(long).length).toBe(64)
  })

  it('openAI Chat: 同 Anthropic 规则', () => {
    expect(normalizeToolCallIdForOpenAIChat('toolu_abc')).toBe('toolu_abc')
    expect(normalizeToolCallIdForOpenAIChat('id|with|pipes')).toBe('id_with_pipes')
  })

  it('openAI Responses: 不含 pipe 时标准化', () => {
    expect(normalizeToolCallIdForOpenAIResponses('toolu_abc')).toBe('toolu_abc')
  })

  it('openAI Responses: 含 pipe 时分离 callId|itemId, itemId 用 fc_ 哈希', () => {
    const result = normalizeToolCallIdForOpenAIResponses('call_123|item_very_long_id')
    expect(result).toContain('|')
    expect(result.split('|')[0]).toBe('call_123')
    expect(result.split('|')[1]).toMatch(/^fc_/)
  })
})

describe('transformMessages — ID 标准化', () => {
  it('anthropic→OpenAI: tool_use ID 被标准化', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me read the file.' },
        { type: 'tool_use', id: 'toolu_abc123', name: 'Read', input: { path: '/foo' } },
      ] },
      { role: 'tool', toolCallId: 'toolu_abc123', content: 'file contents' },
    ]
    const result = transformMessages(messages, 'openai-responses')
    const assistant = result[0]
    const tool = result[1]
    const toolUse = (assistant.content as any[]).find((b: any) => b.type === 'tool_use')
    expect(toolUse.id).toBe('toolu_abc123') // 合法字符不变
    expect(tool.toolCallId).toBe('toolu_abc123')
  })

  it('openAI→Anthropic: 特殊字符 ID 被标准化', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'call_abc|fc_item+special=chars', name: 'Read', input: {} },
      ] },
      { role: 'tool', toolCallId: 'call_abc|fc_item+special=chars', content: 'ok' },
    ]
    const result = transformMessages(messages, 'anthropic')
    const toolUse = (result[0].content as any[]).find((b: any) => b.type === 'tool_use')
    const toolResultMessage = result[1]
    // Anthropic 不允许 | + = 字符
    expect(toolUse.id).not.toContain('|')
    expect(toolUse.id).not.toContain('+')
    expect(toolUse.id).not.toContain('=')
    // Anthropic 编译后 tool result 聚合进单条 user message
    expect(toolResultMessage.role).toBe('user')
    expect((toolResultMessage.content as any[])[0].toolUseId).toBe(toolUse.id)
  })

  it('iD 映射在 assistant 和 tool result 之间保持一致', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'weird|id|with|pipes', name: 'Glob', input: {} },
        { type: 'tool_use', id: 'normal_id', name: 'Read', input: {} },
      ] },
      { role: 'tool', toolCallId: 'weird|id|with|pipes', content: 'result1' },
      { role: 'tool', toolCallId: 'normal_id', content: 'result2' },
    ]
    const result = transformMessages(messages, 'anthropic')
    const blocks = result[0].content as any[]
    const tu1 = blocks.find((b: any) => b.name === 'Glob')
    const tu2 = blocks.find((b: any) => b.name === 'Read')
    expect((result[1].content as any[])[0].toolUseId).toBe(tu1.id)
    expect((result[1].content as any[])[1].toolUseId).toBe(tu2.id)
  })
})

describe('transformMessages — 孤立 tool call 补全', () => {
  it('孤立的 tool_use 得到合成中断 result', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'call_1', name: 'Shell', input: { command: 'ls' } },
      ] },
      // 没有对应的 tool result — 对话被中断
      { role: 'user', content: '继续' },
    ]
    const result = transformMessages(messages, 'openai-responses')
    // 应该在 user 之前插入合成的 tool result
    expect(result.length).toBe(3) // assistant + synthetic tool + user
    expect(result[1].role).toBe('tool')
    expect(result[1].toolCallId).toBe('call_1')
    // isError:false + 引导文案 "do not retry" — 避免 LLM 把中断当失败而反复重试
    expect(result[1].isError).toBe(false)
    expect(result[1].content).toMatch(/interrupted/i)
  })

  it('有 result 的 tool_use 不会被重复补全', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'call_2', name: 'Glob', input: {} },
      ] },
      { role: 'tool', toolCallId: 'call_1', content: 'file content' },
      { role: 'tool', toolCallId: 'call_2', content: 'glob result' },
    ]
    const result = transformMessages(messages, 'openai-chat')
    expect(result.length).toBe(3) // 不变
    expect(result.filter(m => m.role === 'tool').length).toBe(2)
  })

  it('部分缺失: 只补全缺失的', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'call_2', name: 'Glob', input: {} },
      ] },
      { role: 'tool', toolCallId: 'call_1', content: 'ok' },
      // call_2 缺失
      { role: 'user', content: '继续' },
    ]
    const result = transformMessages(messages, 'openai-responses')
    const toolResults = result.filter(m => m.role === 'tool')
    expect(toolResults.length).toBe(2) // call_1 真实 + call_2 合成
    const synthetic = toolResults.find(m => m.toolCallId === 'call_2')
    expect(synthetic).toBeDefined()
    // 合成的中断 result 用 isError:false (见 createSyntheticToolResult)
    expect(synthetic!.isError).toBe(false)
    expect(synthetic!.content).toMatch(/interrupted/i)
  })

  it('连续多个 assistant 都有孤立 tool call', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'call_a', name: 'Read', input: {} },
      ] },
      // call_a 缺失 result
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'call_b', name: 'Glob', input: {} },
      ] },
      // call_b 也缺失
      { role: 'user', content: '?' },
    ]
    const result = transformMessages(messages, 'openai-chat')
    const toolResults = result.filter(m => m.role === 'tool')
    expect(toolResults.length).toBe(2) // 两个合成
    expect(toolResults[0].toolCallId).toBe('call_a')
    expect(toolResults[1].toolCallId).toBe('call_b')
  })
})

describe('transformMessages — thinking 降级', () => {
  it('openai-chat 降级 thinking 为 text', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'thinking', text: 'I should read the file.', signature: 'encrypted_sig_data' },
        { type: 'text', text: 'Let me check.' },
      ] },
    ]
    const result = transformMessages(messages, 'openai-chat')
    const blocks = result[0].content as any[]
    expect(blocks.every((b: any) => b.type === 'text')).toBe(true)
    expect(blocks[0].text).toBe('I should read the file.')
    expect(blocks[1].text).toBe('Let me check.')
  })

  it('openai-responses 同模型保留 thinking 块', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'thinking', text: 'I should read the file.', signature: 'encrypted_sig_data', sourceModel: 'openai-responses:gpt-5.4' },
        { type: 'text', text: 'Let me check.' },
      ] },
    ]
    const result = transformMessages(messages, 'openai-responses', undefined, 'gpt-5.4')
    const blocks = result[0].content as any[]
    expect(blocks[0].type).toBe('thinking')
    expect(blocks[0].signature).toBe('encrypted_sig_data')
  })

  it('openai-responses 跨模型降级 thinking', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'thinking', text: 'I should read the file.', signature: 'sig', sourceModel: 'anthropic:claude-4.6-sonnet' },
        { type: 'text', text: 'Let me check.' },
      ] },
    ]
    const result = transformMessages(messages, 'openai-responses', undefined, 'gpt-5.4')
    const blocks = result[0].content as any[]
    expect(blocks[0].type).toBe('text')
  })

  it('空 thinking 同 model 保留（DeepSeek 要求空 reasoning_content 回传）', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'thinking', text: '', sourceModel: 'anthropic:deepseek-v4-pro' },
        { type: 'text', text: 'Hello' },
      ] },
    ]
    const result = transformMessages(messages, 'anthropic', undefined, 'deepseek-v4-pro')
    const blocks = result[0].content as any[]
    expect(blocks.length).toBe(2)
    expect(blocks[0].type).toBe('thinking')
    expect(blocks[1].text).toBe('Hello')
  })

  it('空 thinking 跨 model 降级为 text', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'thinking', text: '', sourceModel: 'anthropic:deepseek-v4-pro' },
        { type: 'text', text: 'Hello' },
      ] },
    ]
    const result = transformMessages(messages, 'openai-chat', undefined, 'gpt-5.4')
    const blocks = result[0].content as any[]
    expect(blocks.length).toBe(1)
    expect(blocks[0].text).toBe('Hello')
  })

  it('anthropic/gemini 保留 thinking（含无 signature）', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'thinking', text: 'Reasoning here' },
        { type: 'text', text: 'Answer' },
      ] },
    ]
    const result = transformMessages(messages, 'anthropic')
    const blocks = result[0].content as any[]
    expect(blocks[0].type).toBe('thinking')
    expect(blocks[0].text).toBe('Reasoning here')
  })
})

describe('repairConversationHistory — legacy anthropic tool_result canonicalization', () => {
  it('将 user.tool_result[] 拆成 canonical tool messages，并保留 trailing user text', () => {
    const repaired = repairConversationHistory([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_a', name: 'Read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'call_b', name: 'Grep', input: { path: '.', pattern: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call_a', toolName: 'Read', content: 'read result' },
          { type: 'tool_result', toolUseId: 'call_b', toolName: 'Grep', content: 'grep result' },
          { type: 'text', text: '继续' },
        ],
      },
    ])

    expect(repaired).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_a', name: 'Read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'call_b', name: 'Grep', input: { path: '.', pattern: 'x' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_a', toolName: 'Read', content: 'read result' },
      { role: 'tool', toolCallId: 'call_b', toolName: 'Grep', content: 'grep result' },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ])
  })
})

describe('transformMessages — Anthropic tool_result 聚合', () => {
  it.each(['openai-chat', 'openai-responses', 'gemini'] as const)(
    '从 %s / canonical tool role 历史切到 anthropic 时，按 tool_use 顺序聚合为单条 user tool_result message',
    (_sourceProvider) => {
      const transformed = transformMessages([
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_A', name: 'Read', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 'call_B', name: 'Grep', input: { path: '.', pattern: 'x' } },
          ],
        },
        { role: 'tool', toolCallId: 'call_B', toolName: 'Grep', content: 'grep result' },
        { role: 'tool', toolCallId: 'call_A', toolName: 'Read', content: 'read result' },
        { role: 'user', content: '继续' },
      ], 'anthropic')

      expect(transformed).toEqual([
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_A', name: 'Read', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 'call_B', name: 'Grep', input: { path: '.', pattern: 'x' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'call_A', toolName: 'Read', content: 'read result' },
            { type: 'tool_result', toolUseId: 'call_B', toolName: 'Grep', content: 'grep result' },
          ],
        },
        { role: 'user', content: '继续' },
      ])
    },
  )
})

describe('transformMessages — 跨 provider 完整场景', () => {
  it('anthropic 对话接续 OpenAI Responses', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Read /tmp/test.txt' },
      // Anthropic 模型的 round 0
      { role: 'assistant', content: [
        { type: 'thinking', text: 'User wants to read a file.', signature: 'anthropic_sig', sourceModel: 'anthropic:claude-4.6-sonnet' },
        { type: 'tool_use', id: 'toolu_abc123def456', name: 'ReadFile', input: { path: '/tmp/test.txt' } },
      ] },
      { role: 'tool', toolCallId: 'toolu_abc123def456', content: 'Hello World' },
      // Anthropic 模型回复
      { role: 'assistant', content: [
        { type: 'text', text: 'The file contains: Hello World' },
      ] },
      // 用户切换到 OpenAI 继续
      { role: 'user', content: 'Now write to it' },
    ]

    const result = transformMessages(messages, 'openai-responses', undefined, 'gpt-5.4')

    // system 和 user 不变
    expect(result[0]).toEqual(messages[0])
    expect(result[1]).toEqual(messages[1])

    // 跨 provider (anthropic → openai-responses): thinking 降级为 text
    const assistantBlocks = result[2].content as any[]
    expect(assistantBlocks[0].type).toBe('text')
    expect(assistantBlocks[0].text).toBe('User wants to read a file.')

    // tool_use ID 保留 (合法字符)
    const toolUse = assistantBlocks.find((b: any) => b.type === 'tool_use')
    expect(toolUse.id).toBe('toolu_abc123def456')

    // tool result ID 同步
    expect(result[3].toolCallId).toBe('toolu_abc123def456')

    // 最终 user 消息在正确位置
    expect(result[result.length - 1].role).toBe('user')
    expect(result[result.length - 1].content).toBe('Now write to it')

    // 没有孤立的 tool call
    expect(result.filter(m => m.role === 'tool').length).toBe(1)
  })

  it('openAI 对话接续 Anthropic, 带 pipe 分隔 ID', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'call_xyz|fc_item_long_id_here', name: 'Shell', input: { command: 'echo hi' } },
      ] },
      { role: 'tool', toolCallId: 'call_xyz|fc_item_long_id_here', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done!' }] },
      { role: 'user', content: 'thanks' },
    ]

    const result = transformMessages(messages, 'anthropic')

    // Anthropic 不允许 pipe → ID 被标准化
    const toolUse = (result[1].content as any[]).find((b: any) => b.type === 'tool_use')
    expect(toolUse.id).not.toContain('|')
    expect((result[2].content as any[])[0].toolUseId).toBe(toolUse.id)
  })

  it('切到 anthropic 时会降级不属于 anthropic 的历史工具（如 ApplyPatch）', () => {
    const result = transformMessages([
      { role: 'user', content: 'edit this file' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_patch', name: 'ApplyPatch', input: { patch: '*** Update File: foo.ts\\n@@' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_patch', toolName: 'ApplyPatch', content: 'patched ok' },
      { role: 'user', content: '继续' },
    ], 'anthropic')

    expect(result).toEqual([
      { role: 'user', content: 'edit this file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '[previous unsupported tool call: ApplyPatch] {"patch":"*** Update File: foo.ts\\\\n@@"}' },
        ],
      },
      { role: 'user', content: '[Prior tool result: ApplyPatch]\npatched ok' },
      { role: 'user', content: '继续' },
    ])
  })

  it.each(['openai-chat', 'openai-responses', 'gemini'] as const)(
    'anthropic legacy user.tool_result 切到 %s 时应展开为 canonical tool role messages，而不是丢失',
    (targetProvider) => {
      const result = transformMessages([
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 'call_2', name: 'Grep', input: { path: '.', pattern: 'x' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'call_1', toolName: 'Read', content: 'read result' },
            { type: 'tool_result', toolUseId: 'call_2', toolName: 'Grep', content: 'grep result' },
            { type: 'text', text: '继续' },
          ],
        },
      ], targetProvider)

      expect(result).toEqual([
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 'call_2', name: 'Grep', input: { path: '.', pattern: 'x' } },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', toolName: 'Read', content: 'read result' },
        { role: 'tool', toolCallId: 'call_2', toolName: 'Grep', content: 'grep result' },
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ])
    },
  )
})
