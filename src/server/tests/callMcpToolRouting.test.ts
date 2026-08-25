import { describe, expect, it } from 'vitest'
import { buildToolArgs } from '../handlers/agent/toolBuilders'
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

describe('mCP 生态扁平命名 → Cursor McpArgs 范式', () => {
  // mcp__<server>__<tool> 是 MCP 社区(Claude Code / 各家 SDK)通用写法,
  // 与 Cursor 自用的 `${serverIdentifier}-${toolName}` 并存。服务端负责归一,
  // 不做转换则名字会被当成 cursorToolType 原样下发,客户端收到非法 toolCall case
  // ("[STREAM] unknown tool type — no proto Schema", 实测 2026-08-25)。
  it('mcp__<server>__<tool> 归一到 mcpToolCall', () => {
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

  it('前缀大小写敏感 — 对齐客户端 startsWith("mcp__")', () => {
    // 客户端 hook matcher 转换用的是 startsWith 而非正则,大写不认。
    // 实测样本里 MCP__ 只出现在模型的 search pattern 中,从未出现在 tool_use 名字里。
    expect(mapToolName('MCP__user-ida-pro-mcp__decompile')).toBe('MCP__user-ida-pro-mcp__decompile')
  })

  it('toolName 可含 __ — 对齐 split("__").slice(2).join("__")', () => {
    const { sanitizedInput } = resolveToolCall('mcp__srv__we__ird', {}, [])
    expect(sanitizedInput.serverIdentifier).toBe('srv')
    expect(sanitizedInput.toolName).toBe('we__ird')
  })

  it('server 段用用户写的 name 也能落到正确条目 (实测出现过)', () => {
    // serverIdentifier = 作用域前缀 + name (mcp-config-service.ts computeIdentifier):
    //   用户级 → user-{name};项目级 → project-{projectPath}-{name}
    // 用户和模型认的都是 name,故两种形态都要认
    const { sanitizedInput } = resolveToolCall('mcp__ida-pro-mcp__decompile', {}, AVAILABLE)
    expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
    expect(sanitizedInput.toolName).toBe('decompile')
  })

  it('项目级前缀 project-{path}- 同样适用', () => {
    const projectScoped = [{
      name: 'project-Users-me-proj-ida-pro-mcp-decompile',
      providerIdentifier: 'ida-pro-mcp',
      toolName: 'decompile',
      serverIdentifier: 'project-Users-me-proj-ida-pro-mcp',
    }]
    // 模型用 name 指代
    expect(resolveToolCall('mcp__ida-pro-mcp__decompile', {}, projectScoped)
      .sanitizedInput.serverIdentifier).toBe('project-Users-me-proj-ida-pro-mcp')
    // 也可能用完整 identifier
    expect(resolveToolCall('mcp__project-Users-me-proj-ida-pro-mcp__decompile', {}, projectScoped)
      .sanitizedInput.serverIdentifier).toBe('project-Users-me-proj-ida-pro-mcp')
  })

  it('同名工具存在于多个 server 且 server 段对不上时,不瞎猜', () => {
    const twoServers = [
      { name: 'a-run', providerIdentifier: 'alpha', toolName: 'run', serverIdentifier: 'user-alpha' },
      { name: 'b-run', providerIdentifier: 'beta', toolName: 'run', serverIdentifier: 'user-beta' },
    ]
    const { sanitizedInput } = resolveToolCall('mcp__ghost__run', {}, twoServers)
    // 歧义时按解析值原样透传,交客户端裁决,不随便选一个
    expect(sanitizedInput.serverIdentifier).toBe('ghost')
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

  it('exec args 链路: 扁平名也能产出完整 McpArgs', () => {
    // buildToolArgs 按 alias 查不到 mcp__... ,靠 sanitizedInput.providerIdentifier
    // 兜底路由到 mcpToolCall 的 builder —— 这条链断了 args 会是空的
    const { sanitizedInput } = resolveToolCall(
      'mcp__user-ida-pro-mcp__decompile',
      { address: '0x401000' },
      AVAILABLE,
    )
    const args = buildToolArgs('mcp__user-ida-pro-mcp__decompile', sanitizedInput, 'call-1')
    expect(args.toolName).toBe('decompile')
    expect(args.serverIdentifier).toBe('user-ida-pro-mcp')
    expect(args.toolCallId).toBe('call-1')
    expect(args.args).toBeDefined()
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
