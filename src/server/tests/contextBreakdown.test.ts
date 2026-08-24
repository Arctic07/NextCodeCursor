import type { LLMMessage, LLMTool } from '../handlers/llm/types'
import { describe, expect, it } from 'vitest'
import { buildContextBreakdown } from '../handlers/agent/conversationRuntime'

/**
 * Context breakdown 的 tools / mcp 分类边界。
 *
 * 划分依据是**来源**而非性质:
 *   tools — 内置工具 (含 GetDynamicTools / CallDynamicTool 两个 meta 工具)
 *   mcp   — 一切 MCP 来的东西 (dynamic_tools 段、mcp_instructions 段、
 *           legacy 扁平表里的 MCP schema、GetDynamicTools 的 discovery 结果)
 *
 * 这样 legacy 与 dynamic 两种模式下 "MCP 吃了多少 context" 的口径才一致。
 */

function tokensOf(categories: Array<{ id: string, estimatedTokens: number }>, id: string): number {
  return categories.find(c => c.id === id)?.estimatedTokens ?? 0
}

const BUILTIN: LLMTool = {
  name: 'Shell',
  description: 'Run a shell command.',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
}
const MCP_TOOL: LLMTool = {
  name: 'user-ida-pro-mcp-decompile',
  description: 'Decompile a function. '.repeat(20),
  inputSchema: { type: 'object', properties: { address: { type: 'string' } } },
}

describe('legacy 模式 (MCP 工具进扁平 requestTools)', () => {
  it('扁平表里的 MCP 工具 schema 计入 mcp 而非 tools', () => {
    const withMcp = buildContextBreakdown({
      systemContent: 'You are an assistant.',
      preambleUserContent: '',
      requestMessages: [],
      requestTools: [BUILTIN, MCP_TOOL],
      mcpToolNames: new Set([MCP_TOOL.name]),
    })
    const withoutMcp = buildContextBreakdown({
      systemContent: 'You are an assistant.',
      preambleUserContent: '',
      requestMessages: [],
      requestTools: [BUILTIN],
      mcpToolNames: new Set<string>(),
    })

    // 加入一个 MCP 工具后,tools 分类不应变化,增量全落在 mcp
    expect(tokensOf(withMcp, 'tools')).toBe(tokensOf(withoutMcp, 'tools'))
    expect(tokensOf(withMcp, 'mcp')).toBeGreaterThan(0)
    expect(tokensOf(withoutMcp, 'mcp')).toBe(0)
  })

  it('空 MCP 集合不会凭空产生 "[]" 的 token', () => {
    const c = buildContextBreakdown({
      systemContent: 'x',
      preambleUserContent: '',
      requestMessages: [],
      requestTools: [BUILTIN],
      mcpToolNames: new Set<string>(),
    })
    expect(tokensOf(c, 'mcp')).toBe(0)
  })
})

describe('dynamic 模式 (discovery 结果进对话历史)', () => {
  const DISCOVERY = JSON.stringify({
    mode: 'namespace',
    namespace: 'user-ida-pro-mcp',
    namespaceStatus: 'ready',
    tools: Array.from({ length: 20 }, (_, i) => ({
      tool: `tool_${i}`,
      description: 'Some description here.',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    })),
  })

  const base = {
    systemContent: 'You are an assistant.',
    preambleUserContent: '',
    requestTools: [BUILTIN],
    mcpToolNames: new Set<string>(),
  }

  it('anthropic 形态: tool_result block 被计入 (曾整块漏掉)', () => {
    const c = buildContextBreakdown({
      ...base,
      requestMessages: [{
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't1', toolName: 'GetDynamicTools', content: DISCOVERY }],
      }] as LLMMessage[],
    })
    expect(tokensOf(c, 'mcp')).toBeGreaterThan(100)
  })

  it('openai 形态: role=tool 消息计入同一分类,与 anthropic 口径一致', () => {
    const anthropic = buildContextBreakdown({
      ...base,
      requestMessages: [{
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't1', toolName: 'GetDynamicTools', content: DISCOVERY }],
      }] as LLMMessage[],
    })
    const openai = buildContextBreakdown({
      ...base,
      requestMessages: [{
        role: 'tool',
        content: DISCOVERY,
        toolCallId: 't1',
        toolName: 'GetDynamicTools',
      }] as LLMMessage[],
    })
    expect(tokensOf(openai, 'mcp')).toBe(tokensOf(anthropic, 'mcp'))
  })

  it('非 MCP 的工具结果归 conversation,不污染 mcp', () => {
    const c = buildContextBreakdown({
      ...base,
      requestMessages: [{
        role: 'tool',
        content: 'shell output here',
        toolCallId: 't1',
        toolName: 'Shell',
      }] as LLMMessage[],
    })
    expect(tokensOf(c, 'mcp')).toBe(0)
    expect(tokensOf(c, 'conversation')).toBeGreaterThan(0)
  })

  it('openai 形态的工具结果不被重复计数', () => {
    const c = buildContextBreakdown({
      ...base,
      requestMessages: [{
        role: 'tool',
        content: 'A'.repeat(400),
        toolCallId: 't1',
        toolName: 'Shell',
      }] as LLMMessage[],
    })
    const once = buildContextBreakdown({ ...base, requestMessages: [] })
    // 400 个 'A' 约 50 token;若重复计数会翻倍
    const delta = tokensOf(c, 'conversation') - tokensOf(once, 'conversation')
    expect(delta).toBeGreaterThan(20)
    expect(delta).toBeLessThan(120)
  })
})

describe('<dynamic_tools> 段', () => {
  it('计入 mcp,且不残留在 system_prompt 里', () => {
    const section = '\n<dynamic_tools>\nYou have access to tools through dynamic namespaces.\n</dynamic_tools>'
    const withSection = buildContextBreakdown({
      systemContent: `You are an assistant.${section}`,
      preambleUserContent: '',
      requestMessages: [],
      requestTools: [],
      mcpToolNames: new Set<string>(),
    })
    const withoutSection = buildContextBreakdown({
      systemContent: 'You are an assistant.',
      preambleUserContent: '',
      requestMessages: [],
      requestTools: [],
      mcpToolNames: new Set<string>(),
    })
    expect(tokensOf(withSection, 'mcp')).toBeGreaterThan(0)
    // 段落被剥离,system_prompt 不应因此增长
    expect(tokensOf(withSection, 'system_prompt')).toBe(tokensOf(withoutSection, 'system_prompt'))
  })
})
