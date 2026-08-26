import type { LLMContentBlock, LLMMessage, LLMStreamEvent } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { buildShellToolResult, isToolResultError } from '../handlers/agent/toolResults'

interface ObservedRoundState {
  pendingToolCalls: Array<{ callId: string, name: string, input: Record<string, unknown> }>
  inflightToolCalls: Map<string, { name: string, input: string }>
  roundAssistantBlocks: LLMContentBlock[]
  currentThinking: string
  currentText: string
}

/**
 * 复刻当前 conversationRuntime.ts 的 assistant block 累积行为，
 * 用日志里的 round-6 事件流来观察修复后代码会生成什么。
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

/**
 * 按 Anthropic 官方 tool-use contract 做本地校验：
 * assistant 一旦进入 tool_use，下一条 user message 应立即提供对应 tool_result，
 * 而 assistant message 内 tool_use 后不应再夹普通 text block。
 */
function assertAnthropicToolContract(messages: LLMMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== 'assistant' || typeof message.content === 'string')
      continue

    const firstToolUseIndex = message.content.findIndex(block => block.type === 'tool_use')
    if (firstToolUseIndex < 0)
      continue

    const trailing = message.content.slice(firstToolUseIndex)
    const nonToolUse = trailing.find(block => block.type !== 'tool_use')
    if (nonToolUse)
      throw new Error(`assistant message ${index} contains ${nonToolUse.type} after tool_use`)

    const expectedIds = trailing
      .filter((block): block is Extract<LLMContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map(block => block.id)

    const next = messages[index + 1]
    if (!next || next.role !== 'user' || typeof next.content === 'string')
      throw new Error(`assistant message ${index} with tool_use is not followed by structured user tool_result blocks`)

    const actualIds = next.content
      .filter((block): block is Extract<LLMContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
      .map(block => block.toolUseId)

    expect(actualIds).toEqual(expectedIds)
  }
}

function buildRoundSixLikeEvents(): LLMStreamEvent[] {
  return [
    { type: 'text_delta', text: '让我' },
    { type: 'text_delta', text: '检查是否有类似 program.md 的文档或者查看你' },
    { type: 'text_delta', text: '提到的上下文。' },
    { type: 'tool_use_start', id: 'toolu_01Jc7bGdLN6XGEZnoD4KBd7H', name: 'Grep' },
    { type: 'tool_use_delta', id: 'toolu_01Jc7bGdLN6XGEZnoD4KBd7H', input: '{"pattern":"gpu3|GPU.?3"' },
    { type: 'tool_use_delta', id: 'toolu_01Jc7bGdLN6XGEZnoD4KBd7H', input: ',"path":"d:\\NIPS2026"}' },
    { type: 'tool_use_done', id: 'toolu_01Jc7bGdLN6XGEZnoD4KBd7H' },
    { type: 'tool_use_start', id: 'toolu_015hRsyfHk8ecMX8VphtXJni', name: 'Read' },
    { type: 'tool_use_delta', id: 'toolu_015hRsyfHk8ecMX8VphtXJni', input: '{"path":"d:\\NIPS2026\\architecture-upgrade\\ARCHITECTURE_UPGRADE_PLAN.md"}' },
    { type: 'tool_use_done', id: 'toolu_015hRsyfHk8ecMX8VphtXJni' },
    { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 37712, outputTokens: 184 } },
  ]
}

it('round-6-like stream now rebuilds an assistant message shape that satisfies the Anthropic tool-use contract', () => {
  const observed = replayAssistantRound(buildRoundSixLikeEvents())

  expect(observed.pendingToolCalls.map(call => call.name)).toEqual(['Grep', 'Read'])
  expect(observed.roundAssistantBlocks.map(block => block.type)).toEqual(['text', 'tool_use', 'tool_use'])

  const messages: LLMMessage[] = [
    { role: 'assistant', content: observed.roundAssistantBlocks },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'toolu_01Jc7bGdLN6XGEZnoD4KBd7H', toolName: 'Grep', content: 'grep output' },
        { type: 'tool_result', toolUseId: 'toolu_015hRsyfHk8ecMX8VphtXJni', toolName: 'Read', content: 'read output' },
      ],
    },
  ]

  expect(() => assertAnthropicToolContract(messages)).not.toThrow()
})

it('windows shell stderr with exitCode=0 is currently normalized as success rather than error', () => {
  const toolResult = buildShellToolResult(
    { command: 'ls -la', workingDirectory: 'd:\\NIPS2026' },
    {
      stdout: '',
      stderr: 'A parameter cannot be found that matches parameter name \'la\'.',
      exitCode: 0,
      cwd: 'd:\\NIPS2026',
      localExecutionTimeMs: 5158,
    },
  )

  expect(toolResult.result.case).toBe('success')
  expect(isToolResultError(toolResult)).toBe(false)
  expect(toolResult.result.value).toMatchObject({
    command: 'ls -la',
    workingDirectory: 'd:\\NIPS2026',
    stderr: 'A parameter cannot be found that matches parameter name \'la\'.',
    exitCode: 0,
  })
})
