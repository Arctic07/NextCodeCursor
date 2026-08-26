import { describe, expect, it } from 'vitest'
import { mergeMcpStateIntoRoutingTable } from '../handlers/agent/mcpState'
import { buildToolArgs } from '../handlers/agent/toolBuilders'
import { mapToolName, parseFlatMcpToolName, resolveToolCall } from '../handlers/agent/tools'
import { getProviderToolCatalog } from '../handlers/llm/toolCatalog'

/**
 * dynamic namespace 模式下的 CallDynamicTool 路由。
 *
 * Cursor 3.15.6 起第三方 MCP 工具不再逐个注册为 LLM 工具,而是收进 namespace。
 * LLM 先用 GetDynamicTools 取 schema,再用 CallDynamicTool{namespace,toolName,arguments}
 * 调用。见 analysis/mcp-dynamic-tools.md。
 */

const AVAILABLE = [
  {
    name: 'user-ida-pro-mcp-decompile',
    providerIdentifier: 'ida-pro-mcp',
    toolName: 'decompile',
    serverIdentifier: 'user-ida-pro-mcp',
  },
]

it('routes CallDynamicTool to mcpToolCall, mapping official arg names', () => {
  const { cursorToolType, sanitizedInput } = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'user-ida-pro-mcp', toolName: 'decompile', arguments: { addr: '0x401000' } },
    AVAILABLE,
  )

  expect(cursorToolType).toBe('mcpToolCall')
  expect(sanitizedInput.toolName).toBe('decompile')
  expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
  expect(sanitizedInput.providerIdentifier).toBe('ida-pro-mcp')
  expect(sanitizedInput.args).toEqual({ addr: '0x401000' })
  expect(sanitizedInput.name).toBe('user-ida-pro-mcp-decompile')
})

it('routes reserved cursor namespace back to the native tool identity', () => {
  const resolved = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'cursor', toolName: 'TodoWrite', arguments: { todos: [] } },
    AVAILABLE,
    [{ tool: 'TodoWrite' }],
  )
  expect(resolved.cursorToolType).toBe('updateTodosToolCall')
  expect(resolved.effectiveToolName).toBe('TodoWrite')
  expect(resolved.sanitizedInput).toEqual({ todos: [] })
  expect(resolved.resolutionError).toBeUndefined()
})

it('rejects non-object arguments before entering a native cursor lifecycle', () => {
  const resolved = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'cursor', toolName: 'TodoWrite', arguments: [] },
    AVAILABLE,
    [{ tool: 'TodoWrite' }],
  )
  expect(resolved.resolutionError).toContain('JSON object')
})

it('rejects cursor tools that were not advertised by the dynamic registry', () => {
  const resolved = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'cursor', toolName: 'UnknownNative', arguments: {} },
    AVAILABLE,
    [{ tool: 'TodoWrite' }],
  )
  expect(resolved.resolutionError).toContain('UnknownNative')
  expect(resolved.cursorToolType).toBe('mcpToolCall')
})

it('accepts the server display name as well as the identifier', () => {
  const { sanitizedInput } = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'ida-pro-mcp', toolName: 'decompile', arguments: {} },
    AVAILABLE,
  )
  expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
  expect(sanitizedInput.providerIdentifier).toBe('ida-pro-mcp')
})

it('still accepts the legacy CallMcpTool name and server param', () => {
  // 会话中途升级时,LLM 可能仍按旧词表发起调用 —— 不能失配
  const { cursorToolType, sanitizedInput } = resolveToolCall(
    'CallMcpTool',
    { server: 'user-ida-pro-mcp', toolName: 'decompile', arguments: { addr: '0x1' } },
    AVAILABLE,
  )
  expect(cursorToolType).toBe('mcpToolCall')
  expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
  expect(sanitizedInput.args).toEqual({ addr: '0x1' })
})

it('still forwards the call when the tool is absent from the routing table', () => {
  // 客户端 callTool 以 toolName 为准,serverIdentifier 只是过滤器 —— 宁可让
  // 客户端报 tool-not-found,也不要在这里静默吞掉调用。
  const { cursorToolType, sanitizedInput } = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'other-server', toolName: 'unknown_tool', arguments: { a: 1 } },
    AVAILABLE,
  )
  expect(cursorToolType).toBe('mcpToolCall')
  expect(sanitizedInput.toolName).toBe('unknown_tool')
  expect(sanitizedInput.serverIdentifier).toBe('other-server')
  expect(sanitizedInput.args).toEqual({ a: 1 })
})

it('keeps per-tool routing working when tools are registered individually (legacy)', () => {
  const { cursorToolType, sanitizedInput } = resolveToolCall(
    'user-ida-pro-mcp-decompile',
    { addr: '0x401000' },
    AVAILABLE,
  )
  expect(cursorToolType).toBe('mcpToolCall')
  expect(sanitizedInput.toolName).toBe('decompile')
  expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
})

it('maps GetDynamicTools onto the discovery tool call', () => {
  const { cursorToolType, sanitizedInput } = resolveToolCall(
    'GetDynamicTools',
    { namespace: 'user-ida-pro-mcp', toolName: 'decompile' },
    AVAILABLE,
  )
  expect(cursorToolType).toBe('getMcpToolsToolCall')
  // 该工具走服务端自执行,input 原样透传给渲染层
  expect(sanitizedInput.namespace).toBe('user-ida-pro-mcp')
})

it('exposes both dynamic-tool metas in every provider prompt vocabulary', () => {
  // 曾只有 openai 词表含 MCP 调用工具,导致 anthropic/gemini 会话读得到 descriptor 却调不动
  for (const provider of ['anthropic', 'openai-chat', 'openai-responses', 'gemini'] as const) {
    const vocab = getProviderToolCatalog(provider).promptVocabulary
    expect(vocab, `${provider} vocabulary`).toContain('CallDynamicTool')
    expect(vocab, `${provider} vocabulary`).toContain('GetDynamicTools')
  }
})

describe('defensive flat MCP routing', () => {
  it('maps mcp__server__tool onto a typed MCP call and preserves __ inside tool names', () => {
    expect(parseFlatMcpToolName('mcp__srv__tool__part')).toEqual({
      server: 'srv',
      toolName: 'tool__part',
    })
    expect(mapToolName('mcp__srv__tool')).toBe('mcpToolCall')

    const { cursorToolType, sanitizedInput } = resolveToolCall(
      'mcp__ida-pro-mcp__decompile',
      { address: '0x401000' },
      AVAILABLE,
    )
    expect(cursorToolType).toBe('mcpToolCall')
    expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
    expect(sanitizedInput.toolName).toBe('decompile')
    expect(sanitizedInput.args).toEqual({ address: '0x401000' })

    const args = buildToolArgs('mcp__ida-pro-mcp__decompile', sanitizedInput, 'call-flat')
    expect(args.serverIdentifier).toBe('user-ida-pro-mcp')
    expect(args.toolCallId).toBe('call-flat')
  })

  it('keeps malformed or differently-cased names untouched', () => {
    expect(parseFlatMcpToolName('mcp__only-server')).toBeNull()
    expect(mapToolName('MCP__srv__tool')).toBe('MCP__srv__tool')
  })
})

it('discovery synchronizes and upgrades the authoritative routing table', () => {
  const routingTable = [{
    name: 'user-ida-pro-mcp-decompile',
    description: '',
    inputSchema: { type: 'object' },
    providerIdentifier: 'ida-pro-mcp',
    toolName: 'decompile',
    serverIdentifier: 'user-ida-pro-mcp',
  }]
  const merged = mergeMcpStateIntoRoutingTable(routingTable, [{
    serverName: 'ida-pro-mcp',
    serverIdentifier: 'user-ida-pro-mcp',
    status: 'connected',
    tools: [
      {
        name: 'user-ida-pro-mcp-decompile',
        providerIdentifier: 'ida-pro-mcp',
        toolName: 'decompile',
        description: 'Full decompile description.',
        inputSchema: { type: 'object', required: ['address'] },
      },
      {
        name: 'user-ida-pro-mcp-xrefs',
        providerIdentifier: 'ida-pro-mcp',
        toolName: 'xrefs',
        description: 'Find references.',
        inputSchema: { type: 'object' },
      },
    ],
  }])

  expect(merged).toEqual({ added: 1, updated: 1 })
  expect(routingTable).toHaveLength(2)
  expect(routingTable[0].description).toBe('Full decompile description.')
  expect(routingTable[0].inputSchema).toEqual({ type: 'object', required: ['address'] })
  expect(routingTable[1].toolName).toBe('xrefs')
})
