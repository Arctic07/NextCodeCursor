import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import type { LLMContentBlock, LLMMessage } from '../llm/types'
import type { ParsedRunRequest } from './protocol'
import type { AgentSession } from './session'
import type { ToolCallInfo } from './tools'
import { persistConversationCheckpoint } from '../../database/checkpoints'
import { logger } from '../../logger'
import { resolveProviderRuntime } from '../llm'
import { decodeBlob } from './blob'
import { getCachedBlob } from './blobStore'
import { emitFinalCheckpoint, emitRollingCheckpoint } from './checkpointManager'
import { createCompactionArtifacts, estimateMessagesTokens, formatMessageForSummary, planCompaction } from './compactionStrategy'
import { flushMessageBlobs, hydrateHistoryEntries, rebuildConversationHistory, sendAndCacheBlob } from './historyManager'
import { buildMessages, workspaceUris } from './protocol'
import { checkpoint, heartbeat, kvMessage, summary, summaryCompleted, summaryStarted, translateStream } from './stream'
import { buildSummaryUserMessage, SUMMARY_SYSTEM_PROMPT } from './summaryPrompt'
import { runToolCall } from './toolRuntime'
import { restoreBlobMessageToLLMMessage } from './transcript'
import { addUsage, clampTokenDetails, emptyUsageTotals, estimateContextTokens, shouldTriggerCompaction } from './usage'
import { isAgentRunAbortedError } from './wait'
import { makeProviderError, makeToolError } from '../errors'

const LEADING_DASH_RE = /^-\s*/

/** Auto-summarize 阈值（与客户端的 speculative summarization 70% 区分，服务端在更激进的阈值触发） */
const AUTO_SUMMARIZE_THRESHOLD_PERCENT = 85

function flushPendingAssistantPrefix(params: {
  roundAssistantBlocks: LLMContentBlock[]
  currentThinking: string
  currentText: string
}): {
  currentThinking: string
  currentText: string
} {
  const { roundAssistantBlocks } = params
  let { currentThinking, currentText } = params

  if (currentThinking) {
    roundAssistantBlocks.push({ type: 'thinking', text: currentThinking })
    currentThinking = ''
  }

  if (currentText) {
    roundAssistantBlocks.push({ type: 'text', text: currentText })
    currentText = ''
  }

  return { currentThinking, currentText }
}

/**
 * 在 Agent Run 流内执行 inline auto-summarize。
 *
 * 对应客户端分析中的链路①：服务端在 BiDi 流中自主决定 summarize，
 * 客户端通过 summaryStarted/summaryCompleted 消息被动响应。
 *
 * 流程：
 * 1. yield summaryStarted — 通知客户端开始 summarize
 * 2. 根据当前 allBlobIds 规划 compaction（planCompaction）
 * 3. 调用 LLM 生成摘要文本
 * 4. 生成 compaction artifacts（summary blob + archive）
 * 5. 通过 kv 消息发送新 blob 到客户端
 * 6. yield checkpoint — 回写 compacted ConversationState
 * 7. yield summaryCompleted — 通知客户端 summarize 完成
 * 8. 返回 compacted 状态供后续 round 继续使用
 */
async function* performInlineAutoSummarize(params: {
  parsed: ParsedRunRequest
  allBlobIds: string[]
  summaryArchiveIds: string[]
  usedTokensEstimate: number
  contextTokenLimit: number
  messages: LLMMessage[]
  route: ReturnType<typeof resolveProviderRuntime>
}): AsyncGenerator<AgentServerMessage, {
  newBlobIds: string[]
  newSummaryArchiveIds: string[]
  newUsedTokens: number
  newMessages: LLMMessage[]
} | null> {
  const { parsed, allBlobIds, summaryArchiveIds, usedTokensEstimate, contextTokenLimit, route } = params

  const historyEntries = hydrateHistoryEntries(allBlobIds)
  if (historyEntries.length === 0)
    return null

  const compactionPlan = planCompaction(historyEntries)
  if (compactionPlan.summarizeEntries.length === 0) {
    logger.info({ conversationId: parsed.conversationId }, '[AGENT] auto-summarize: nothing to compact')
    return null
  }

  logger.info({
    conversationId: parsed.conversationId,
    totalEntries: historyEntries.length,
    summarizeCount: compactionPlan.summarizeEntries.length,
    keepTailCount: compactionPlan.keepTail.length,
    leadingCount: compactionPlan.leading.length,
    usedTokensEstimate,
    contextTokenLimit,
  }, '[AGENT] auto-summarize: starting inline compaction')

  yield summaryStarted()

  const summarySourceText = compactionPlan.summarizeEntries
    .map(entry => formatMessageForSummary(entry.message))
    .filter(text => text.length > 0)
    .join('\n\n')

  let summaryText = ''
  try {
    const llmStream = route.provider.stream({
      model: route.model,
      thinking: false,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: buildSummaryUserMessage(summarySourceText) },
      ],
    })

    for await (const event of llmStream) {
      if (event.type === 'text_delta') {
        summaryText += event.text
        yield summary(event.text)
      }
    }
  }
  catch (error) {
    logger.warn({ error: (error as Error).message }, '[AGENT] auto-summarize: LLM failed, using local fallback')
  }

  summaryText = summaryText.trim()
  if (!summaryText) {
    summaryText = summarySourceText
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, 12)
      .map(line => `- ${line.replace(LEADING_DASH_RE, '')}`)
      .join('\n')
      .slice(0, 4000)
  }
  if (!summaryText) {
    summaryText = '- Prior conversation compacted.'
  }

  const artifacts = createCompactionArtifacts({
    plan: compactionPlan,
    summaryText,
    previousSummaryArchiveIds: summaryArchiveIds,
  })

  yield kvMessage(1, artifacts.summaryBlobId, artifacts.summaryBlobData)
  for (const [index, archiveBlob] of artifacts.archiveBlobs.entries()) {
    yield kvMessage(2 + index, archiveBlob.blobId, archiveBlob.blobData)
  }

  const compactedTokenDetails = clampTokenDetails(
    estimateMessagesTokens([
      ...compactionPlan.leading.map(entry => entry.message),
      { role: 'assistant', content: `Previous conversation summary:\n${artifacts.summaryText}` },
      ...compactionPlan.keepTail.map(entry => entry.message),
    ]),
    contextTokenLimit,
  )

  persistConversationCheckpoint({
    conversationId: parsed.conversationId,
    rootBlobIds: artifacts.nextRootBlobIds,
    summaryArchiveIds: artifacts.nextSummaryArchiveIds,
    tokenDetails: compactedTokenDetails,
    mode: parsed.mode,
    updatedAt: Date.now(),
  })

  yield checkpoint(
    artifacts.nextRootBlobIds,
    compactedTokenDetails.usedTokens,
    compactedTokenDetails.maxTokens,
    parsed.mode,
    undefined,
    {
      summaryArchiveIds: artifacts.nextSummaryArchiveIds,
      workspaceUris: workspaceUris(parsed),
      readPaths: [],
      modelName: route.model,
      gitRepos: parsed.gitRepos?.map(r => ({ path: r.path, branchName: r.branchName })),
    },
  )

  yield summaryCompleted('Chat context summarized.')

  // 重建 compacted 后的 messages 数组供后续 round 使用
  const newMessages: LLMMessage[] = []
  for (const blobId of artifacts.nextRootBlobIds) {
    const blobData = getCachedBlob(blobId)
    if (!blobData)
      continue
    try {
      const decoded = decodeBlob(blobData)
      if (decoded && typeof decoded === 'object') {
        const restored = restoreBlobMessageToLLMMessage(decoded as Record<string, unknown>)
        if (restored)
          newMessages.push(restored)
      }
    }
    catch {}
  }

  logger.info({
    conversationId: parsed.conversationId,
    previousBlobCount: allBlobIds.length,
    newBlobCount: artifacts.nextRootBlobIds.length,
    previousUsedTokens: usedTokensEstimate,
    newUsedTokens: compactedTokenDetails.usedTokens,
    newMessageCount: newMessages.length,
  }, '[AGENT] auto-summarize: compaction complete')

  return {
    newBlobIds: artifacts.nextRootBlobIds,
    newSummaryArchiveIds: artifacts.nextSummaryArchiveIds,
    newUsedTokens: compactedTokenDetails.usedTokens,
    newMessages,
  }
}

export async function* handleConversationRun(
  parsed: ParsedRunRequest,
  session: AgentSession | null,
): AsyncIterable<AgentServerMessage> {
  const route = resolveProviderRuntime(parsed.modelId)
  if (parsed.contextTokenLimit === undefined) {
    parsed.contextTokenLimit = route.contextTokenLimit
  }
  const [systemMessage, preambleUserMessage, currentUserMessage] = buildMessages(parsed, route.promptProfile)
  const systemContent = typeof systemMessage.content === 'string' ? systemMessage.content : ''
  const preambleUserContent = typeof preambleUserMessage.content === 'string' ? preambleUserMessage.content : ''
  // currentUserMessage.content 可能是 string 或 LLMContentBlock[]（当含图片时）
  const currentUserContentRaw = currentUserMessage.content
  const currentUserText = typeof currentUserContentRaw === 'string'
    ? currentUserContentRaw
    : currentUserContentRaw
        .filter((b): b is Extract<LLMContentBlock, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('')
  const currentUserImageCount = typeof currentUserContentRaw === 'string'
    ? 0
    : currentUserContentRaw.filter(b => b.type === 'image').length

  logger.info({
    promptProvider: route.promptProfile.provider,
    promptVariant: route.promptProfile.variant,
    promptStyle: route.promptProfile.systemPromptStyle,
    observedSystemPromptHashes: route.promptProfile.observedSystemPromptHashes,
    promptVocabulary: route.promptProfile.promptVocabulary,
    systemPromptLength: systemContent.length,
    preambleUserMessageLength: preambleUserContent.length,
    currentUserMessageLength: currentUserText.length,
    currentUserImageCount,
    hasRulesSection: preambleUserContent.includes('<rules>'),
    hasAgentSkillsSection: preambleUserContent.includes('<agent_skills>'),
    hasAgentTranscriptsSection: preambleUserContent.includes('<agent_transcripts>'),
    hasUserQuerySection: currentUserText.includes('<user_query>'),
    hasMcpSection: systemContent.includes('<mcp_file_system>'),
    hasLinterSection: systemContent.includes('<linter_errors>'),
    hasTerminalSection: systemContent.includes('<terminal_files_information>'),
  }, '[AGENT] built prompt')

  let blobCounter = 0
  let interactionIdCounter = 1
  let blobIds: string[] = []
  let messages: LLMMessage[] = []
  let currentSummaryArchiveIds = [...parsed.historySummaryArchiveIds]
  let autoSummarizePerformed = false

  const sendSystemScaffoldBlob = function* (
    data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean },
  ): Generator<AgentServerMessage, void, void> {
    yield* sendAndCacheBlob(kvMessage, 0, data, blobIds)
  }

  const sendOrderedBlob = function* (
    data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean },
  ): Generator<AgentServerMessage, void, void> {
    yield* sendAndCacheBlob(kvMessage, ++blobCounter, data, blobIds)
  }

  yield heartbeat()

  const rebuiltHistory = yield* rebuildConversationHistory({
    historyBlobIds: parsed.historyBlobIds,
    prependUserMessages: parsed.prependUserMessages,
    systemMessage,
    preambleUserMessage,
    currentUserMessage,
    systemContent,
    preambleUserContent,
    sendSystemScaffoldBlob,
    sendOrderedBlob,
  })
  messages = rebuiltHistory.messages

  for (const text of rebuiltHistory.insertedPrependUserTexts) {
    yield* sendOrderedBlob({ role: 'user', content: text })
  }

  yield* sendOrderedBlob({ role: 'user', content: currentUserContentRaw })
  let nextBlobbedMessageIndex = messages.length

  const userPreview = parsed.isExecutePlan && parsed.executePlanContent
    ? `[ExecutePlan] ${parsed.executePlanContent.match(/^---\s*\nname:\s*(.+)/m)?.[1]?.trim() ?? parsed.executePlanFileUri ?? 'plan'}`
    : parsed.userText.length > 80 ? `${parsed.userText.slice(0, 80)}...` : parsed.userText
  logger.info(`[AGENT] → [${route.provider.name}/${route.model}] "${userPreview}" (${messages.length} msgs)`)

  const usageTotals = emptyUsageTotals()
  let usedTokensEstimate = Math.max(
    parsed.historyTokenDetails?.usedTokens ?? 0,
    estimateMessagesTokens(messages),
  )
  let lastAssistantContent: LLMContentBlock[] | undefined
  let stepCounter = 0

  for (let round = 0; ; round++) {
    const pendingToolCalls: ToolCallInfo[] = []
    const inflightToolCalls = new Map<string, { name: string, input: string }>()
    const roundAssistantBlocks: LLMContentBlock[] = []
    let currentThinking = ''
    let currentText = ''

    try {
      const preparedRequest = route.prepareStreamRequest(messages, parsed.mcpTools, 8192, parsed.mode)

      logger.info({
        round,
        codec: route.conversationCodec.name,
        semanticTurns: preparedRequest.conversation.semanticTurns.map(turn => turn.kind),
        toolCatalogProvider: route.toolCatalog.provider,
        toolCatalogVariant: route.toolCatalog.variant,
        builtinsCount: route.toolCatalog.listBuiltins().length,
        runtimeToolsCount: preparedRequest.request.tools?.length ?? 0,
        mcpToolsCount: parsed.mcpTools.length,
        mcpToolNames: parsed.mcpTools.map(t => t.name),
      }, '[AGENT] prepared provider conversation')

      const llmStream = route.provider.stream(preparedRequest.request)

      for await (const frame of translateStream(llmStream, String(++stepCounter), (event) => {
        switch (event.type) {
          case 'thinking_delta':
            currentThinking += event.text
            break
          case 'thinking_done':
            if (currentThinking) {
              roundAssistantBlocks.push({ type: 'thinking', text: currentThinking })
              currentThinking = ''
            }
            break
          case 'text_delta':
            currentText += event.text
            break
          case 'tool_use_start': {
            ({ currentThinking, currentText } = flushPendingAssistantPrefix({
              roundAssistantBlocks,
              currentThinking,
              currentText,
            }))
            inflightToolCalls.set(event.id, { name: event.name, input: '' })
            break
          }
          case 'tool_use_delta': {
            const current = inflightToolCalls.get(event.id) ?? { name: '', input: '' }
            inflightToolCalls.set(event.id, { ...current, input: current.input + event.input })
            break
          }
          case 'tool_use_done': {
            const current = inflightToolCalls.get(event.id)
            if (current) {
              let input: Record<string, unknown> = {}
              try {
                input = JSON.parse(current.input)
              }
              catch {}
              pendingToolCalls.push({ callId: event.id, name: current.name, input })
              roundAssistantBlocks.push({ type: 'tool_use', id: event.id, name: current.name, input })
              inflightToolCalls.delete(event.id)
            }
            break
          }
          case 'done':
            ({ currentThinking, currentText } = flushPendingAssistantPrefix({
              roundAssistantBlocks,
              currentThinking,
              currentText,
            }))
            Object.assign(usageTotals, addUsage(usageTotals, event.usage))
            usedTokensEstimate = Math.max(usedTokensEstimate, estimateContextTokens(event.usage))
            break
        }
      })) {
        yield frame
      }
    }
    catch (e) {
      // 关键: 不再往对话流 yield textDelta('[BYOK Error] ...') —— 那会让错误文本
      // 伪装成 assistant 的"正常回复", 同时被写进 roundAssistantBlocks 污染历史,
      // 下一轮 LLM 会看到自己刚刚回复了 [BYOK Error] 导致状态错乱。
      //
      // 现在直接抛 ConnectError, 让 AgentService.runSSE 的顶层 catch 把 error
      // 序列化到 SSE trailer。客户端 @connectrpc 解包 aiserver.v1.ErrorDetails
      // 后, composer.maybeThrowErrorAndRetry 会写入 ComposerData.submitErrorDetails,
      // Glass Composer 的 Lzv 组件渲染成 input 正上方的 retry banner。
      logger.error({ error: (e as Error).message, stack: (e as Error).stack }, '[LLM] stream error')
      throw makeProviderError(e, {
        conversationId: parsed.conversationId,
        modelId: parsed.modelId,
        round: String(round),
      })
    }

    if (pendingToolCalls.length === 0) {
      const transition = route.transitionRound(messages, roundAssistantBlocks)
      if (transition.assistantAdded)
        lastAssistantContent = roundAssistantBlocks
      break
    }

    logger.info({ round, toolCalls: pendingToolCalls.map(t => t.name) }, '[AGENT] processing tool calls')
    let flushedToolResults = 0
    try {
      const assistantContent = roundAssistantBlocks
      lastAssistantContent = assistantContent

      const roundContext = route.createRoundContext()

      for (const tc of pendingToolCalls) {
        yield* runToolCall({
          toolCall: tc,
          availableMcpTools: parsed.mcpTools,
          conversationId: parsed.conversationId,
          currentModelId: parsed.modelId,
          workspacePath: parsed.env.workspacePaths?.[0] ?? parsed.env.projectFolder,
          round,
          session,
          roundContext,
          messages,
          allocateExecMessageId: () => ++blobCounter,
          allocateInteractionId: () => interactionIdCounter++,
        })
      }

      // SwitchMode 成功后立即切换 mode,让下一轮 LLM 用新工具集
      // (例如 Agent→Plan 切换后 CreatePlan 工具才会出现在列表里)
      for (const tr of roundContext.pendingToolResults) {
        if (!tr.isError && tr.content.includes('toModeId')) {
          try {
            const parsed_result = JSON.parse(tr.content)
            const toMode = parsed_result?.toModeId as string | undefined
            if (toMode) {
              const newMode = `AGENT_MODE_${toMode.toUpperCase()}`
              logger.info({ from: parsed.mode, to: newMode }, '[AGENT] mode switched mid-session')
              parsed.mode = newMode
            }
          }
          catch {}
        }
      }

      if (roundContext.pendingToolResults.length > 0) {
        logger.info({
          round,
          stateStrategy: route.stateStrategy.name,
          toolResults: roundContext.pendingToolResults.map(block => ({
            toolUseId: block.toolUseId,
            isError: !!block.isError,
            contentLen: block.content.length,
          })),
        }, '[AGENT] tool results pending provider-state flush')
      }
      const transition = roundContext.transition(messages, assistantContent)
      flushedToolResults = transition.flushedToolResults;

      ({ nextIndex: nextBlobbedMessageIndex, blobCounter } = yield* flushMessageBlobs(
        kvMessage,
        messages,
        nextBlobbedMessageIndex,
        blobCounter,
        blobIds,
      ))

      usedTokensEstimate = Math.max(usedTokensEstimate, estimateMessagesTokens(messages))

      const allBlobIdsForCheckpoint = [...parsed.historyBlobIds, ...blobIds]
      yield emitRollingCheckpoint({
        conversationId: parsed.conversationId,
        round,
        nextBlobbedMessageIndex,
        allBlobIds: allBlobIdsForCheckpoint,
        summaryArchiveIds: currentSummaryArchiveIds,
        usedTokensEstimate,
        contextTokenLimit: route.contextTokenLimit,
        mode: parsed.mode,
        lastAssistantContent,
        usageTotals,
        workspaceUris: workspaceUris(parsed),
        modelName: route.model,
        readPaths: [],
        gitRepos: parsed.gitRepos?.map(r => ({ path: r.path, branchName: r.branchName })),
      })

      // 链路①: 服务端 Agent Run 内自动 summarize
      // 当 context window 使用量超过阈值时，在继续下一轮 LLM 调用前自动执行 compaction
      if (!autoSummarizePerformed && shouldTriggerCompaction(usedTokensEstimate, route.contextTokenLimit, AUTO_SUMMARIZE_THRESHOLD_PERCENT)) {
        logger.info({
          conversationId: parsed.conversationId,
          round,
          usedTokensEstimate,
          contextTokenLimit: route.contextTokenLimit,
          thresholdPercent: AUTO_SUMMARIZE_THRESHOLD_PERCENT,
        }, '[AGENT] auto-summarize: threshold exceeded, triggering inline compaction')

        const compactionResult = yield* performInlineAutoSummarize({
          parsed,
          allBlobIds: allBlobIdsForCheckpoint,
          summaryArchiveIds: currentSummaryArchiveIds,
          usedTokensEstimate,
          contextTokenLimit: route.contextTokenLimit,
          messages,
          route,
        })

        if (compactionResult) {
          // 用 compacted 后的状态替换当前状态，继续后续 round
          messages = compactionResult.newMessages
          parsed.historyBlobIds = compactionResult.newBlobIds
          currentSummaryArchiveIds = compactionResult.newSummaryArchiveIds
          usedTokensEstimate = compactionResult.newUsedTokens
          // 重置 blob 追踪：compaction 后 blobIds 都已合并到 parsed.historyBlobIds
          blobIds = []
          blobCounter = 0
          nextBlobbedMessageIndex = messages.length
          autoSummarizePerformed = true

          logger.info({
            conversationId: parsed.conversationId,
            newMessageCount: messages.length,
            newUsedTokens: usedTokensEstimate,
          }, '[AGENT] auto-summarize: state replaced, continuing agent loop')
        }
      }
    }
    catch (e) {
      if (isAgentRunAbortedError(e)) {
        logger.info({
          conversationId: parsed.conversationId,
          round,
          execMessageId: e.execMessageId,
          error: e.message,
        }, '[AGENT] tool call wait aborted by client; ending current run')
        return
      }

      // Tool call 抛错 (非用户 abort) —— 同样改为 throw ConnectError, 不再伪装
      // 成正常消息写入对话流。当前 round 的 roundAssistantBlocks 里可能含有
      // 半构造的 tool_use block, 我们让它和 error 一起丢弃, 保证客户端点 retry
      // 后从干净状态重发最后一条 human bubble。
      logger.error({ error: (e as Error).message, stack: (e as Error).stack }, '[AGENT] tool call processing error')
      throw makeToolError(e)
    }

    logger.info({ round: round + 1, messages: messages.length, flushedToolResults }, '[AGENT] continuing LLM with tool results')
  }

  ({ nextIndex: nextBlobbedMessageIndex, blobCounter } = yield* flushMessageBlobs(
    kvMessage,
    messages,
    nextBlobbedMessageIndex,
    blobCounter,
    blobIds,
  ))

  usedTokensEstimate = Math.max(usedTokensEstimate, estimateMessagesTokens(messages))

  yield emitFinalCheckpoint({
    conversationId: parsed.conversationId,
    allBlobIds: [...parsed.historyBlobIds, ...blobIds],
    summaryArchiveIds: currentSummaryArchiveIds,
    usedTokensEstimate,
    contextTokenLimit: route.contextTokenLimit,
    mode: parsed.mode,
    lastAssistantContent,
    usageTotals,
    workspaceUris: workspaceUris(parsed),
    modelName: route.model,
    readPaths: [],
    gitRepos: parsed.gitRepos?.map(r => ({ path: r.path, branchName: r.branchName })),
  })
}
