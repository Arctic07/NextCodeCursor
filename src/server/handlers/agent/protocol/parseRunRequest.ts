import type { IdeFile, ParsedRunRequest } from './types'
import { listKnowledgeItems } from '../../../config/knowledgeBaseStore'
import { logger } from '../../../logger'
import { emptyParsed } from './shared'

type ParsedBackgroundTaskCompletion = {
  taskId: string
  kind: string
  status: string
  title: string
  detail?: string
  outputPath?: string
  threadId?: string
}

function normalizeBackgroundTaskKind(value: unknown): string {
  if (typeof value === 'number') {
    if (value === 1) return 'shell'
    if (value === 2) return 'subagent'
  }
  const text = String(value ?? '').toLowerCase()
  if (text.includes('shell')) return 'shell'
  if (text.includes('subagent')) return 'subagent'
  return 'unspecified'
}

function normalizeBackgroundTaskStatus(value: unknown): string {
  if (typeof value === 'number') {
    if (value === 1) return 'success'
    if (value === 2) return 'error'
    if (value === 3) return 'aborted'
  }
  const text = String(value ?? '').toLowerCase()
  if (text.includes('success')) return 'success'
  if (text.includes('error')) return 'error'
  if (text.includes('abort')) return 'aborted'
  return text || 'unspecified'
}

function parseBackgroundTaskCompletions(action: Record<string, unknown> | undefined): ParsedBackgroundTaskCompletion[] {
  const backgroundAction = action?.backgroundTaskCompletionAction as Record<string, unknown> | undefined
  const completions = (backgroundAction?.completions as Array<Record<string, unknown>> | undefined) ?? []
  return completions.map(c => ({
    taskId: String(c.taskId ?? ''),
    kind: normalizeBackgroundTaskKind(c.kind),
    status: normalizeBackgroundTaskStatus(c.status),
    title: String(c.title ?? ''),
    ...(typeof c.detail === 'string' ? { detail: c.detail } : {}),
    ...(typeof c.outputPath === 'string' ? { outputPath: c.outputPath } : {}),
    ...(typeof c.threadId === 'string' ? { threadId: c.threadId } : {}),
  }))
}

function formatBackgroundTaskCompletionMessage(completions: ParsedBackgroundTaskCompletion[]): string {
  const blocks = completions.map((c, index) => {
    const lines = [
      `kind: ${c.kind}`,
      c.taskId ? `task_id: ${c.taskId}` : undefined,
      `status: ${c.status}`,
      c.title ? `title: ${c.title}` : undefined,
      c.outputPath ? `output_path: ${c.outputPath}` : undefined,
      c.threadId ? `thread_id: ${c.threadId}` : undefined,
      'response:',
      '<response>',
      c.detail?.trim() || 'No output',
      '</response>',
    ].filter((line): line is string => line !== undefined)
    return completions.length > 1 ? `task_completion_${index + 1}:\n${lines.join('\n')}` : lines.join('\n')
  })

  return `<system_reminder>
Do not reiterate or repeat the contents of this agent notification to the user unless asked to do so.

Follow your instructions for Handling subagent notifications.
</system_reminder>

<agent_notification>
${blocks.join('\n\n')}
</agent_notification>`
}

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
  const backgroundTaskCompletions = parseBackgroundTaskCompletions(action)
  const isBackgroundTaskCompletion = backgroundTaskCompletions.length > 0
  // 子代理判定: subagentTypeName 由客户端在创建 subagent RunSSE 时设置
  // conversationGroupId 在 toJson() 后被 proto 丢弃 (非 schema field)
  const subagentTypeName = runRequest.subagentTypeName as string | undefined
  const isSubagent = typeof subagentTypeName === 'string' && subagentTypeName.length > 0

  if (isBackgroundTaskCompletion) {
    logger.info({
      count: backgroundTaskCompletions.length,
      completions: backgroundTaskCompletions.map(c => ({
        taskId: c.taskId, kind: c.kind, status: c.status, detailLen: c.detail?.length ?? 0,
      })),
    }, '[AGENT] backgroundTaskCompletion parsed');
  }

  logger.debug({
    actionKeys: action ? Object.keys(action) : [],
    isSummarize, isResume, isSubagent, isBackgroundTaskCompletion,
    backgroundTaskCompletionCount: backgroundTaskCompletions.length,
    runRequestTopKeys: Object.keys(runRequest).filter(k => !['conversationState', 'action', 'modelDetails', 'mcpTools'].includes(k)),
  }, '[AGENT] action diagnosis')

  // executePlanAction: Build 按钮触发 (Plan 确认后执行)
  // Proto: ExecutePlanAction { request_context, plan, plan_file_uri, plan_file_content, execution_mode }
  const executePlanAction = action?.executePlanAction as Record<string, unknown> | undefined
  const isExecutePlan = !!executePlanAction

  const userAction = action?.userMessageAction as Record<string, unknown> | undefined
  const userMessage = userAction?.userMessage as Record<string, unknown> | undefined
  // requestContext: userMessageAction / resumeAction / executePlanAction 都可能带一份。
  // 多轮对话中每一轮都会重新推送,不能假设首轮装载一次就够。
  const requestContext = (userAction?.requestContext
    ?? resumeAction?.requestContext
    ?? executePlanAction?.requestContext) as Record<string, unknown> | undefined
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

  // 诊断打点:每条 rule 的 keys + type 子对象 keys + source, 看清客户端下发形态。
  // User Rules (设置里填的) vs Project Rules (.cursor/rules/*.mdc) 在 type.oneof
  // 上应当分别是 { global: {} } / { fileGlobbed: { globs: [...] } } 等。
  if (rules.length > 0) {
    logger.debug({
      count: rules.length,
      samples: rules.slice(0, 5).map(r => ({
        keys: Object.keys(r),
        typeKeys: r.type && typeof r.type === 'object' ? Object.keys(r.type as Record<string, unknown>) : typeof r.type,
        source: r.source,
        fullPath: r.fullPath,
        contentPreview: typeof r.content === 'string' ? r.content.slice(0, 60) : typeof r.content,
      })),
    }, '[AGENT] rules diagnosis')
  }

  // 分类 rules
  const userRules: string[] = []
  const projectRules: Array<{ fullPath: string, content: string, glob?: string }> = []
  const agentSkillsFromRules: Array<{ fullPath: string, description: string }> = []

  // 判断 oneof 分支是否"命中":
  // - toJson 展平形态: 字段存在即选中 (value 可能是 {}、对象、或非 null)
  // - protobuf-es 原生 oneof 形态: ruleType.type === { case: 'global', value: ... }
  const isOneofCase = (ruleType: Record<string, unknown> | undefined, name: string): boolean => {
    if (!ruleType)
      return false
    // 展平形态: 字段存在 且 非 null/undefined
    if (name in ruleType && ruleType[name] != null)
      return true
    // 原生 oneof: ruleType.type = { case, value }
    const inner = ruleType.type as { case?: string } | undefined
    if (inner?.case === name)
      return true
    return false
  }

  const getOneofValue = (ruleType: Record<string, unknown> | undefined, name: string): Record<string, unknown> | undefined => {
    if (!ruleType)
      return undefined
    if (name in ruleType && ruleType[name] && typeof ruleType[name] === 'object')
      return ruleType[name] as Record<string, unknown>
    const inner = ruleType.type as { case?: string, value?: unknown } | undefined
    if (inner?.case === name && inner.value && typeof inner.value === 'object')
      return inner.value as Record<string, unknown>
    return undefined
  }

  for (const r of rules) {
    const ruleType = r.type as Record<string, unknown> | undefined
    const content = (r.content as string) ?? ''
    const fullPath = (r.fullPath as string) ?? ''

    if (isOneofCase(ruleType, 'global')) {
      // 用户全局规则 (包括设置页填写的 User Rules)
      if (content)
        userRules.push(content)
    }
    else if (isOneofCase(ruleType, 'agentFetched')) {
      // Agent Skills (通过 rules 通道传递)
      const af = getOneofValue(ruleType, 'agentFetched')
      agentSkillsFromRules.push({
        fullPath,
        description: (af?.description as string) ?? '',
      })
    }
    else if (isOneofCase(ruleType, 'fileGlobbed') || isOneofCase(ruleType, 'manuallyAttached')) {
      // 文件/项目级别规则 (proto field 为 repeated string, 兼容单值 glob)
      const fg = getOneofValue(ruleType, 'fileGlobbed')
      const globs = fg?.globs as string[] | string | undefined
      projectRules.push({
        fullPath,
        content,
        glob: Array.isArray(globs) ? globs.join(', ') : globs,
      })
    }
    else {
      // 未知类型: 通过文件路径判断是否为 skill
      // Cursor 3.1.17 中 skill 的 type 可能为空对象 {},
      // 不匹配 agentFetched, 但路径为 SKILL.md → 应作为 skill 处理
      if (fullPath.endsWith('/SKILL.md') || fullPath.endsWith('\\SKILL.md')) {
        const desc = extractSkillDescription(content)
        agentSkillsFromRules.push({ fullPath, description: desc })
      }
      else if (content) {
        userRules.push(content)
      }
    }
  }

  // 合入本地 KnowledgeBase items (Cursor 设置页 "User Rules")。
  // 官方客户端不会把这些塞进 requestContext.rules,而是靠官方服务端
  // 从用户账户侧读出 knowledgeBase 后自行注入 system prompt。BYOK 在
  // 这里复刻同样的行为 — 读本地 knowledge-base.json,合入 userRules。
  //
  // 去重策略:以 content 判重,避免用户既在设置页填了又在 .cursor/rules 下写同名规则导致双份。
  try {
    const kbItems = listKnowledgeItems()
    if (kbItems.length > 0) {
      const existing = new Set(userRules.map(s => s.trim()))
      let injected = 0
      for (const it of kbItems) {
        const body = (it.knowledge ?? '').trim()
        if (!body || existing.has(body))
          continue
        userRules.push(it.knowledge)
        existing.add(body)
        injected++
      }
      if (injected > 0) {
        logger.debug({ injected, total: kbItems.length }, '[AGENT] knowledge-base items injected into userRules')
      }
    }
  }
  catch (err) {
    logger.warn({ error: (err as Error).message }, '[AGENT] knowledge-base injection failed (continuing)')
  }

  logger.debug({
    userRulesCount: userRules.length,
    projectRulesCount: projectRules.length,
    agentSkillsCount: agentSkillsFromRules.length,
  }, '[AGENT] rules classified')

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
  // description 不 fallback 到 content (全文) — 避免把完整 SKILL.md body 当 description 注入
  const selectedSkillsRaw = (selectedContext?.selectedSkills as Array<Record<string, unknown>> | undefined) ?? []
  const selectedSkills = selectedSkillsRaw.map(s => ({
    fullPath: (s.fullPath as string) ?? '',
    description: (s.description as string) ?? (s.name as string) ?? '',
  }))

  // ── SelectedContext 扩展字段 (客户端已 gather,server 注入 LLM) ──
  //
  // 注: 5 个 git 字段 (gitDiff / gitDiffFromBranchToMain / gitCommits /
  //   gitPrDiffSelections / selectedPullRequests) 已刻意跳过 — 官方有
  //   StreamDiffReview / SummarizeWithReferences 专用后端 pipeline,
  //   BYOK 直接注入原始数据会爆 context 或无效。改为让 LLM 主动用 Shell
  //   tool 查 git (与 Claude Code 工具优先哲学一致)。

  // codeSelections (field 5) — 用户框选代码,Range 采用 agent.v1.Range (start/end
  // 均为 Position{line,column})。JSON 展平后 range.start.line / start.column 路径一致。
  const codeSelectionsRaw = (selectedContext?.codeSelections as Array<Record<string, unknown>> | undefined) ?? []
  const codeSelections = codeSelectionsRaw.map((cs) => {
    const range = cs.range as Record<string, unknown> | undefined
    const start = range?.start as Record<string, unknown> | undefined
    const end = range?.end as Record<string, unknown> | undefined
    return {
      content: (cs.content as string) ?? '',
      path: (cs.path as string) ?? '',
      relativePath: cs.relativePath as string | undefined,
      range: range
        ? {
            startLine: Number(start?.line ?? 0),
            startCol: Number(start?.column ?? 0),
            endLine: Number(end?.line ?? 0),
            endCol: Number(end?.column ?? 0),
          }
        : undefined,
    }
  }).filter(cs => cs.content.length > 0)

  // terminalSelections (field 7) — 用户框选终端输出,结构同 codeSelections + title
  const terminalSelectionsRaw = (selectedContext?.terminalSelections as Array<Record<string, unknown>> | undefined) ?? []
  const terminalSelections = terminalSelectionsRaw.map((ts) => {
    const range = ts.range as Record<string, unknown> | undefined
    const start = range?.start as Record<string, unknown> | undefined
    const end = range?.end as Record<string, unknown> | undefined
    return {
      content: (ts.content as string) ?? '',
      title: ts.title as string | undefined,
      path: ts.path as string | undefined,
      range: range
        ? {
            startLine: Number(start?.line ?? 0),
            startCol: Number(start?.column ?? 0),
            endLine: Number(end?.line ?? 0),
            endCol: Number(end?.column ?? 0),
          }
        : undefined,
    }
  }).filter(ts => ts.content.length > 0)

  // requestContext.file_contents (proto field 20) — @ 整个文件的真实通道
  // map<string, string> 在 protobuf-es toJson 后是普通对象 { path: content }
  // 注:这个字段在 requestContext 下,不是 selectedContext 下
  const fileContentsRaw = requestContext?.fileContents as Record<string, unknown> | undefined
  const fileContents: Record<string, string> = {}
  if (fileContentsRaw && typeof fileContentsRaw === 'object') {
    for (const [k, v] of Object.entries(fileContentsRaw)) {
      if (typeof v === 'string' && v.length > 0)
        fileContents[k] = v
    }
  }

  // requestContext.project_layouts (proto field 13) — @ Folder 的目录树
  // repeated LsDirectoryTreeNode,递归结构 { path, files, subfolders }
  // 原样保留给 messageBuilder 决定如何渲染,不在 server 侧展开避免 token 失控
  const projectLayoutsRaw = (requestContext?.projectLayouts as Array<Record<string, unknown>> | undefined) ?? []
  const projectLayouts = projectLayoutsRaw.filter(n => n && typeof n === 'object')

  // externalLinks (field 9) — 普通链接 + PDF。pdfContent 是已解析的文本;
  // blob_id 分支暂不支持(与 extraContext blob 一样等 Step 4 blob store)
  const externalLinksRaw = (selectedContext?.externalLinks as Array<Record<string, unknown>> | undefined) ?? []
  const externalLinks = externalLinksRaw.map(el => ({
    url: (el.url as string) ?? '',
    uuid: (el.uuid as string) ?? '',
    filename: el.filename as string | undefined,
    isPdf: (el.isPdf as boolean) ?? false,
    pdfContent: el.pdfContent as string | undefined,
  })).filter(el => el.url.length > 0)

  // selectedSubagents (field 22) — 用户 @ 的 subagent,只有 name
  const selectedSubagentsRaw = (selectedContext?.selectedSubagents as Array<Record<string, unknown>> | undefined) ?? []
  const selectedSubagents = selectedSubagentsRaw.map(s => ({
    name: (s.name as string) ?? '',
  })).filter(s => s.name.length > 0)

  // selectedBrowsers (field 24) — Cursor 浏览器集成,@ 的页面
  const selectedBrowsersRaw = (selectedContext?.selectedBrowsers as Array<Record<string, unknown>> | undefined) ?? []
  const selectedBrowsers = selectedBrowsersRaw.map(b => ({
    browserId: (b.browserId as string) ?? '',
    url: (b.url as string) ?? '',
    pageTitle: b.pageTitle as string | undefined,
  })).filter(b => b.url.length > 0)

  // recentAgentsContext (field 27) — 最近 N 个对话摘要。Proto 层是 oneof wrapper:
  // { recent_agents_context: { recent_agents: [...] } }
  const recentAgentsContextRaw = selectedContext?.recentAgentsContext as Record<string, unknown> | undefined
  const recentAgentsRaw = (recentAgentsContextRaw?.recentAgents as Array<Record<string, unknown>> | undefined) ?? []
  const recentAgentsContext = recentAgentsRaw.map(a => ({
    name: (a.name as string) ?? '',
    path: (a.path as string) ?? '',
    overview: a.overview as string | undefined,
  })).filter(a => a.name.length > 0)

  // 诊断打点:两处 context 下各字段发来什么 keys + 各字段实际 parse 到多少条
  // 用于持续观察客户端真实字段分布,定位"@ 菜单 → proto 字段"的真实映射。
  logger.debug({
    // ── userMessage.selectedContext 下的字段 ──
    selectedContextKeys: selectedContext ? Object.keys(selectedContext) : [],
    codeSelections: codeSelections.length,
    terminalSelections: terminalSelections.length,
    externalLinks: externalLinks.length,
    selectedSubagents: selectedSubagents.length,
    selectedBrowsers: selectedBrowsers.length,
    recentAgentsContext: recentAgentsContext.length,
    pastChatsInCodeSelections: codeSelections.filter(cs => cs.path.includes('agent-transcripts')).length,
    gitDiff: !!selectedContext?.gitDiff,
    gitDiffFromBranchToMain: !!selectedContext?.gitDiffFromBranchToMain,
    gitCommits: ((selectedContext?.gitCommits as unknown[]) ?? []).length,
    // ── userMessageAction.requestContext 下的字段 (新发现:@ File / @ Folder 走这里) ──
    requestContextKeys: requestContext ? Object.keys(requestContext) : [],
    fileContentsCount: Object.keys(fileContents).length,
    fileContentsTotalBytes: Object.values(fileContents).reduce((a, b) => a + b.length, 0),
    projectLayoutsCount: projectLayouts.length,
  }, '[AGENT] selectedContext diagnosis')

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

  // executePlanAction: Build 按钮点击后,客户端发 planFileContent(plan 全文)
  // 作为 userText 注入,让 LLM 在 Agent 模式下按 plan 执行
  const planContent = (executePlanAction?.planFileContent as string) ?? ''
  const planFileUri = (executePlanAction?.planFileUri as string) ?? ''
  const baseUserText = (userMessage?.text as string) ?? ''
  const backgroundTaskCompletionText = isBackgroundTaskCompletion
    ? formatBackgroundTaskCompletionMessage(backgroundTaskCompletions)
    : ''

  // 解析 RequestedModel.parameters[] — 客户端运行时 thinking 配置
  const requestedParams = (requestedModel?.parameters as Array<{ id: string, value: string }>) ?? []
  const paramMap = new Map(requestedParams.map(p => [p.id, p.value]))
  const clientThinking = paramMap.has('thinking') ? paramMap.get('thinking') === 'true' : undefined
  const clientThinkingLevel = paramMap.get('level') || undefined
  const clientThinkingBudgetRaw = paramMap.get('budget')
  const clientThinkingBudget = clientThinkingBudgetRaw ? Number(clientThinkingBudgetRaw) : undefined
  const clientContextTokenLimitRaw = paramMap.get('context')
  const clientContextTokenLimit = clientContextTokenLimitRaw ? Number(clientContextTokenLimitRaw) : undefined

  if (requestedParams.length > 0) {
    logger.debug({ parameters: Object.fromEntries(paramMap) }, '[AGENT] client thinking parameters')
  }

  return {
    userText: isExecutePlan && planContent
      ? `Execute the following plan:\n\n${planContent}`
      : isBackgroundTaskCompletion
        ? backgroundTaskCompletionText
        : baseUserText,
    modelId: (requestedModel?.modelId as string) || (modelDetails?.modelId as string) || '',
    conversationId: (runRequest.conversationId as string) ?? '',
    contextTokenLimit: clientContextTokenLimit && Number.isFinite(clientContextTokenLimit) && clientContextTokenLimit > 0
      ? Math.floor(clientContextTokenLimit)
      : undefined,
    mode: (userMessage?.mode as string) ?? 'AGENT_MODE_AGENT',
    isSummarize,
    isSubagent,
    isBackgroundTaskCompletion,
    backgroundTaskCompletions,
    clientThinking,
    clientThinkingLevel,
    clientThinkingBudget: clientThinkingBudget && Number.isFinite(clientThinkingBudget) ? clientThinkingBudget : undefined,
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
    codeSelections,
    terminalSelections,
    fileContents,
    projectLayouts,
    externalLinks,
    selectedSubagents,
    selectedBrowsers,
    recentAgentsContext,
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
    historyTurnBlobIds: (() => {
      const raw = conversationState?.turns
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
    historyTurns: (() => {
      const raw = conversationState?.turns
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
    rawUserMessage: userMessage ? { ...userMessage } : undefined,
    selectedImages,
    prependUserMessages: prependUserMessagesRaw
      .map(entry => ({
        text: typeof entry.text === 'string' ? entry.text : '',
        messageId: typeof entry.messageId === 'string' ? entry.messageId : undefined,
      }))
      .filter(entry => entry.text.length > 0),
    isResume,
    isExecutePlan,
    executePlanContent: planContent || undefined,
    executePlanFileUri: planFileUri || undefined,
    debugModeConfig: (() => {
      const dmc = requestContext?.debugModeConfig as Record<string, unknown> | undefined
      if (!dmc) return undefined
      return {
        logPath: (dmc.logPath as string) ?? '',
        serverEndpoint: (dmc.serverEndpoint as string) ?? '',
        sessionId: (dmc.sessionId as string) ?? '',
      }
    })(),
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

function extractSkillDescription(content: string): string {
  // SKILL.md 格式: YAML frontmatter (--- ... ---) + markdown body
  // 从 frontmatter 中提取 description 字段
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return content.slice(0, 120)
  const fm = fmMatch[1]
  const descMatch = fm.match(/^description:\s*(.+)$/m)
  return descMatch ? descMatch[1].trim() : content.slice(0, 120)
}
