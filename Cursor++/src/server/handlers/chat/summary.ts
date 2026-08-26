import type { ConversationMessage, ConversationSummary, StreamUnifiedChatRequest } from '../../gen/aiserver_v1_pb'
import { create } from '@bufbuild/protobuf'
import {
  ConversationMessage_MessageType,
  ConversationSummarySchema,

} from '../../gen/aiserver_v1_pb'

const SUMMARY_PRIMARY_KEEP_RECENT_MESSAGES = 6
const SUMMARY_DEEP_KEEP_RECENT_MESSAGES = 3
const SUMMARY_MAX_LINES = 24
const SUMMARY_MAX_ITEM_CHARS = 320
const SUMMARY_MAX_TOTAL_CHARS = 6000
const SUMMARY_STRATEGY_PLAIN_TEXT = 'plain_text_summary'
const SUMMARY_STRATEGY_TOOL_TRUNCATION = 'arbitrary_summary_plus_tool_result_truncation'

function normalizeText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function getMessageId(message: ConversationMessage): string {
  return message.serverBubbleId || message.bubbleId || ''
}

function getMessageRole(message: ConversationMessage): string {
  switch (message.type) {
    case ConversationMessage_MessageType.HUMAN:
      return 'user'
    case ConversationMessage_MessageType.AI:
      return 'assistant'
    default:
      return 'message'
  }
}

const SPECULATIVE_TOOL_RESULT_ITEM_CHARS = 220

function summarizeToolResults(message: ConversationMessage): string[] {
  return message.toolResults.slice(0, 3).map((result) => {
    const toolName = normalizeText(result.toolName) || 'tool'
    const content = normalizeText(result.content) || '[no content]'
    return `[tool:${toolName}] ${truncate(content, SPECULATIVE_TOOL_RESULT_ITEM_CHARS)}`
  })
}

function summarizeMessageBody(message: ConversationMessage): string[] {
  const lines: string[] = []
  const text = normalizeText(message.text)
  if (text) {
    lines.push(truncate(text, SUMMARY_MAX_ITEM_CHARS))
  }

  if (message.toolResults.length > 0) {
    lines.push(...summarizeToolResults(message))
  }

  if (message.interpreterResults.length > 0) {
    lines.push(`[interpreter_results] ${message.interpreterResults.length} result(s)`)
  }

  if (message.recentlyViewedFiles.length > 0) {
    const files = message.recentlyViewedFiles
      .map(file => normalizeText(file.relativeWorkspacePath))
      .filter(Boolean)
      .slice(0, 3)
    if (files.length > 0) {
      lines.push(`[recent_files] ${files.join(', ')}`)
    }
  }

  if (message.attachedCodeChunks.length > 0) {
    const files = message.attachedCodeChunks
      .map(chunk => normalizeText(chunk.relativeWorkspacePath))
      .filter(Boolean)
      .slice(0, 3)
    if (files.length > 0) {
      lines.push(`[attached_code] ${files.join(', ')}`)
    }
    else {
      lines.push(`[attached_code] ${message.attachedCodeChunks.length} chunk(s)`)
    }
  }

  if (message.conversationSummary?.summary) {
    lines.push(`[embedded_summary] ${truncate(normalizeText(message.conversationSummary.summary), SUMMARY_MAX_ITEM_CHARS)}`)
  }

  if (lines.length === 0) {
    lines.push('[non_text_message]')
  }

  return lines
}

function buildSummaryText(previousSummary: string, messages: ConversationMessage[]): string {
  const lines: string[] = []

  if (previousSummary) {
    lines.push('Previous summarized context:')
    lines.push(`- ${truncate(previousSummary, SUMMARY_MAX_ITEM_CHARS)}`)
    lines.push('')
  }

  lines.push('Conversation history summary:')

  for (const message of messages) {
    for (const bodyLine of summarizeMessageBody(message)) {
      lines.push(`- [${getMessageRole(message)}] ${bodyLine}`)
      if (lines.length >= SUMMARY_MAX_LINES) {
        return truncate(lines.join('\n'), SUMMARY_MAX_TOTAL_CHARS)
      }
    }
  }

  if (lines.length <= (previousSummary ? 3 : 1)) {
    lines.push('- [message] No useful content available.')
  }

  return truncate(lines.join('\n'), SUMMARY_MAX_TOTAL_CHARS)
}

function sanitizeConversation(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter(message => getMessageId(message))
}

function computeBoundaryIndex(messageCount: number, keepRecentMessages: number): number {
  if (messageCount <= 1) {
    return 0
  }
  return Math.max(0, messageCount - Math.min(keepRecentMessages, messageCount - 1) - 1)
}

function buildSummaryCandidate(
  request: StreamUnifiedChatRequest,
  messages: ConversationMessage[],
  keepRecentMessages: number,
): ConversationSummary {
  const boundaryIndex = computeBoundaryIndex(messages.length, keepRecentMessages)
  const summarizedMessages = messages.slice(0, boundaryIndex + 1)
  const truncationMessage = (summarizedMessages.at(-1) ?? messages.at(-1))!
  const resumeMessage = messages[Math.min(boundaryIndex + 1, messages.length - 1)] ?? truncationMessage
  const previousSummary = normalizeText(request.conversationSummary?.summary)
  const includesToolResults = summarizedMessages.some(message => message.toolResults.length > 0 || message.interpreterResults.length > 0)

  return create(ConversationSummarySchema, {
    summary: buildSummaryText(previousSummary, summarizedMessages),
    truncationLastBubbleIdInclusive: getMessageId(truncationMessage),
    clientShouldStartSendingFromInclusiveBubbleId: getMessageId(resumeMessage),
    previousConversationSummaryBubbleId: request.conversationSummary?.truncationLastBubbleIdInclusive ?? '',
    includesToolResults,
    strategy: includesToolResults ? SUMMARY_STRATEGY_TOOL_TRUNCATION : SUMMARY_STRATEGY_PLAIN_TEXT,
  })
}

function dedupeSummaries(summaries: ConversationSummary[]): ConversationSummary[] {
  const seen = new Set<string>()
  return summaries.filter((summary) => {
    const key = `${summary.truncationLastBubbleIdInclusive}::${summary.clientShouldStartSendingFromInclusiveBubbleId}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function buildCarryForwardSummary(request: StreamUnifiedChatRequest): ConversationSummary {
  const previous = request.conversationSummary
  if (previous) {
    return create(ConversationSummarySchema, {
      summary: previous.summary,
      truncationLastBubbleIdInclusive: previous.truncationLastBubbleIdInclusive,
      clientShouldStartSendingFromInclusiveBubbleId: previous.clientShouldStartSendingFromInclusiveBubbleId,
      previousConversationSummaryBubbleId: previous.previousConversationSummaryBubbleId,
      includesToolResults: previous.includesToolResults,
      strategy: previous.strategy || SUMMARY_STRATEGY_PLAIN_TEXT,
    })
  }

  return create(ConversationSummarySchema, {
    summary: 'No conversation history available to summarize.',
    truncationLastBubbleIdInclusive: '',
    clientShouldStartSendingFromInclusiveBubbleId: '',
    previousConversationSummaryBubbleId: '',
    includesToolResults: false,
    strategy: SUMMARY_STRATEGY_PLAIN_TEXT,
  })
}

export function buildSpeculativeConversationSummaries(request: StreamUnifiedChatRequest): ConversationSummary[] {
  const messages = sanitizeConversation(request.conversation)
  if (messages.length === 0) {
    return [buildCarryForwardSummary(request)]
  }

  const candidates = [
    buildSummaryCandidate(request, messages, SUMMARY_PRIMARY_KEEP_RECENT_MESSAGES),
    buildSummaryCandidate(request, messages, SUMMARY_DEEP_KEEP_RECENT_MESSAGES),
  ]

  return dedupeSummaries(candidates)
}

export function buildConversationSummary(request: StreamUnifiedChatRequest): ConversationSummary {
  return buildSpeculativeConversationSummaries(request)[0]
}
