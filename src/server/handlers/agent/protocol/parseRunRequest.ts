import type { ParsedRunRequest } from './types'
import { logger } from '../../../logger'
import { emptyParsed } from './shared'

/** 解析 runRequest protobuf → ParsedRunRequest */
export function parseRunRequest(msg: Record<string, unknown>): ParsedRunRequest {
  const runRequest = msg.runRequest as Record<string, unknown> | undefined
  if (!runRequest) {
    return emptyParsed()
  }

  const action = runRequest.action as Record<string, unknown> | undefined
  const isResume = !!action?.resumeAction
  const isSummarize = !!action?.summarizeAction

  const userAction = action?.userMessageAction as Record<string, unknown> | undefined
  const userMessage = userAction?.userMessage as Record<string, unknown> | undefined
  const requestContext = userAction?.requestContext as Record<string, unknown> | undefined
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
  const mcpFsOpts = requestContext?.mcpFileSystemOptions as Record<string, unknown> | undefined
  const mcpDescriptors = (mcpFsOpts?.mcpDescriptors as Array<Record<string, unknown>> | undefined) ?? []
  const mcpBasePath = (mcpFsOpts?.workspaceProjectDir as string) ?? ''

  const mcpServers = mcpDescriptors.map(d => ({
    serverName: (d.serverName as string) ?? '',
    folderPath: (d.folderPath as string) ?? '',
    serverUseInstructions: (d.serverUseInstructions as string) ?? '',
  }))

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
    mcpTools: tools.map(t => ({
      name: (t.name as string) ?? '',
      description: (t.description as string) ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
      providerIdentifier: (t.providerIdentifier as string) ?? '',
      toolName: (t.toolName as string) ?? '',
    })),
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
