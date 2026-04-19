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
    historyTurns: [],
    historySummaryArchiveIds: [],
    historyTokenDetails: undefined,
    selectedImages: [],
    prependUserMessages: [],
    isResume: false,
    isExecutePlan: false,
    isGitRepo: false,
    conversationNotesListing: '',
    sharedNotesListing: '',
  }
}

/** parsed.env.workspacePaths → file:// URI 列表 (用于 checkpoint.previousWorkspaceUris) */
export function workspaceUris(parsed: ParsedRunRequest): string[] {
  return (parsed.env.workspacePaths ?? [])
    .filter(p => p.length > 0)
    .map(p => p.startsWith('file://') ? p : `file://${p}`)
}
