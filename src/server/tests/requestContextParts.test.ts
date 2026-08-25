import { expect, it } from 'vitest'
import { buildMessages, parseRunRequest } from '../handlers/agent/protocol'
import { toBytes } from '../handlers/agent/protocol/shared'
import { applyMcpsPart } from '../handlers/agent/requestContextParts'

/**
 * Cursor 3.13+ requestContextParts 分片投递 (ref_only 模式) 兼容。
 *
 * 实测 (2-Cometixy.log, 2026-08-07): ref_only 下 requestContext 与顶层
 * mcp_tools 同时缺席, MCP 工具表只存在于 mcps blob 中。
 *
 * **层级要点** —— 两者不在同一层,proto (agent.v1) 明确:
 *
 *   message ConversationAction {
 *     oneof action { user_message_action = 1; resume_action = 2; ... }
 *     optional RequestContextPartReferences request_context_parts = 17;  // action 层
 *   }
 *   message UserMessageAction {
 *     RequestContext request_context = 2;                                // userAction 内层
 *   }
 *
 * 本文件早期把 parts 构造在 userMessageAction 内部,与当时同样取错层级的
 * 实现刚好自洽,于是测试全绿而线上 ref_only 补偿从未生效
 * (1-ClaudeCodeRev.log 2026-08-24: actionKeys 为
 *  ["userMessageAction","requestContextParts"] 两者并列,同轮
 *  mcpMode 退化 legacy_flat、routingTableSize=0)。故此处按 proto 真实层级构造。
 */

function baseRunRequest(action: Record<string, unknown>) {
  return {
    runRequest: {
      conversationId: 'c-parts',
      action,
      modelDetails: { modelId: 'm' },
    },
  }
}

it('falls back to requestContextParts.dynamicContext when inline requestContext is absent (ref_only)', () => {
  const parsed = parseRunRequest(baseRunRequest({
    // ref_only: userMessageAction 内无 requestContext,parts 挂在 action 层
    userMessageAction: { userMessage: { text: 'q' } },
    requestContextParts: {
      mcpsBlobId: new Uint8Array([1, 2, 3]),
      mcpsByteLength: 128,
      dynamicContext: {
        webSearchEnabled: true,
        readLintsEnabled: true,
        env: { osType: 'darwin' },
      },
    },
  }))

  // dynamic_context 里的开关应当被救回
  expect(parsed.webSearchEnabled).toBe(true)
  expect(parsed.readLintsEnabled).toBe(true)
  // mcps blobId 透出供运行时取回
  expect(parsed.mcpsBlobId).toEqual(new Uint8Array([1, 2, 3]))
  // 工具表此刻仍为空 —— 需靠 blob 取回补齐
  expect(parsed.mcpTools).toEqual([])
})

it('prefers inline requestContext over parts when both present (dual)', () => {
  const parsed = parseRunRequest(baseRunRequest({
    userMessageAction: {
      userMessage: { text: 'q' },
      requestContext: { webSearchEnabled: true },
    },
    requestContextParts: {
      mcpsBlobId: new Uint8Array([9]),
      dynamicContext: { webSearchEnabled: false },
    },
  }))

  expect(parsed.webSearchEnabled).toBe(true)
  expect(parsed.mcpsBlobId).toBeUndefined()
})

it('leaves mcpsBlobId undefined in legacy mode', () => {
  const parsed = parseRunRequest(baseRunRequest({
    userMessageAction: {
      userMessage: { text: 'q' },
      requestContext: { webSearchEnabled: true },
    },
  }))

  expect(parsed.mcpsBlobId).toBeUndefined()
})

it('restores MCP tools from a decoded mcps part, reusing parse normalization', () => {
  const parsed = parseRunRequest(baseRunRequest({
    userMessageAction: { userMessage: { text: 'q' } },
    requestContextParts: { mcpsBlobId: new Uint8Array([1]), dynamicContext: {} },
  }))
  expect(parsed.mcpTools).toEqual([])

  applyMcpsPart(parsed, {
    tools: [
      // name = `${serverIdentifier}-${toolName}` — 前缀剥离得到 identifier
      { name: 'user-ida-pro-mcp-decompile', providerIdentifier: 'ida-pro-mcp', toolName: 'decompile', description: 'd' },
      { name: 'user-ida-pro-mcp-list_funcs', providerIdentifier: 'ida-pro-mcp', toolName: 'list_funcs', description: 'l' },
    ],
    mcpInstructions: [
      { serverName: 'ida-pro-mcp', serverIdentifier: 'user-ida-pro-mcp', instructions: 'use ida' },
    ],
    mcpFileSystemOptions: {
      workspaceProjectDir: '/proj',
      mcpDescriptors: [
        { serverName: 'ida-pro-mcp', serverIdentifier: 'user-ida-pro-mcp', folderPath: '/proj/mcps/ida' },
      ],
    },
  })

  expect(parsed.mcpTools.map(t => t.name)).toEqual([
    'user-ida-pro-mcp-decompile',
    'user-ida-pro-mcp-list_funcs',
  ])
  // serverIdentifier 必须回填 —— 客户端 callTool 用它限定 server 范围
  expect(parsed.mcpTools.every(t => t.serverIdentifier === 'user-ida-pro-mcp')).toBe(true)
  expect(parsed.mcpTools[0].toolName).toBe('decompile')
  expect(parsed.mcpServers[0].serverIdentifier).toBe('user-ida-pro-mcp')
  expect(parsed.mcpBasePath).toBe('/proj/mcps')
  expect(parsed.mcpInstructions[0].instructions).toBe('use ida')
})

it('reads requestContextParts from the ConversationAction level, not from userMessageAction', () => {
  // 回归锁: proto 里 request_context_parts 是 ConversationAction 的 field 17,
  // 与 user_message_action 平级。若实现退回从 userAction 内部取,
  // 这里的 mcpsBlobId 会是 undefined —— 线上表现为 ref_only 第二轮起
  // MCP 工具表整体清零 (mcpMode 退化 legacy_flat)。
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'c-level',
      modelDetails: { modelId: 'm' },
      action: {
        userMessageAction: { userMessage: { text: 'q' } },
        requestContextParts: {
          mcpsBlobId: new Uint8Array([7, 7]),
          dynamicContext: { webSearchEnabled: true },
        },
      },
    },
  })

  expect(parsed.mcpsBlobId).toEqual(new Uint8Array([7, 7]))
  expect(parsed.webSearchEnabled).toBe(true)
})

it('accepts proto bytes as Uint8Array or base64 from JSON transport', () => {
  const raw = new Uint8Array([1, 2, 3, 4])
  expect(toBytes(raw)).toEqual(raw)
  expect(toBytes(Buffer.from(raw).toString('base64'))).toEqual(raw)
  const parsed = parseRunRequest(baseRunRequest({
    userMessageAction: { userMessage: { text: 'q' } },
    requestContextParts: {
      mcpsBlobId: Buffer.from(raw).toString('base64'),
      mcpsByteLength: 128,
      dynamicContext: {},
    },
  }))
  expect(parsed.mcpsBlobId).toEqual(raw)
})

it('restores meta descriptors and routing entries from the mcps blob', () => {
  const parsed = parseRunRequest(baseRunRequest({
    userMessageAction: { userMessage: { text: 'q' } },
    requestContextParts: { mcpsBlobId: new Uint8Array([1]), dynamicContext: {} },
  }))

  applyMcpsPart(parsed, {
    tools: [],
    mcpInstructions: [],
    mcpMetaToolOptions: {
      enabled: true,
      mcpDescriptors: [{
        serverName: 'ida-pro-mcp',
        serverIdentifier: 'user-ida-pro-mcp',
        serverUseInstructions: 'Inspect before calling.',
        tools: [
          { toolName: 'instance_list' },
          { toolName: 'decompile', inputSchemaJson: '{"type":"object","properties":{"address":{"type":"string"}}}' },
          { toolName: '' },
        ],
      }],
    },
  })

  expect(parsed.mcpMetaTool?.descriptors[0].tools.map(t => t.toolName)).toEqual(['instance_list', 'decompile'])
  expect(parsed.mcpTools.map(t => `${t.serverIdentifier}:${t.toolName}`)).toEqual([
    'user-ida-pro-mcp:instance_list',
    'user-ida-pro-mcp:decompile',
  ])
  expect(parsed.mcpTools[1].inputSchema).toEqual({
    type: 'object',
    properties: { address: { type: 'string' } },
  })
  parsed.modelId = 'claude-sonnet-4'
  const system = buildMessages(parsed)[0].content
  expect(system).toContain('<dynamic_tools>')
  expect(system).toContain('name="user-ida-pro-mcp"')
  expect(system).toContain('tools="instance_list, decompile"')
})

it('does not enable meta-tool mode when the mcps blob explicitly disables it', () => {
  const parsed = parseRunRequest(baseRunRequest({
    userMessageAction: { userMessage: { text: 'q' } },
    requestContextParts: { mcpsBlobId: new Uint8Array([1]), dynamicContext: {} },
  }))
  applyMcpsPart(parsed, { tools: [], mcpInstructions: [], mcpMetaToolOptions: { enabled: false } })
  expect(parsed.mcpMetaTool).toBeUndefined()
})
