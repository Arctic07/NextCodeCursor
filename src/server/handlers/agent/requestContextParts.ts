/**
 * requestContextParts blob 取回 — Cursor 3.13+ ref_only 传输模式补偿
 *
 * 背景 (agent-client/request-context-blob.ts):
 *   3.13 起 requestContext 支持分片投递,模式由 Statsig
 *   `nal_request_context_blob_transport_config` 下发,内置 fallback 为 legacy:
 *
 *     legacy   → requestContext 内联,无 parts
 *     dual     → requestContext 内联 + parts (双写)
 *     ref_only → requestContext = undefined,只发 parts
 *
 *   客户端拆分函数 (workbench GM_) 把 requestContext 切成 5 份,其中
 *   rules / skills / subagents / mcps 四组序列化后按内容哈希存入
 *   **客户端本地** transient blob map (seedAll),请求里只带 blobId;
 *   其余字段留在 parts.dynamic_context 内联下发。
 *
 *   注意 ref_only 有一条首轮降级: 会话第一轮 (turns.length === 0 且
 *   userMessageAction) 强制走 dual,第二轮起才是真 ref_only。这解释了
 *   "首条消息 MCP 正常、后续消息 MCP 消失" 的现象。
 *
 * 实测 (2-Cometixy.log, 2026-08-07):
 *   ref_only 下 requestContext 与顶层 mcp_tools **同时缺席**,
 *   parseRunRequest 两条数据源全落空 → mcpToolsCount: 0,
 *   LLM 只剩内置的 ListMcpResources / FetchMcpResource / CallMcpTool,
 *   动态 MCP 工具(decompile / list_funcs …)全部消失。
 *
 * 本模块负责: 用 mcps_blob_id 经 KV 通道向客户端取回该 blob,
 * 解码为 RequestContextMcpsPart,把 MCP 工具表补回 ParsedRunRequest。
 */
import { fromBinary } from '@bufbuild/protobuf'
import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import { RequestContextMcpsPartSchema } from '../../gen/agent_v1_pb'
import { logger } from '../../logger'
import type { ParsedRunRequest } from './protocol/types'
import {
  normalizeMcpInputSchema,
  normalizeMcpToolName,
  resolveMcpServerIdentifier,
} from './protocol/parseRunRequest'
import type { AgentSession } from './session'
import { kvGetBlob } from './stream'
import { waitForMessageMatchingWithHeartbeat } from './wait'

/** 取 blob 的等待上限 — 客户端本地内存命中,正常是毫秒级 */
const BLOB_FETCH_TIMEOUT_MS = 10_000

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length)
    return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i])
      return false
  }
  return true
}

/**
 * 从 kvClientMessage.getBlobResult 中取出 blob 内容。
 *
 * proto: GetBlobResult { bytes blob_data = 1; Error error = 2 }
 * 3.13 起新增 error 字段,失败时该字段有值、blob_data 为空。
 */
function extractBlobData(msg: Record<string, unknown>): Uint8Array | null {
  const kv = msg.kvClientMessage as Record<string, unknown> | undefined
  const result = kv?.getBlobResult as Record<string, unknown> | undefined
  if (!result)
    return null
  if (result.error) {
    logger.warn({ error: result.error }, '[PROTOCOL] getBlobResult returned error')
    return null
  }
  const data = result.blobData
  return data instanceof Uint8Array && data.length > 0 ? data : null
}

export interface FetchedMcpsPart {
  tools: Array<Record<string, unknown>>
  mcpInstructions: Array<Record<string, unknown>>
  mcpFileSystemOptions?: Record<string, unknown>
  mcpMetaToolOptions?: Record<string, unknown>
}

/**
 * 向客户端请求 mcps blob 并解码。
 *
 * 作为 async generator: yield 出去的是要发给客户端的 kvGetBlob 帧与心跳,
 * return 的才是解码结果。取不到时返回 null,调用方应保持原有(空)工具表,
 * 不中断本轮对话。
 */
export async function* fetchMcpsPart(params: {
  session: AgentSession | null
  blobId: Uint8Array
  allocateBlobId: () => number
}): AsyncGenerator<AgentServerMessage, FetchedMcpsPart | null, void> {
  if (!params.session) {
    logger.warn('[PROTOCOL] cannot fetch mcps blob without a session')
    return null
  }

  const requestId = params.allocateBlobId()
  yield kvGetBlob(requestId, params.blobId)

  const msg = yield* waitForMessageMatchingWithHeartbeat(
    params.session,
    (m) => {
      const kv = m.kvClientMessage as Record<string, unknown> | undefined
      if (!kv?.getBlobResult)
        return false
      // 优先按 id 匹配;客户端未回 id 时退化为"接受首个 getBlobResult"。
      // 本轮只会有这一个在途 getBlob 请求,不会串号。
      const id = kv.id
      return id === undefined || id === requestId
    },
    BLOB_FETCH_TIMEOUT_MS,
  )

  if (!msg) {
    logger.warn({ requestId }, '[PROTOCOL] mcps blob fetch timed out')
    return null
  }

  const blobData = extractBlobData(msg)
  if (!blobData) {
    logger.warn({ requestId }, '[PROTOCOL] mcps blob fetch returned no data')
    return null
  }

  try {
    const part = fromBinary(RequestContextMcpsPartSchema, blobData)
    const tools = (part.tools ?? []) as unknown as Array<Record<string, unknown>>
    logger.info({
      bytes: blobData.length,
      toolCount: tools.length,
      instructionCount: part.mcpInstructions?.length ?? 0,
      hasFsOptions: !!part.mcpFileSystemOptions,
      hasMetaToolOptions: !!part.mcpMetaToolOptions,
    }, '[PROTOCOL] mcps blob decoded — MCP tools recovered from ref_only transport')
    return {
      tools,
      mcpInstructions: (part.mcpInstructions ?? []) as unknown as Array<Record<string, unknown>>,
      mcpFileSystemOptions: part.mcpFileSystemOptions as unknown as Record<string, unknown> | undefined,
      mcpMetaToolOptions: part.mcpMetaToolOptions as unknown as Record<string, unknown> | undefined,
    }
  }
  catch (e) {
    logger.warn({ error: (e as Error).message, bytes: blobData.length },
      '[PROTOCOL] failed to decode RequestContextMcpsPart')
    return null
  }
}

/**
 * 把取回的 mcps Part 合入 ParsedRunRequest。
 *
 * 复用 parseRunRequest 的同一套规范化逻辑(工具名清洗 / inputSchema 归一 /
 * serverIdentifier 解析),避免两条路径产出不一致的工具表。
 */
export function applyMcpsPart(parsed: ParsedRunRequest, part: FetchedMcpsPart): void {
  // mcpServers / mcpBasePath — 来自 mcp_file_system_options
  const fsOpts = part.mcpFileSystemOptions
  const descriptors = (fsOpts?.mcpDescriptors as Array<Record<string, unknown>> | undefined) ?? []
  if (descriptors.length > 0) {
    parsed.mcpServers = descriptors.map(d => ({
      serverName: (d.serverName as string) ?? '',
      serverIdentifier: (d.serverIdentifier as string) ?? '',
      folderPath: (d.folderPath as string) ?? '',
      serverUseInstructions: (d.serverUseInstructions as string) ?? '',
    }))
    const basePath = (fsOpts?.workspaceProjectDir as string) ?? ''
    if (basePath)
      parsed.mcpBasePath = `${basePath}/mcps`
  }

  // mcpInstructions
  if (part.mcpInstructions.length > 0) {
    parsed.mcpInstructions = part.mcpInstructions.map(m => ({
      serverName: (m.serverName as string) ?? '',
      instructions: (m.instructions as string) ?? '',
      serverIdentifier: (m.serverIdentifier as string) ?? '',
    }))
  }

  // serverName → serverIdentifier 反查表 (与 parseRunRequest 同构)
  const serverIdentifierByName = new Map<string, string>()
  for (const src of [...parsed.mcpServers, ...parsed.mcpInstructions]) {
    if (src.serverName && src.serverIdentifier && !serverIdentifierByName.has(src.serverName))
      serverIdentifierByName.set(src.serverName, src.serverIdentifier)
  }

  // mcpTools
  const seenNames = new Set<string>()
  parsed.mcpTools = part.tools.map((t) => {
    const rawName = (t.name as string) ?? ''
    const normalizedName = normalizeMcpToolName(rawName, seenNames)
    seenNames.add(normalizedName)
    const providerIdentifier = (t.providerIdentifier as string) ?? ''
    const toolName = (t.toolName as string) ?? ''
    return {
      name: normalizedName,
      description: (t.description as string) ?? '',
      inputSchema: normalizeMcpInputSchema(t.inputSchema),
      providerIdentifier,
      toolName,
      serverIdentifier: resolveMcpServerIdentifier(rawName, toolName, providerIdentifier, serverIdentifierByName),
    }
  })

  logger.info({
    mcpTools: parsed.mcpTools.length,
    mcpServers: parsed.mcpServers.length,
    mcpInstructions: parsed.mcpInstructions.length,
  }, '[PROTOCOL] MCP context restored from mcps blob')
}

export { bytesEqual }
