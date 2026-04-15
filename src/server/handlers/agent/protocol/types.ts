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
  mode: string
  isSummarize: boolean
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
  /** 功能开关 */
  webSearchEnabled: boolean
  webFetchEnabled: boolean
  readLintsEnabled: boolean
  /** rootPromptMessagesJson — 对话历史 blob IDs (system + messages 链) */
  historyBlobIds: string[]
  /** turns — 每轮的 blob IDs */
  historyTurns: string[]
  /** summary_archives — 已压缩历史的 archive blob IDs */
  historySummaryArchiveIds: string[]
  historyTokenDetails?: { usedTokens: number, maxTokens: number }
  /** 用户消息附带的图片 (来自 SelectedContext.selectedImages) */
  selectedImages: Array<{ mimeType: string, data: string }>
  /** replay / mid-conversation resend 时客户端额外附带的前序用户消息 */
  prependUserMessages: Array<{ text: string, messageId?: string }>
  isResume: boolean
  /** 备注列表 */
  conversationNotesListing: string
  sharedNotesListing: string
}
