import type { IdeFile, ParsedRunRequest } from './types'
import { logger } from '../../../logger'
import { emptyParsed } from './shared'

/** 解析 runRequest protobuf → ParsedRunRequest */
export function parseRunRequest(msg: Record<string, unknown>): ParsedRunRequest {
  const runRequest = msg.runRequest as Record<string, unknown> | undefined
  if (!runRequest) {
    return emptyParsed()
  }

  const action = runRequest.action as Record<string, unknown> | undefined
  const resumeAction = action?.resumeAction as Record<string, unknown> | undefined
  const isResume = !!resumeAction
  const isSummarize = !!action?.summarizeAction

  const userAction = action?.userMessageAction as Record<string, unknown> | undefined
  const userMessage = userAction?.userMessage as Record<string, unknown> | undefined
  // requestContext:userMessageAction 带一份,resumeAction 也带一份 (agent.v1.ResumeAction field 2)。
  // 多轮对话中每一轮都会重新推送,不能假设首轮装载一次就够。
  const requestContext = (userAction?.requestContext
    ?? resumeAction?.requestContext) as Record<string, unknown> | undefined
  const modelDetails = runRequest.modelDetails as Record<string, unknown> | undefined
  const requestedModel = runRequest.requestedModel as Record<string, unknown> | undefined

  // 打点: 记录客户端发来的模型相关字段, 定位 modelId 为空的根因
  logger.debug({
    'modelDetails.modelId': modelDetails?.modelId,
    'modelDetails.displayModelId': modelDetails?.displayModelId,
    'requestedModel.modelId': requestedModel?.modelId,
    hasModelDetails: !!modelDetails,
    hasRequestedModel: !!requestedModel,
    modelDetailsKeys: modelDetails ? Object.keys(modelDetails) : [],
    requestedModelKeys: requestedModel ? Object.keys(requestedModel) : [],
  }, '[AGENT] model field diagnosis')
  const conversationState = runRequest.conversationState as Record<string, unknown> | undefined
  const prependUserMessagesRaw = (
    (userAction?.prependUserMessages as Array<Record<string, unknown>> | undefined)
    ?? (runRequest.prependUserMessages as Array<Record<string, unknown>> | undefined)
    ?? []
  )

  // Debug: log conversationState — 判断客户端是否回传了完整 state
  //
  // 两种常见形态:
  //  1. rpmLen > 0: 客户端在 checkpoint roundtrip 里带回了历史, server 直接采用
  //  2. csKeys=[]:  客户端发空 → 新会话或 revert 后重置信号,
  //                  后续 agentOrchestrator 会检测 sqlite checkpoint 是否存在:
  //                    - 存在 → 清空 (revert 信号)
  //                    - 不存在 → 首次新会话, 维持空状态重建
  //  详见 analysis/checkpoint-revert-protocol.md
  const csKeys = conversationState ? Object.keys(conversationState) : []
  const rpmLen = (conversationState?.rootPromptMessagesJson as unknown[])?.length ?? 0
  const csMode = conversationState?.mode as string | undefined
  logger.debug({
    csKeys,
    rpmLen,
    csMode,
    turnsLen: (conversationState?.turns as unknown[])?.length ?? 0,
    csEmpty: csKeys.length === 0,
  }, rpmLen > 0
    ? '[SESSION] <<< CS RECV: client sent history (checkpoint roundtrip OK)'
    : '[SESSION] <<< CS RECV: empty (new session or revert; sqlite will be cleared if stale)',
  )

  // 提取用户消息附带的图片
  // Cursor 客户端 toJson() 后 oneof 展平为顶层字段:
  //   { blobIdWithData: { blobId: "base64", data: "base64" } }  — 最常见,含内联数据
  //   { data: "base64" }                                         — 纯内联数据
  //   { blobId: "base64" }                                       — 纯引用(无数据,暂不支持)
  // protobuf-es 原生 oneof 形态: { dataOrBlobId: { case, value } }  — 同时兼容
  const selectedContext = userMessage?.selectedContext as Record<string, unknown> | undefined
  const selectedImagesRaw = (selectedContext?.selectedImages as Array<Record<string, unknown>> | undefined) ?? []
  const selectedImages: Array<{ mimeType: string, data: string }> = []
  for (const img of selectedImagesRaw) {
    const mimeType = (img.mimeType as string) ?? 'image/png'
    let imageBase64 = ''

    // 形态 1: JSON 展平 — blobIdWithData 顶层字段 (Cursor 实际发送格式)
    const blobIdWithData = img.blobIdWithData as Record<string, unknown> | undefined
    if (blobIdWithData?.data) {
      const raw = blobIdWithData.data
      imageBase64 = raw instanceof Uint8Array ? Buffer.from(raw).toString('base64') : String(raw)
    }

    // 形态 2: JSON 展平 — data 顶层字段
    if (!imageBase64 && img.data && img.data !== img.blobIdWithData) {
      const raw = img.data
      imageBase64 = raw instanceof Uint8Array ? Buffer.from(raw).toString('base64') : String(raw)
    }

    // 形态 3: protobuf-es oneof — dataOrBlobId = { case, value }
    if (!imageBase64) {
      const dataOrBlobId = img.dataOrBlobId as { case?: string, value?: unknown } | undefined
      if (dataOrBlobId?.case === 'data' && dataOrBlobId.value) {
        imageBase64 = Buffer.from(dataOrBlobId.value as Uint8Array).toString('base64')
      }
      else if (dataOrBlobId?.case === 'blobIdWithData') {
        const nested = dataOrBlobId.value as Record<string, unknown>
        if (nested.data) {
          imageBase64 = Buffer.from(nested.data as Uint8Array).toString('base64')
        }
      }
    }

    if (imageBase64) {
      selectedImages.push({ mimeType, data: imageBase64 })
    }
    else {
      logger.warn({ uuid: img.uuid, keys: Object.keys(img) }, '[SESSION] skipping image: no inline data available')
    }
  }
  if (selectedImages.length > 0) {
    logger.info({ count: selectedImages.length, mimeTypes: selectedImages.map(i => i.mimeType) }, '[SESSION] extracted user images')
  }

  const env = requestContext?.env as Record<string, unknown> | undefined
  const rules = (requestContext?.rules as Array<Record<string, unknown>> | undefined) ?? []
  const tools = (requestContext?.tools as Array<Record<string, unknown>> | undefined) ?? []

  // 分类 rules
  const userRules: string[] = []
  const projectRules: Array<{ fullPath: string, content: string, glob?: string }> = []
  const agentSkillsFromRules: Array<{ fullPath: string, description: string }> = []

  for (const r of rules) {
    const ruleType = r.type as Record<string, unknown> | undefined
    const content = (r.content as string) ?? ''
    const fullPath = (r.fullPath as string) ?? ''

    if (ruleType?.global !== undefined) {
      // 用户全局规则
      userRules.push(content)
    }
    else if (ruleType?.agentFetched !== undefined) {
      // Agent Skills (通过 rules 通道传递)
      const af = ruleType.agentFetched as Record<string, unknown>
      agentSkillsFromRules.push({
        fullPath,
        description: (af.description as string) ?? '',
      })
    }
    else if (ruleType?.fileGlobbed !== undefined || ruleType?.manuallyAttached !== undefined) {
      // 文件/项目级别规则
      const fg = ruleType.fileGlobbed as Record<string, unknown> | undefined
      projectRules.push({
        fullPath,
        content,
        glob: fg?.glob as string | undefined,
      })
    }
    else {
      // 未知类型作为用户规则处理
      if (content)
        userRules.push(content)
    }
  }

  // agentSkills 字段 (可能和 rules 中的 agentFetched 重复,取并集)
  const agentSkillsField = (requestContext?.agentSkills as Array<Record<string, unknown>> | undefined) ?? []
  const skillPathSet = new Set(agentSkillsFromRules.map(s => s.fullPath))
  for (const s of agentSkillsField) {
    const fp = (s.fullPath as string) ?? ''
    if (fp && !skillPathSet.has(fp)) {
      agentSkillsFromRules.push({
        fullPath: fp,
        description: (s.description as string) ?? (s.name as string) ?? '',
      })
    }
  }

  // MCP 服务器配置
  // 官方客户端双写:AgentRunRequest.mcp_file_system_options (proto field 6) 和
  // requestContext.mcp_file_system_options (field 23) 内容等价,后者优先,前者兜底。
  const mcpFsOpts = (requestContext?.mcpFileSystemOptions
    ?? runRequest.mcpFileSystemOptions) as Record<string, unknown> | undefined
  const mcpDescriptors = (mcpFsOpts?.mcpDescriptors as Array<Record<string, unknown>> | undefined) ?? []
  const mcpBasePath = (mcpFsOpts?.workspaceProjectDir as string) ?? ''

  const mcpServers = mcpDescriptors.map(d => ({
    serverName: (d.serverName as string) ?? '',
    folderPath: (d.folderPath as string) ?? '',
    serverUseInstructions: (d.serverUseInstructions as string) ?? '',
  }))

  // MCP 工具 — 官方双写:AgentRunRequest.mcp_tools.mcp_tools[] (field 4) 和
  // requestContext.tools[] (field 7) 内容一致;合并去重 (按 name)。
  const topLevelMcpToolsBag = runRequest.mcpTools as Record<string, unknown> | undefined
  const topLevelMcpTools = (topLevelMcpToolsBag?.mcpTools as Array<Record<string, unknown>> | undefined) ?? []
  const mergedToolsByName = new Map<string, Record<string, unknown>>()
  for (const t of tools) {
    const name = (t.name as string) ?? ''
    if (name)
      mergedToolsByName.set(name, t)
  }
  for (const t of topLevelMcpTools) {
    const name = (t.name as string) ?? ''
    if (name && !mergedToolsByName.has(name))
      mergedToolsByName.set(name, t)
  }
  const mergedMcpTools = Array.from(mergedToolsByName.values())

  // MCP 使用说明 (requestContext.mcp_instructions, proto field 14)
  const mcpInstructionsRaw = (requestContext?.mcpInstructions as Array<Record<string, unknown>> | undefined) ?? []
  const mcpInstructions = mcpInstructionsRaw.map(m => ({
    serverName: (m.serverName as string) ?? '',
    instructions: (m.instructions as string) ?? '',
    serverIdentifier: (m.serverIdentifier as string) ?? '',
  }))

  // IDE 状态 (selectedContext.invocation_context.ide_state)
  const invocationContext = selectedContext?.invocationContext as Record<string, unknown> | undefined
  const ideStateRaw = invocationContext?.ideState as Record<string, unknown> | undefined
  const mapIdeFiles = (raw: Array<Record<string, unknown>> | undefined): IdeFile[] => {
    if (!raw)
      return []
    return raw.map((f) => {
      const cursor = f.cursorPosition as Record<string, unknown> | undefined
      return {
        path: (f.path as string) ?? '',
        relativePath: f.relativePath as string | undefined,
        totalLines: Number(f.totalLines) || 0,
        activeCommand: f.activeCommand as string | undefined,
        cursorLine: cursor?.line !== undefined ? Number(cursor.line) : undefined,
        cursorText: cursor?.text as string | undefined,
      }
    })
  }
  const ideState = ideStateRaw
    ? {
        visibleFiles: mapIdeFiles(ideStateRaw.visibleFiles as Array<Record<string, unknown>> | undefined),
        recentlyViewedFiles: mapIdeFiles(ideStateRaw.recentlyViewedFiles as Array<Record<string, unknown>> | undefined),
      }
    : undefined

  // Documentations (selectedContext.documentations) — 只含 docId + name,正文需客户端之后补
  const documentationsRaw = (selectedContext?.documentations as Array<Record<string, unknown>> | undefined) ?? []
  const documentations = documentationsRaw.map(d => ({
    docId: (d.docId as string) ?? '',
    name: (d.name as string) ?? '',
  }))

  // Cursor Commands (selectedContext.cursor_commands) — 用户触发的 /command
  const cursorCommandsRaw = (selectedContext?.cursorCommands as Array<Record<string, unknown>> | undefined) ?? []
  const cursorCommands = cursorCommandsRaw.map(c => ({
    name: (c.name as string) ?? '',
    content: (c.content as string) ?? '',
  }))

  // Selected Skills (selectedContext.selected_skills) — 手动 @ 的 skill,区别于 requestContext.agent_skills 的全量
  const selectedSkillsRaw = (selectedContext?.selectedSkills as Array<Record<string, unknown>> | undefined) ?? []
  const selectedSkills = selectedSkillsRaw.map(s => ({
    fullPath: (s.fullPath as string) ?? '',
    description: (s.description as string) ?? (s.content as string) ?? '',
  }))

  // Extra Context Entries — oneof { data, blob_id }。本步只记录原始形态,
  // blobId 形态的取回留给 Step 4 (通过 blob store 解包)。
  const extraContextEntriesRaw = (selectedContext?.extraContextEntries as Array<Record<string, unknown>> | undefined) ?? []
  const extraContextEntries = extraContextEntriesRaw.map((e) => {
    // JSON 展平形态:{ data: "..." } 或 { blobId: "base64-bytes" }
    if (typeof e.data === 'string') {
      return { data: e.data }
    }
    if (e.blobId) {
      const raw = e.blobId
      const blobId = raw instanceof Uint8Array
        ? Buffer.from(raw).toString('utf-8')
        : typeof raw === 'string'
          ? (() => { try { return Buffer.from(raw, 'base64').toString('utf-8') } catch { return raw } })()
          : ''
      return { blobId }
    }
    // protobuf-es oneof 形态:{ dataOrBlobId: { case, value } }
    const dob = e.dataOrBlobId as { case?: string, value?: unknown } | undefined
    if (dob?.case === 'data' && typeof dob.value === 'string') {
      return { data: dob.value }
    }
    if (dob?.case === 'blobId' && dob.value) {
      const blobId = dob.value instanceof Uint8Array
        ? Buffer.from(dob.value).toString('utf-8')
        : String(dob.value)
      return { blobId }
    }
    return {}
  }).filter(e => e.data || e.blobId)

  // Git 仓库信息 — requestContext.git_repos (proto field 11),不在 env 下
  const gitReposRaw = (requestContext?.gitRepos as Array<Record<string, unknown>> | undefined) ?? []
  const gitRepos = gitReposRaw.map(g => ({
    path: (g.path as string) ?? '',
    status: (g.status as string) ?? '',
    branchName: (g.branchName as string) ?? '',
  }))

  return {
    userText: (userMessage?.text as string) ?? '',
    // 优先 requestedModel (新 field 9), fallback modelDetails (旧 field 3)
    modelId: (requestedModel?.modelId as string) || (modelDetails?.modelId as string) || '',
    conversationId: (runRequest.conversationId as string) ?? '',
    mode: (userMessage?.mode as string) ?? 'AGENT_MODE_AGENT',
    isSummarize,
    userRules,
    projectRules,
    agentSkills: agentSkillsFromRules,
    env: {
      osVersion: env?.osVersion as string | undefined,
      shell: env?.shell as string | undefined,
      workspacePaths: env?.workspacePaths as string[] | undefined,
      timeZone: env?.timeZone as string | undefined,
      terminalsFolder: env?.terminalsFolder as string | undefined,
      agentTranscriptsFolder: env?.agentTranscriptsFolder as string | undefined,
      agentSharedNotesFolder: env?.agentSharedNotesFolder as string | undefined,
      agentConversationNotesFolder: env?.agentConversationNotesFolder as string | undefined,
      projectFolder: env?.projectFolder as string | undefined,
      sandboxSupported: env?.sandboxSupported as boolean | undefined,
    },
    gitRepos: gitRepos.length > 0 ? gitRepos : undefined,
    isGitRepo: gitRepos.length > 0,
    mcpServers,
    mcpBasePath: mcpBasePath ? `${mcpBasePath}/mcps` : '',
    mcpTools: (() => {
      const seenNames = new Set<string>()
      return mergedMcpTools.map((t) => {
        const rawName = (t.name as string) ?? ''
        const normalizedName = normalizeMcpToolName(rawName, seenNames)
        seenNames.add(normalizedName)
        if (normalizedName !== rawName) {
          logger.debug(
            { raw: rawName, normalized: normalizedName },
            '[PROTOCOL] MCP tool name sanitized to match Anthropic pattern',
          )
        }
        return {
          name: normalizedName,
          description: (t.description as string) ?? '',
          inputSchema: normalizeMcpInputSchema(t.inputSchema),
          providerIdentifier: (t.providerIdentifier as string) ?? '',
          toolName: (t.toolName as string) ?? '',
        }
      })
    })(),
    mcpInstructions,
    ideState,
    documentations,
    cursorCommands,
    selectedSkills,
    extraContextEntries,
    webSearchEnabled: (requestContext?.webSearchEnabled as boolean) ?? false,
    webFetchEnabled: (requestContext?.webFetchEnabled as boolean) ?? false,
    readLintsEnabled: (requestContext?.readLintsEnabled as boolean) ?? false,
    // rootPromptMessagesJson 包含对话历史的所有 blob IDs。
    // ConversationStateStructure (checkpoint) 中是 bytes[] (T:12),
    // ConversationState (runRequest) 中是 string[] (T:9)。
    // protobuf-es 将 bytes → string 时做了 base64 encode,
    // 所以收到的 string 需要 base64 decode 还原为原始 blobId。
    historyBlobIds: (() => {
      const raw = conversationState?.rootPromptMessagesJson
      if (!raw || !Array.isArray(raw))
        return []
      const ids = raw.map((v: unknown) => {
        if (typeof v !== 'string')
          return String(v)
        // base64 decode: Server 存入 TextEncoder.encode(blobId) → bytes,
        // Client 回传时 protobuf-es 对 bytes 做 base64 → 这里 decode 还原
        try {
          return Buffer.from(v, 'base64').toString('utf-8')
        }
        catch {
          return v
        }
      })
      if (ids.length > 0) {
        logger.debug({ first: ids[0], count: ids.length }, '[SESSION] historyBlobIds extracted')
      }
      return ids
    })(),
    historyTurns: ((conversationState?.turns as string[]) ?? []),
    historySummaryArchiveIds: (() => {
      const raw = conversationState?.summaryArchives
      if (!raw || !Array.isArray(raw))
        return []
      return raw.map((v: unknown) => {
        if (typeof v !== 'string')
          return String(v)
        try {
          return Buffer.from(v, 'base64').toString('utf-8')
        }
        catch {
          return v
        }
      })
    })(),
    historyTokenDetails: (() => {
      const tokenDetails = conversationState?.tokenDetails as Record<string, unknown> | undefined
      if (!tokenDetails)
        return undefined
      const usedTokens = Number(tokenDetails.usedTokens)
      const maxTokens = Number(tokenDetails.maxTokens)
      if (!Number.isFinite(usedTokens) || !Number.isFinite(maxTokens))
        return undefined
      return { usedTokens, maxTokens }
    })(),
    selectedImages,
    prependUserMessages: prependUserMessagesRaw
      .map(entry => ({
        text: typeof entry.text === 'string' ? entry.text : '',
        messageId: typeof entry.messageId === 'string' ? entry.messageId : undefined,
      }))
      .filter(entry => entry.text.length > 0),
    isResume,
    conversationNotesListing: (requestContext?.conversationNotesListing as string) ?? '',
    sharedNotesListing: (requestContext?.sharedNotesListing as string) ?? '',
  }
}

/**
 * 规范化 MCP 工具名以匹配 Anthropic tools 的 name pattern: ^[a-zA-Z0-9_-]+$
 *
 * MCP server 下发的工具名经常带 `.` / `:` / `/` / 空格 / 非 ASCII,会触发
 * provider 400 "tools[N].name: string does not match pattern"。
 *
 * 这里把所有非法字符替换为 `_`,合并连续下划线、修剪首尾下划线;空或首字符被
 * 修没的回退到 `mcp_tool`;冲突时追加 _2 / _3 / ... 保证一批工具内唯一。
 *
 * 注意:只 normalize 用作 LLM tools schema 的 name;providerIdentifier 与
 * toolName 保持原样,因为那两个字段用来把 tool_call 回路回客户端 mcpService
 * 做真实路由。
 */
function normalizeMcpToolName(raw: string, seen: Set<string>): string {
  let base = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!base)
    base = 'mcp_tool'
  if (!seen.has(base))
    return base
  let i = 2
  while (seen.has(`${base}_${i}`))
    i++
  return `${base}_${i}`
}

/**
 * 把 McpToolDefinition.inputSchema 规范成标准 JSON Schema object。
 *
 * 客户端 (@bufbuild/protobuf) 在 toJson 后 google.protobuf.Value 常见为普通 JSON,
 * 但偶尔仍会以 Value-wrapped 形态下发 (如 { structValue: { fields: {...} } }),
 * 这时 LLM 的 tools schema 会报无效 JSON Schema。
 *
 * 防御性地 unwrap 一层,并确保输出至少是 object 形态以通过 provider 侧校验。
 */
function normalizeMcpInputSchema(raw: unknown): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object')
    return { type: 'object' }
  const obj = raw as Record<string, unknown>

  // 已是标准 JSON Schema: { type, properties?, ... }
  if (typeof obj.type === 'string' || obj.properties || obj.$schema)
    return obj

  // google.protobuf.Value 形态: { structValue: { fields: { ... } } }
  const structValue = obj.structValue as Record<string, unknown> | undefined
  if (structValue) {
    const fields = (structValue.fields as Record<string, unknown> | undefined) ?? structValue
    return { type: 'object', properties: unwrapProtoValueFields(fields) }
  }

  // google.protobuf.Struct 形态: { fields: { ... } }
  if (obj.fields && typeof obj.fields === 'object')
    return { type: 'object', properties: unwrapProtoValueFields(obj.fields as Record<string, unknown>) }

  // 其他未知形态直接返回,让 provider 报错 (比伪造 schema 更可诊断)
  return obj
}

/** 把 google.protobuf.Struct.fields 中每个 Value 递归 unwrap 为裸值 */
function unwrapProtoValueFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields))
    out[k] = unwrapProtoValue(v)
  return out
}

function unwrapProtoValue(v: unknown): unknown {
  if (v == null || typeof v !== 'object')
    return v
  const obj = v as Record<string, unknown>
  if ('stringValue' in obj) return obj.stringValue
  if ('numberValue' in obj) return obj.numberValue
  if ('boolValue' in obj) return obj.boolValue
  if ('nullValue' in obj) return null
  if (obj.listValue && typeof obj.listValue === 'object') {
    const values = (obj.listValue as Record<string, unknown>).values as unknown[] | undefined
    return Array.isArray(values) ? values.map(unwrapProtoValue) : []
  }
  if (obj.structValue && typeof obj.structValue === 'object') {
    const fields = (obj.structValue as Record<string, unknown>).fields as Record<string, unknown> | undefined
    return fields ? unwrapProtoValueFields(fields) : {}
  }
  return v
}
