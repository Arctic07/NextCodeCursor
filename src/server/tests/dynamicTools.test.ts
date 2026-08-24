import type { DynamicNamespace } from '../handlers/agent/dynamicTools'
import { describe, expect, it } from 'vitest'
import {
  buildDynamicToolsSection,

  MCP_AUTH_TOOL,
  renderDynamicToolsResult,
  shortenDescription,
  toDynamicNamespace,
} from '../handlers/agent/dynamicTools'

/**
 * GetDynamicTools 渲染层 —— 1:1 复刻校验。
 *
 * 所有期望值来自官方实测样本 (analysis/mcp-dynamic-tools.md §4.5),
 * 用 grok-4.5 对 agentn.global.api5.cursor.sh 套取,非推断。
 */

const LONG_DESC = `PROBE_DESC_LISTFUNCS — List functions in the loaded binary. Padding for truncation test: ${'x'.repeat(600)}`

const NS: DynamicNamespace[] = [
  {
    name: 'user-ida-pro-mcp',
    source: 'mcp',
    status: 'ready',
    tools: [
      {
        tool: 'decompile',
        description: 'PROBE_DESC_DECOMPILE — Decompile the function at a given address to pseudocode.',
        inputSchema: {
          type: 'object',
          properties: { address: { type: 'string' } },
          required: ['address'],
        },
      },
      { tool: 'list_funcs', description: LONG_DESC, inputSchema: { type: 'object', properties: {} } },
    ],
  },
  {
    name: 'user-probe-two',
    source: 'mcp',
    status: 'ready',
    tools: [{ tool: 'alpha', description: 'PROBE_DESC_ALPHA — second namespace.', inputSchema: { type: 'object' } }],
  },
]

describe('截断规则', () => {
  it('超过 185 字符时截断,总长恰好 200', () => {
    const out = shortenDescription(LONG_DESC)
    expect(out).toHaveLength(200)
    expect(out.endsWith('... [truncated]')).toBe(true)
    expect(out.slice(0, 185)).toBe(LONG_DESC.slice(0, 185))
  })

  it('未超限时原样返回,不加后缀', () => {
    // 实测未截断样本最长 179,边界内
    const short = 'x'.repeat(179)
    expect(shortenDescription(short)).toBe(short)
    expect(shortenDescription('x'.repeat(185))).toBe('x'.repeat(185))
  })
})

describe('single_tool 模式', () => {
  it('返回完整 inputSchema 且不截断 description', () => {
    const r = renderDynamicToolsResult({ namespace: 'user-ida-pro-mcp', toolName: 'list_funcs' }, NS)
    expect(r.mode).toBe('single_tool')
    expect(r.namespace).toBe('user-ida-pro-mcp')
    expect(r.namespaceStatus).toBe('ready')
    const tool = r.tool as Record<string, unknown>
    expect(tool.tool).toBe('list_funcs')
    expect(tool.description).toBe(LONG_DESC) // 完整,不截断
    expect(tool.inputSchema).toBeDefined()
  })
})

describe('namespace 模式', () => {
  it('列出该 namespace 全部工具,均带 inputSchema', () => {
    const r = renderDynamicToolsResult({ namespace: 'user-ida-pro-mcp' }, NS)
    expect(r.mode).toBe('namespace')
    expect(r.namespaceStatus).toBe('ready')
    const tools = r.tools as Array<Record<string, unknown>>
    expect(tools.map(t => t.tool)).toEqual(['decompile', 'list_funcs'])
    expect(tools.every(t => t.inputSchema !== undefined)).toBe(true)
    // namespace 模式永不截断
    expect(tools[1].description).toBe(LONG_DESC)
  })
})

describe('search 模式', () => {
  it('跨 namespace 搜索,结果无 inputSchema 且 description 截断', () => {
    const r = renderDynamicToolsResult({ pattern: 'alpha' }, NS)
    expect(r.mode).toBe('search')
    expect(r.pattern).toBe('alpha')
    const matches = r.matches as Array<Record<string, unknown>>
    expect(matches).toHaveLength(1)
    expect(matches[0].namespace).toBe('user-probe-two')
    expect(matches[0].tool).toBe('alpha')
    expect(matches[0].inputSchema).toBeUndefined()
  })

  it('截断长 description', () => {
    const r = renderDynamicToolsResult({ pattern: 'list_funcs' }, NS)
    const matches = r.matches as Array<Record<string, unknown>>
    expect(matches[0].description).toHaveLength(200)
  })

  it('非法正则退化为子串匹配而不抛出', () => {
    const r = renderDynamicToolsResult({ pattern: '[unclosed' }, NS)
    expect(r.mode).toBe('search')
    expect(r.matches).toEqual([])
  })
})

describe('catalog 模式', () => {
  it('无参数返回全部 namespace,工具精简且 description 截断', () => {
    const r = renderDynamicToolsResult({}, NS)
    expect(r.mode).toBe('catalog')
    const namespaces = r.namespaces as Array<Record<string, unknown>>
    expect(namespaces.map(n => n.namespace)).toEqual(['user-ida-pro-mcp', 'user-probe-two'])
    const tools = namespaces[0].tools as Array<Record<string, unknown>>
    expect(tools.every(t => t.inputSchema === undefined)).toBe(true)
    expect(tools[1].description).toHaveLength(200)
  })

  it('cursor 源 namespace 用 namespaceDescription 而非 namespaceStatus', () => {
    const r = renderDynamicToolsResult({}, [
      { name: 'cursor', source: 'cursor', description: 'Native Cursor tools.', tools: [] },
    ])
    const ns = (r.namespaces as Array<Record<string, unknown>>)[0]
    expect(ns.namespaceDescription).toBe('Native Cursor tools.')
    expect(ns.namespaceStatus).toBeUndefined()
  })
})

describe('mcp_auth 追加', () => {
  it('supportsMcpAuth 时在工具列表末尾补 mcp_auth', () => {
    const ns = toDynamicNamespace(
      {
        serverName: 'ida-pro-mcp',
        serverIdentifier: 'user-ida-pro-mcp',
        status: 'ready',
        tools: [{ name: 'x', providerIdentifier: 'ida-pro-mcp', toolName: 'decompile', description: 'd', inputSchema: {} }],
      },
      true,
    )
    expect(ns.tools.map(t => t.tool)).toEqual(['decompile', MCP_AUTH_TOOL.tool])
  })

  it('不支持时不补', () => {
    const ns = toDynamicNamespace(
      { serverName: 'x', serverIdentifier: 'user-x', status: 'ready', tools: [] },
      false,
    )
    expect(ns.tools).toEqual([])
  })

  it('每个 namespace 各自持有独立的 mcp_auth schema 对象', () => {
    // 共享引用会让一处 mutation 污染所有 namespace
    const a = toDynamicNamespace({ serverName: 'a', serverIdentifier: 'user-a', status: 'ready', tools: [] }, true)
    const b = toDynamicNamespace({ serverName: 'b', serverIdentifier: 'user-b', status: 'ready', tools: [] }, true)
    expect(a.tools[0].inputSchema).not.toBe(b.tools[0].inputSchema)
  })
})

describe('未知 namespace', () => {
  it('返回 not_found 而非抛出', () => {
    const r = renderDynamicToolsResult({ namespace: 'nope' }, NS)
    expect(r.namespaceStatus).toBe('not_found')
    expect(r.error).toContain('nope')
  })

  it('namespace 存在但工具不存在时报 tool 级错误', () => {
    const r = renderDynamicToolsResult({ namespace: 'user-ida-pro-mcp', toolName: 'nope' }, NS)
    expect(r.mode).toBe('single_tool')
    expect(r.namespaceStatus).toBe('ready')
    expect(r.error).toContain('nope')
  })
})

describe('<dynamic_tools> prompt 段', () => {
  const servers = [
    { serverIdentifier: 'user-ida-pro-mcp', toolNames: ['decompile', 'list_funcs'] },
    { serverIdentifier: 'user-probe-two', toolNames: ['alpha'], serverUseInstructions: 'USE_ME' },
  ]

  it('namespace name 用 serverIdentifier,工具名逗号分隔', () => {
    const s = buildDynamicToolsSection(servers, false)
    expect(s).toContain('<namespace name="user-ida-pro-mcp" tools="decompile, list_funcs" source="mcp" />')
  })

  it('serverUseInstructions 渲染为 namespaceUseInstructions', () => {
    const s = buildDynamicToolsSection(servers, false)
    expect(s).toContain('namespaceUseInstructions="USE_ME"')
  })

  it('supportsMcpAuth 时工具列表含 mcp_auth 且附认证说明', () => {
    const s = buildDynamicToolsSection(servers, true)
    expect(s).toContain('tools="decompile, list_funcs, mcp_auth"')
    expect(s).toContain('call `mcp_auth` through `CallDynamicTool`')
  })

  it('不支持认证时既不列 mcp_auth 也不附说明', () => {
    const s = buildDynamicToolsSection(servers, false)
    expect(s).not.toContain('mcp_auth')
  })

  it('保留官方原文的关键引导语', () => {
    const s = buildDynamicToolsSection(servers, false)
    expect(s).toContain('GetDynamicTools` and `CallDynamicTool')
    expect(s).toContain('Always inspect a tool\'s schema before invoking it with `CallDynamicTool`.')
    expect(s).toContain('... [truncated]')
  })

  it('转义 XML 属性中的引号,避免属性提前闭合', () => {
    const s = buildDynamicToolsSection(
      [{ serverIdentifier: 'srv', toolNames: ['t'], serverUseInstructions: 'say "hi" & <bye>' }],
      false,
    )
    expect(s).toContain('&quot;hi&quot;')
    expect(s).toContain('&amp;')
    expect(s).toContain('&lt;bye&gt;')
  })
})
