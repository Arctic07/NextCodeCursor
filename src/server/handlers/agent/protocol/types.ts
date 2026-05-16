/**
 * Agent 协议类型定义
 *
 * ParsedRunRequest 是从 Cursor AgentClientMessage (runRequest) 中解出来的规整结构,
 * 下游翻译器(LLM 消息构造、preamble 构造、工具注册表)统一消费此结构。
 */

/** IDE 状态中的单个文件记录 (agent.v1.InvocationContext.IdeState.File) */
export interface IdeFile {
  path: string
  relativePath?: string
  totalLines: number
  activeCommand?: string
  cursorLine?: number
  cursorText?: string
}

/** 从 runRequest 中提取的关键信息 */
export interface ParsedRunRequest {
  userText: string
  modelId: string
  conversationId: string
  /** 当前模型的上下文窗口大小 (tokens),用于 skill catalog 预算计算 */
  contextTokenLimit?: number
  mode: string
  isSummarize: boolean
  isSubagent: boolean
  isBackgroundTaskCompletion: boolean
  backgroundTaskCompletions: Array<{
    taskId: string
    kind: string
    status: string
    title: string
    detail?: string
    outputPath?: string
    threadId?: string
  }>
  /** 用户设置的规则 (type: global,对应 .cursorrules / user settings rules) */
  userRules: string[]
  /** 项目/文件级别规则 (type: fileGlobbed / manuallyAttached) */
  projectRules: Array<{ fullPath: string, content: string, glob?: string }>
  /** Agent Skills (type: agentFetched 或 agentSkills 字段) */
  agentSkills: Array<{ fullPath: string, description: string }>
  env: {
    osVersion?: string
    shell?: string
    workspacePaths?: string[]
    timeZone?: string
    terminalsFolder?: string
    agentTranscriptsFolder?: string
    agentSharedNotesFolder?: string
    agentConversationNotesFolder?: string
    projectFolder?: string
    sandboxSupported?: boolean
  }
  /** Git 仓库信息 */
  gitRepos?: Array<{ path: string, status: string, branchName: string }>
  isGitRepo: boolean
  /** MCP 服务器配置 */
  mcpServers: Array<{
    serverName: string
    folderPath: string
    serverUseInstructions: string
  }>
  /** MCP 工具目录根路径 */
  mcpBasePath: string
  mcpTools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
    providerIdentifier: string
    toolName: string
  }>
  /** MCP server 使用说明 (来自 requestContext.mcp_instructions, proto field 14) */
  mcpInstructions: Array<{
    serverName: string
    instructions: string
    serverIdentifier: string
  }>
  /** IDE 状态快照 (来自 selectedContext.invocation_context.ide_state) */
  ideState?: {
    visibleFiles: Array<IdeFile>
    recentlyViewedFiles: Array<IdeFile>
  }
  /** 用户 @ 的文档引用 (来自 selectedContext.documentations) */
  documentations: Array<{ docId: string, name: string }>
  /** 用户触发的 cursor command (来自 selectedContext.cursor_commands) */
  cursorCommands: Array<{ name: string, content: string }>
  /** 用户手动 @ 的 skill (来自 selectedContext.selected_skills),区别于 agentSkills 的"全部可用" */
  selectedSkills: Array<{ fullPath: string, description: string }>
  /**
   * 额外上下文条目 (来自 selectedContext.extra_context_entries)。
   * 每条是 { data } 或 { blobId } 之一,blobId 形态需经 blob store 解包 (Step 4)。
   */
  extraContextEntries: Array<{ data?: string, blobId?: string }>

  // ── SelectedContext 扩展字段 (客户端已 gather,逐一注入 LLM) ──

  /**
   * 用户框选代码 (来自 selectedContext.code_selections, proto field 5)
   * content = 选中的代码;range = 起止行列;path 为绝对路径
   */
  codeSelections: Array<{
    content: string
    path: string
    relativePath?: string
    range?: { startLine: number, startCol: number, endLine: number, endCol: number }
  }>
  /**
   * 用户框选终端输出 (来自 selectedContext.terminal_selections, proto field 7)
   * 客户端异步 gather,content 为多行拼接,title/path 可空
   */
  terminalSelections: Array<{
    content: string
    title?: string
    path?: string
    range?: { startLine: number, startCol: number, endLine: number, endCol: number }
  }>
  /**
   * 用户 @ 的文件内容 (来自 requestContext.file_contents, proto field 20)
   *
   * **注意:不在 selectedContext 下,在 requestContext 下**。Cursor 客户端对
   * "@ 整个文件"的处理是填 requestContext.file_contents (map<path, content>),
   * 不走 selectedContext.files。同理 @ Folder 走 requestContext.project_layouts。
   *
   * 数据形态: { "/abs/path/file.ts": "<file content>", ... }
   */
  fileContents: Record<string, string>
  /**
   * 用户 @ 的项目目录树 (来自 requestContext.project_layouts, proto field 13)
   *
   * 对应 @ Folder 菜单触发的目录结构快照。每个节点是 LsDirectoryTreeNode
   * (递归结构, 含 path / files / subfolders)。原样 JSON 压入 XML 供 LLM 理解。
   */
  projectLayouts: Array<Record<string, unknown>>
  /**
   * 用户 @ 的外部链接 (来自 selectedContext.external_links, proto field 9)
   * 包含普通 URL 和 PDF (is_pdf + pdf_content / blob_id)。菜单里没有 @Link 入口,
   * 但客户端 appendDataLink (unminify.js:709435) 仍有写入路径,保留注入。
   */
  externalLinks: Array<{
    url: string
    uuid: string
    filename?: string
    isPdf: boolean
    pdfContent?: string
  }>
  /**
   * 用户 @ 的 subagent (来自 selectedContext.selected_subagents, proto field 22)
   * 只有 name,server 需要按 name 查找 subagent 定义
   *
   * ── 刻意跳过的 git 相关字段(决策记录) ──
   * gitDiff / gitCommits / gitPrDiffSelections / selectedPullRequests:
   *   官方有 StreamDiffReview / SummarizeWithReferences 专用后端 pipeline,
   *   BYOK 脱离后直接注入原始 diff/commit 会爆 context 或成为无效数据。依赖
   *   LLM 通过 Shell tool 主动运行 git diff/log/show 获取更精确的信息。
   *
   * gitDiffFromBranchToMain (field 11) **已核实客户端真的会发**(@ Branch 实测):
   *   proto 结构为 { content: string, full_content_length_char_count: int32 },
   *   客户端跑 git diff origin/main...HEAD 截断到 ~500KB。本可实装(带硬截断
   *   到 80KB 以内注入 <git_diff_from_branch_to_main> XML 块),但:
   *     (1) @ Branch 菜单使用率预期低(大部分场景 LLM 自己跑 git 命令更准)
   *     (2) 实装要多维护一段带阈值分支的 XML 渲染逻辑
   *   权衡后**暂不实装激活**。parseRunRequest 里的诊断打点已经在持续观察
   *   客户端是否填充此字段,日后使用率上来再启用。
   *
   * 以上所有 git 字段若要激活,同步改: types.ts(加字段) + shared.ts(默认值)
   *   + parseRunRequest.ts(解析) + messageBuilder.ts(XML 块 + 硬截断)。
   */
  selectedSubagents: Array<{ name: string }>
  /**
   * 用户 @ 的浏览器页面 (来自 selectedContext.selected_browsers, proto field 24)
   * 来自 Cursor 浏览器集成,含 url + 页面标题
   */
  selectedBrowsers: Array<{
    browserId: string
    url: string
    pageTitle?: string
  }>
  /**
   * 最近的 agent 对话 (来自 selectedContext.recent_agents_context, proto field 27)
   * 取代 past_chats;客户端从最近对话列表取前 N 个 transcript 摘要
   */
  recentAgentsContext: Array<{
    name: string
    path: string
    overview?: string
  }>
  /** 客户端 Edit 面板参数 (来自 RequestedModel.parameters[]) */
  clientThinking?: boolean
  clientThinkingLevel?: string
  clientThinkingBudget?: number
  clientFast?: boolean
  /** 功能开关 */
  webSearchEnabled: boolean
  webFetchEnabled: boolean
  readLintsEnabled: boolean
  /** rootPromptMessagesJson — 对话历史 blob IDs (system + messages 链) */
  historyBlobIds: string[]
  /** turns — ConversationTurnStructure blob IDs */
  historyTurnBlobIds: string[]
  /** @deprecated 历史兼容别名；新代码使用 historyTurnBlobIds */
  historyTurns: string[]
  /** summary_archives — 已压缩历史的 archive blob IDs */
  historySummaryArchiveIds: string[]
  historyTokenDetails?: { usedTokens: number, maxTokens: number }
  /** 当前轮原始 UserMessage (仅 userMessageAction 有；用于 turns.user_message 复刻) */
  rawUserMessage?: Record<string, unknown>
  /** 用户消息附带的图片 (来自 SelectedContext.selectedImages) */
  selectedImages: Array<{ mimeType: string, data: string }>
  /** replay / mid-conversation resend 时客户端额外附带的前序用户消息 */
  prependUserMessages: Array<{ text: string, messageId?: string }>
  isResume: boolean
  /** Build 按钮触发的 Plan 执行 (来自 action.executePlanAction) */
  isExecutePlan: boolean
  executePlanContent?: string
  executePlanFileUri?: string
  /** Debug 模式配置 (来自 requestContext.debug_mode_config, proto field 15) */
  debugModeConfig?: {
    logPath: string
    serverEndpoint: string
    sessionId: string
  }
  /** 备注列表 */
  conversationNotesListing: string
  sharedNotesListing: string
}
