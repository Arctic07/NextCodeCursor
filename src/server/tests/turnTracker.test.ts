import { describe, expect, it } from 'vitest'
import { cacheBlob, resetBlobCacheForTests } from '../handlers/agent/blobStore'
import { ActiveTurnTracker, createCurrentTurnUserMessageBlob, readTurnBaseline } from '../handlers/agent/turnTracker'

describe('turnTracker', () => {
  it('materializes new turns and resumes from cached turn blobs', () => {
    resetBlobCacheForTests()

    const { blob: userBlob, messageId } = createCurrentTurnUserMessageBlob({
      parsed: {
        userText: 'hello world',
        modelId: 'gpt-5.4-medium',
        conversationId: 'conv-turn',
        mode: 'AGENT_MODE_AGENT',
        isSummarize: false,
        isSubagent: false,
        isBackgroundTaskCompletion: false,
        backgroundTaskCompletions: [],
        userRules: [],
        projectRules: [],
        agentSkills: [],
        env: {},
        isGitRepo: false,
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
        selectedImages: [],
        prependUserMessages: [],
        isResume: false,
        isExecutePlan: false,
        conversationNotesListing: '',
        sharedNotesListing: '',
      },
      fallbackMessageId: 'fallback-msg',
    })

    cacheBlob(userBlob.blobId, userBlob.blobData)

    const turn = new ActiveTurnTracker(userBlob.blobId, [], messageId)
    const thinking = turn.addThinking('reason')
    const assistant = turn.addAssistantText('answer')
    expect(thinking).toBeTruthy()
    expect(assistant).toBeTruthy()
    if (thinking)
      cacheBlob(thinking.blobId, thinking.blobData)
    if (assistant)
      cacheBlob(assistant.blobId, assistant.blobData)

    const turnBlob = turn.materializeTurnBlob()
    cacheBlob(turnBlob.blobId, turnBlob.blobData)

    expect(readTurnBaseline(turnBlob.blobId)).toEqual({
      userMessageBlobId: userBlob.blobId,
      stepBlobIds: [thinking?.blobId, assistant?.blobId].filter(Boolean),
      requestId: messageId,
    })

    const resumed = ActiveTurnTracker.fromTurnBlobId(turnBlob.blobId)
    expect(resumed?.materializeTurnBlob().blobId).toBe(turnBlob.blobId)
  })
})
