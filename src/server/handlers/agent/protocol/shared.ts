import type { ParsedRunRequest } from './types'

/** XML 转义:preamble / system prompt 中用作 attribute 和 inner text */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** runRequest 缺失或形态异常时的默认 parsed 值 */
export function emptyParsed(): ParsedRunRequest {
  return {
    userText: '',
    modelId: '',
    conversationId: '',
    mode: '',
    isSummarize: false,
    isSubagent: false,
    isBackgroundTaskCompletion: false,
    backgroundTaskCompletions: [],
    userRules: [],
    projectRules: [],
    agentSkills: [],
    env: {},
    mcpServers: [],
    mcpBasePath: '',
    mcpTools: [],
    mcpInstructions: [],
    ideState: undefined,
    documentations: [],
    cursorCommands: [],
    selectedSkills: [],
    extraContextEntries: [],
    codeSelections: [],
    terminalSelections: [],
    fileContents: {},
    projectLayouts: [],
    externalLinks: [],
    selectedSubagents: [],
    selectedBrowsers: [],
    recentAgentsContext: [],
    webSearchEnabled: false,
    webFetchEnabled: false,
    readLintsEnabled: false,
    historyBlobIds: [],
    historyTurnBlobIds: [],
    historyTurns: [],
    historySummaryArchiveIds: [],
    historyTokenDetails: undefined,
    rawUserMessage: undefined,
    selectedImages: [],
    prependUserMessages: [],
    isResume: false,
    interruptedResolutions: [],
    isExecutePlan: false,
    isGitRepo: false,
    conversationNotesListing: '',
    sharedNotesListing: '',
    subagentModelOverrides: [],
  }
}

/**
 * requestContext.env.workspacePaths 是 fsPath 字符串，不是真实 workspace URI。
 *
 * Cursor checkpoint.previousWorkspaceUris 仍期望 URI-ish 值；这里仅为该兼容位
 * 合成 file:// 前缀字符串。不要把返回值当作真实 URI，更不要用于 remote/path 语义判断。
 */
export function workspaceUris(parsed: ParsedRunRequest): string[] {
  return (parsed.env.workspacePaths ?? [])
    .filter(p => p.length > 0)
    .map(p => `file://${p}`)
}
