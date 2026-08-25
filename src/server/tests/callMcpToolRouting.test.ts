import { describe, expect, it } from 'vitest'
import { mapToolName, resolveToolCall } from '../handlers/agent/tools'
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

describe('模型幻觉出的扁平 MCP 工具名', () => {
  it('mcp__<server>__<tool> 路由到 mcpToolCall 而非原样透传', () => {
    // 原样透传会让客户端收到非法的 toolCall case:
    // "[STREAM] unknown tool type — no proto Schema, falling back to bare object"
    const { cursorToolType, sanitizedInput } = resolveToolCall(
      'mcp__user-ida-pro-mcp__decompile',
      { address: '0x401000' },
      AVAILABLE,
    )
    expect(cursorToolType).toBe('mcpToolCall')
    expect(sanitizedInput.toolName).toBe('decompile')
    expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
    expect(sanitizedInput.args).toEqual({ address: '0x401000' })
  })

  it('未注册的 server/tool 仍路由到 mcpToolCall,由客户端报 tool-not-found', () => {
    const { cursorToolType, sanitizedInput } = resolveToolCall(
      'mcp__ghost-server__nope',
      {},
      AVAILABLE,
    )
    expect(cursorToolType).toBe('mcpToolCall')
    expect(sanitizedInput.serverIdentifier).toBe('ghost-server')
    expect(sanitizedInput.toolName).toBe('nope')
  })

  it('mapToolName 对该形态返回 mcpToolCall', () => {
    expect(mapToolName('mcp__srv__tool')).toBe('mcpToolCall')
  })

  it('不误伤: 非 mcp__ 前缀与畸形名保持原样', () => {
    expect(mapToolName('Shell')).toBe('shellToolCall')
    expect(mapToolName('mcp__onlyserver')).toBe('mcp__onlyserver')
    expect(mapToolName('mcp____x')).toBe('mcp____x')
  })

  it('真实注册的同名工具优先走精确匹配', () => {
    const withFlatName = [{
      name: 'mcp__user-x__tool',
      providerIdentifier: 'x',
      toolName: 'real_tool',
      serverIdentifier: 'user-x',
    }]
    const { sanitizedInput } = resolveToolCall('mcp__user-x__tool', { a: 1 }, withFlatName)
    // 走 descriptor 分支 → toolName 取注册表里的值,而非从名字里切出来的 "tool"
    expect(sanitizedInput.toolName).toBe('real_tool')
  })
})
