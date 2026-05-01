import { expect, it } from 'vitest'
import { buildMessages, parseRunRequest } from '../handlers/agent/protocol'

it('parseRunRequest extracts prependUserMessages for mid-conversation replay', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-1',
      prependUserMessages: [
        { text: '列出所有工具列表', messageId: 'm1' },
        { text: '安排计划测试每个工具', messageId: 'm2' },
      ],
      action: {
        userMessageAction: {
          userMessage: {
            text: '最开始我说了什么',
            mode: 'AGENT_MODE_AGENT',
          },
          requestContext: {},
        },
      },
      modelDetails: { modelId: 'qwen3.5-plus' },
    },
  })

  expect(parsed.userText).toBe('最开始我说了什么')
  expect(parsed.prependUserMessages.length).toBe(2)
  expect(parsed.prependUserMessages.map(message => message.text)).toEqual([
    '列出所有工具列表',
    '安排计划测试每个工具',
  ])
})

it('parseRunRequest converts backgroundTaskCompletionAction into simulated user text', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-bg',
      action: {
        backgroundTaskCompletionAction: {
          completions: [
            {
              taskId: 'task-1',
              kind: 'BACKGROUND_TASK_KIND_SUBAGENT',
              status: 'BACKGROUND_TASK_STATUS_SUCCESS',
              title: 'Research worker',
              detail: 'Final subagent answer',
              threadId: 'thread-1',
            },
          ],
        },
      },
      requestedModel: { modelId: 'model-e7r9cr' },
    },
  })

  expect(parsed.isBackgroundTaskCompletion).toBe(true)
  expect(parsed.backgroundTaskCompletions).toHaveLength(1)
  expect(parsed.userText).toContain('<agent_notification>')
  expect(parsed.userText).toContain('kind: subagent')
  expect(parsed.userText).toContain('task_id: task-1')
  expect(parsed.userText).toContain('Final subagent answer')
})

it('parseRunRequest extracts requested model context token limit', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-context-param',
      action: {
        userMessageAction: {
          userMessage: {
            text: 'hello',
            mode: 'AGENT_MODE_AGENT',
          },
          requestContext: {},
        },
      },
      requestedModel: {
        modelId: 'model-e7r9cr',
        parameters: [
          { id: 'thinking', value: 'true' },
          { id: 'level', value: 'xhigh' },
          { id: 'context', value: '272000' },
        ],
      },
    },
  })

  expect(parsed.contextTokenLimit).toBe(272000)
})

it('parseRunRequest extracts summarizeAction compaction metadata from conversationState', () => {
  const encodedBlobId = Buffer.from('blob-summary').toString('base64')
  const encodedArchiveId = Buffer.from('archive-1').toString('base64')
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-sum',
      action: {
        summarizeAction: {},
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
      conversationState: {
        rootPromptMessagesJson: [encodedBlobId],
        summaryArchives: [encodedArchiveId],
        tokenDetails: {
          usedTokens: 2048,
          maxTokens: 8192,
        },
      },
    },
  })

  expect(parsed.isSummarize).toBe(true)
  expect(parsed.historyBlobIds).toEqual(['blob-summary'])
  expect(parsed.historySummaryArchiveIds).toEqual(['archive-1'])
  expect(parsed.historyTokenDetails).toEqual({ usedTokens: 2048, maxTokens: 8192 })
})

it('parseRunRequest preserves MCP tool provider metadata from requestContext.tools', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-mcp',
      action: {
        userMessageAction: {
          userMessage: {
            text: 'test mcp',
            mode: 'AGENT_MODE_AGENT',
          },
          requestContext: {
            tools: [
              {
                name: 'user-brave-search-brave_web_search',
                description: 'search the web',
                inputSchema: { type: 'object' },
                providerIdentifier: 'brave-search',
                toolName: 'brave_web_search',
              },
            ],
          },
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  expect(parsed.mcpTools.length).toBe(1)
  expect(parsed.mcpTools[0]?.providerIdentifier).toBe('brave-search')
  expect(parsed.mcpTools[0]?.toolName).toBe('brave_web_search')
})

it('buildMessages selects composer fallback prompt for composer meta models', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-composer',
      action: {
        userMessageAction: {
          userMessage: { text: 'hi', mode: 'AGENT_MODE_AGENT' },
          requestContext: { env: { workspacePaths: ['/workspace'] } },
        },
      },
      modelDetails: { modelId: 'composer-2-fast' },
    },
  })

  const [systemMessage] = buildMessages(parsed)
  const systemContent = String(systemMessage?.content ?? '')
  expect(systemContent).toMatch(/powered by Composer/)
  expect(systemContent).toMatch(/<communication>/)
  expect(systemContent).not.toMatch(/<tool_calling>/)
})

it('buildMessages produces official-style system and structured user content', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-2',
      action: {
        userMessageAction: {
          userMessage: {
            text: '帮我检查这个项目',
            mode: 'AGENT_MODE_AGENT',
          },
          requestContext: {
            env: {
              osVersion: 'macOS',
              shell: 'zsh',
              workspacePaths: ['/workspace/app'],
              terminalsFolder: '/tmp/terminals',
              agentTranscriptsFolder: '/tmp/transcripts',
              gitRepos: [{ path: '/workspace/app', status: 'clean', branchName: 'main' }],
            },
            readLintsEnabled: true,
            rules: [
              {
                content: 'Always reply in Chinese',
                type: { global: {} },
              },
              {
                content: 'Use pnpm',
                fullPath: '/workspace/app/.cursor/rules/build.md',
                type: { fileGlobbed: { glob: '**/*' } },
              },
              {
                fullPath: '/skills/review.md',
                type: { agentFetched: { description: 'Review code carefully' } },
              },
            ],
          },
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  const [systemMessage, preambleUserMessage, currentUserMessage] = buildMessages(parsed)
  expect(systemMessage?.role).toBe('system')
  expect(preambleUserMessage?.role).toBe('user')
  expect(currentUserMessage?.role).toBe('user')

  const systemContent = String(systemMessage?.content ?? '')
  const preambleUserContent = String(preambleUserMessage?.content ?? '')
  const currentUserContent = String(currentUserMessage?.content ?? '')

  expect(systemContent).toMatch(/<tool_calling>/)
  expect(systemContent).toMatch(/<citing_code>/)
  expect(systemContent).toMatch(/<linter_errors>/)
  expect(systemContent).toMatch(/<terminal_files_information>/)

  expect(preambleUserContent).toMatch(/<user_info>/)
  expect(preambleUserContent).toMatch(/<agent_transcripts>/)
  expect(preambleUserContent).toMatch(/<rules>/)
  expect(preambleUserContent).toMatch(/<user_rules/)
  expect(preambleUserContent).toMatch(/Always reply in Chinese/)
  expect(preambleUserContent).toMatch(/<project_rules/)
  expect(preambleUserContent).toMatch(/Use pnpm/)
  expect(preambleUserContent).toMatch(/<available_skills>/)
  expect(preambleUserContent).toMatch(/Review code carefully/)
  expect(preambleUserContent).not.toMatch(/<user_query>/)

  expect(currentUserContent).toMatch(/<user_query>\s*帮我检查这个项目\s*<\/user_query>/)
  expect(currentUserContent).not.toMatch(/<agent_skills>|<rules>|<user_info>/)
})
