import type { LLMContentBlock, LLMStreamEvent } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { encodeAnthropicRequestMessages } from '../handlers/llm/conversationCodec'

interface ObservedRoundState {
  pendingToolCalls: Array<{ callId: string, name: string, input: Record<string, unknown> }>
  inflightToolCalls: Map<string, { name: string, input: string }>
  roundAssistantBlocks: LLMContentBlock[]
  currentThinking: string
  currentText: string
}

/**
 * 纯测试内复刻当前 conversationRuntime.ts 的事件累积逻辑，
 * 用来验证当前修复后的 assistant block 顺序。
 */
function flushPendingAssistantPrefix(state: ObservedRoundState): void {
  if (state.currentThinking) {
    state.roundAssistantBlocks.push({ type: 'thinking', text: state.currentThinking })
    state.currentThinking = ''
  }

  if (state.currentText) {
    state.roundAssistantBlocks.push({ type: 'text', text: state.currentText })
    state.currentText = ''
  }
}

function replayAssistantRound(events: LLMStreamEvent[]): ObservedRoundState {
  const state: ObservedRoundState = {
    pendingToolCalls: [],
    inflightToolCalls: new Map<string, { name: string, input: string }>(),
    roundAssistantBlocks: [],
    currentThinking: '',
    currentText: '',
  }

  for (const event of events) {
    switch (event.type) {
      case 'thinking_delta':
        state.currentThinking += event.text
        break
      case 'thinking_done':
        if (state.currentThinking) {
          state.roundAssistantBlocks.push({ type: 'thinking', text: state.currentThinking })
          state.currentThinking = ''
        }
        break
      case 'text_delta':
        state.currentText += event.text
        break
      case 'tool_use_start':
        flushPendingAssistantPrefix(state)
        state.inflightToolCalls.set(event.id, { name: event.name, input: '' })
        break
      case 'tool_use_delta': {
        const current = state.inflightToolCalls.get(event.id) ?? { name: '', input: '' }
        state.inflightToolCalls.set(event.id, { ...current, input: current.input + event.input })
        break
      }
      case 'tool_use_done': {
        const current = state.inflightToolCalls.get(event.id)
        if (current) {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(current.input)
          }
          catch {}
          state.pendingToolCalls.push({ callId: event.id, name: current.name, input })
          state.roundAssistantBlocks.push({ type: 'tool_use', id: event.id, name: current.name, input })
          state.inflightToolCalls.delete(event.id)
        }
        break
      }
      case 'done':
        flushPendingAssistantPrefix(state)
        break
      default:
        break
    }
  }

  return state
}

function buildRoundSixLikeEvents(): LLMStreamEvent[] {
  return [
    { type: 'text_delta', text: '让我' },
    { type: 'text_delta', text: '检查是否有类似 program.md 的文档或者查看你' },
    { type: 'text_delta', text: '提到的上下文。' },
    { type: 'tool_use_start', id: 'toolu_grep', name: 'Grep' },
    { type: 'tool_use_delta', id: 'toolu_grep', input: '{"pattern":"gpu3|GPU.?3"' },
    { type: 'tool_use_delta', id: 'toolu_grep', input: ',"path":"d:\\NIPS2026"}' },
    { type: 'tool_use_done', id: 'toolu_grep' },
    { type: 'tool_use_start', id: 'toolu_read', name: 'Read' },
    { type: 'tool_use_delta', id: 'toolu_read', input: '{"path":"d:\\NIPS2026\\architecture-upgrade\\ARCHITECTURE_UPGRADE_PLAN.md"}' },
    { type: 'tool_use_done', id: 'toolu_read' },
    {
      type: 'done',
      stopReason: 'tool_use',
      usage: { inputTokens: 37712, outputTokens: 184 },
    },
  ]
}

it('preserves assistant text before tool_use when text precedes tool_use in one anthropic turn', () => {
  const state = replayAssistantRound(buildRoundSixLikeEvents())

  expect(state.pendingToolCalls.map(call => call.name)).toEqual(['Grep', 'Read'])
  expect(state.roundAssistantBlocks.map(block => block.type)).toEqual(['text', 'tool_use', 'tool_use'])

  const encoded = encodeAnthropicRequestMessages([
    { role: 'assistant', content: state.roundAssistantBlocks },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'toolu_grep', toolName: 'Grep', content: 'grep output' },
        { type: 'tool_result', toolUseId: 'toolu_read', toolName: 'Read', content: 'read output' },
      ],
    },
  ])

  const assistantBlocks = (encoded.messages[0] as { content: Array<{ type: string }> }).content
  const toolResultBlocks = (encoded.messages[1] as { content: Array<{ type: string }> }).content

  expect(assistantBlocks.map(block => block.type)).toEqual(['text', 'tool_use', 'tool_use'])
  expect(toolResultBlocks.map(block => block.type)).toEqual(['tool_result', 'tool_result'])
})

it('keeps pre-tool text ahead of tool_use blocks after the ordering fix', () => {
  const state = replayAssistantRound(buildRoundSixLikeEvents())

  const textBlock = state.roundAssistantBlocks.find(block => block.type === 'text') as Extract<LLMContentBlock, { type: 'text' }> | undefined
  expect(textBlock?.text).toBe('让我检查是否有类似 program.md 的文档或者查看你提到的上下文。')
  expect(state.roundAssistantBlocks.map(block => block.type)).toEqual(['text', 'tool_use', 'tool_use'])
  expect(state.roundAssistantBlocks.map(block => block.type)).not.toEqual(['tool_use', 'tool_use', 'text'])
})
