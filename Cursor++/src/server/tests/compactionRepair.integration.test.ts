import type { HistoryEntry } from '../handlers/agent/historyManager'
import type { LLMContentBlock, LLMMessage } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { planCompaction } from '../handlers/agent/compactionStrategy'
import { repairHistoryEntries } from '../handlers/agent/historyManager'
import { repairConversationHistory } from '../handlers/llm/transformMessages'

function makeEntry(index: number, message: LLMMessage): HistoryEntry {
  return {
    blobId: `blob-${index}`,
    raw: { role: message.role, content: message.content as unknown },
    message,
  }
}

function hasToolUse(message: LLMMessage): boolean {
  return message.role === 'assistant'
    && typeof message.content !== 'string'
    && message.content.some((block: LLMContentBlock) => block.type === 'tool_use')
}

function buildLegacyCompactionEntries(): HistoryEntry[] {
  return [
    makeEntry(0, { role: 'system', content: 'sys prompt' }),
    makeEntry(1, { role: 'user', content: '<user_info>env</user_info>' }),
    makeEntry(2, { role: 'user', content: 'user-1' }),
    makeEntry(3, { role: 'assistant', content: 'assistant-1' }),
    makeEntry(4, { role: 'user', content: 'user-2' }),
    makeEntry(5, {
      role: 'assistant',
      content: [
        { type: 'text', text: '先查一下。' },
        { type: 'tool_use', id: 'call_A', name: 'Read', input: { path: 'a.ts' } },
      ],
    }),
    makeEntry(6, {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'call_A', toolName: 'Read', content: 'read result' },
      ],
    }),
    makeEntry(7, { role: 'assistant', content: 'assistant-tail' }),
  ]
}

function toEntries(messages: LLMMessage[]): HistoryEntry[] {
  return messages.map((message, index) => makeEntry(index, message))
}

it('diagnostic: summarize-path planCompaction can still split legacy anthropic assistant/tool_result boundary before repair', () => {
  const entries = buildLegacyCompactionEntries()
  const plan = planCompaction(entries)

  expect(plan.leading.map(entry => entry.message.role)).toEqual(['system', 'user'])
  expect(plan.summarizeEntries.at(-1)?.message.role).toBe('assistant')
  expect(hasToolUse(plan.summarizeEntries.at(-1)!.message)).toBe(true)
  expect(plan.keepTail[0]?.message.role).toBe('user')
  expect(Array.isArray(plan.keepTail[0]?.message.content)).toBe(true)
  expect(((plan.keepTail[0]?.message.content as LLMContentBlock[])[0] as Extract<LLMContentBlock, { type: 'tool_result' }>).type).toBe('tool_result')
})

it('after repairConversationHistory canonicalizes legacy anthropic tool results, planCompaction no longer splits the assistant/tool boundary', () => {
  const repairedMessages = repairConversationHistory(buildLegacyCompactionEntries().map(entry => entry.message))
  const repairedEntries = toEntries(repairedMessages)
  const plan = planCompaction(repairedEntries)

  expect(plan.leading.map(entry => entry.message.role)).toEqual(['system', 'user'])
  expect(plan.summarizeEntries.some(entry => hasToolUse(entry.message))).toBe(false)
  expect(plan.keepTail[0]?.message.role).toBe('user')
  expect(plan.keepTail[1]?.message.role).toBe('assistant')
  expect(hasToolUse(plan.keepTail[1]!.message)).toBe(true)
  expect(plan.keepTail[2]?.message.role).toBe('tool')
  expect(plan.keepTail[2]?.message.toolCallId).toBe('call_A')
})

it('runtime helper repairHistoryEntries materializes canonicalized entries before compaction planning', () => {
  const plan = planCompaction(repairHistoryEntries(buildLegacyCompactionEntries()))

  expect(plan.keepTail[1]?.message.role).toBe('assistant')
  expect(hasToolUse(plan.keepTail[1]!.message)).toBe(true)
  expect(plan.keepTail[2]?.message.role).toBe('tool')
  expect(plan.keepTail[2]?.message.toolCallId).toBe('call_A')
})
