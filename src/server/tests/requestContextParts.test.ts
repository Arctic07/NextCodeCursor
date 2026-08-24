import { expect, it } from 'vitest'
import { parseRunRequest } from '../handlers/agent/protocol'
import { applyMcpsPart } from '../handlers/agent/requestContextParts'

/**
 * Cursor 3.13+ requestContextParts 分片投递 (ref_only 模式) 兼容。
 *
 * 实测 (2-Cometixy.log, 2026-08-07): ref_only 下 requestContext 与顶层
 * mcp_tools 同时缺席, MCP 工具表只存在于 mcps blob 中。
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
    userMessageAction: {
      userMessage: { text: 'q' },
      // ref_only: 无 requestContext, 只有 parts
      requestContextParts: {
        mcpsBlobId: new Uint8Array([1, 2, 3]),
        mcpsByteLength: 128,
        dynamicContext: {
          webSearchEnabled: true,
          readLintsEnabled: true,
          env: { osType: 'darwin' },
        },
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
      requestContextParts: {
        mcpsBlobId: new Uint8Array([9]),
        dynamicContext: { webSearchEnabled: false },
      },
    },
  }))

  expect(parsed.webSearchEnabled).toBe(true)
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
    userMessageAction: {
      userMessage: { text: 'q' },
      requestContextParts: { mcpsBlobId: new Uint8Array([1]), dynamicContext: {} },
    },
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
