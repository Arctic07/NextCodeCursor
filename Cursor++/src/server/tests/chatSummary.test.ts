import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  getLatestConversationSummary,
  listSpeculativeConversationSummaries,
  persistConversationSummaries,
} from '../database/chatSummaries'
import { resetAgentDatabaseForTests } from '../database/sqlite'
import {
  ConversationMessage_MessageType,
  ConversationMessage_ToolResultSchema,
  ConversationMessageSchema,
  StreamUnifiedChatRequestSchema,
} from '../gen/aiserver_v1_pb'
import { buildConversationSummary, buildSpeculativeConversationSummaries } from '../handlers/chat/summary'

function buildMessage(index: number, type: ConversationMessage_MessageType, text: string) {
  return create(ConversationMessageSchema, {
    bubbleId: `bubble-${index}`,
    text,
    type,
  })
}

let tmpDbPath = ''

beforeEach(async () => {
  tmpDbPath = join(tmpdir(), `.tmp-chat-summary-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  process.env.BYOK_AGENT_DB_PATH = tmpDbPath
  await resetAgentDatabaseForTests()
})

afterEach(async () => {
  await resetAgentDatabaseForTests()
  delete process.env.BYOK_AGENT_DB_PATH
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${tmpDbPath}${suffix}`)
    }
    catch {}
  }
})

it('buildConversationSummary returns primary truncation boundary before recent tail', () => {
  const request = create(StreamUnifiedChatRequestSchema, {
    conversationId: 'conv-1',
    conversation: [
      buildMessage(1, ConversationMessage_MessageType.HUMAN, 'User asks about repository structure'),
      buildMessage(2, ConversationMessage_MessageType.AI, 'Assistant explains the top-level folders'),
      buildMessage(3, ConversationMessage_MessageType.HUMAN, 'User asks how auto summarize works'),
      buildMessage(4, ConversationMessage_MessageType.AI, 'Assistant explains summary trigger thresholds'),
      buildMessage(5, ConversationMessage_MessageType.HUMAN, 'User asks about cached summaries'),
      buildMessage(6, ConversationMessage_MessageType.AI, 'Assistant describes cachedConversationSummary'),
      buildMessage(7, ConversationMessage_MessageType.HUMAN, 'User asks about truncation boundaries'),
      buildMessage(8, ConversationMessage_MessageType.AI, 'Assistant explains truncationLastBubbleIdInclusive'),
      buildMessage(9, ConversationMessage_MessageType.HUMAN, 'User asks about next request behavior'),
    ],
  })

  const summary = buildConversationSummary(request)

  expect(summary.truncationLastBubbleIdInclusive).toBe('bubble-3')
  expect(summary.clientShouldStartSendingFromInclusiveBubbleId).toBe('bubble-4')
  expect(summary.strategy).toBe('plain_text_summary')
  expect(summary.summary).toMatch(/\[user\] User asks about repository structure/)
  expect(summary.summary).toMatch(/\[assistant\] Assistant explains the top-level folders/)
})

it('buildSpeculativeConversationSummaries yields multiple truncation candidates for larger histories', () => {
  const request = create(StreamUnifiedChatRequestSchema, {
    conversationId: 'conv-1',
    conversation: Array.from({ length: 12 }, (_, index) => buildMessage(
      index + 1,
      index % 2 === 0 ? ConversationMessage_MessageType.HUMAN : ConversationMessage_MessageType.AI,
      `Message ${index + 1}`,
    )),
  })

  const summaries = buildSpeculativeConversationSummaries(request)

  expect(summaries.length).toBe(2)
  expect(summaries[0]?.truncationLastBubbleIdInclusive).toBe('bubble-6')
  expect(summaries[0]?.clientShouldStartSendingFromInclusiveBubbleId).toBe('bubble-7')
  expect(summaries[1]?.truncationLastBubbleIdInclusive).toBe('bubble-9')
  expect(summaries[1]?.clientShouldStartSendingFromInclusiveBubbleId).toBe('bubble-10')
})

it('buildConversationSummary carries previous summary context and tool-result markers', () => {
  const request = create(StreamUnifiedChatRequestSchema, {
    conversationId: 'conv-2',
    conversationSummary: {
      summary: 'Earlier messages discussed project setup and initial constraints.',
      truncationLastBubbleIdInclusive: 'bubble-prev',
    },
    conversation: [
      create(ConversationMessageSchema, {
        bubbleId: 'bubble-1',
        type: ConversationMessage_MessageType.HUMAN,
        text: 'Run the migration now.',
        toolResults: [create(ConversationMessage_ToolResultSchema, {
          toolCallId: 'tool-1',
          toolName: 'shell',
          content: 'migration output',
        })],
      }),
      buildMessage(2, ConversationMessage_MessageType.AI, 'Migration finished successfully.'),
      buildMessage(3, ConversationMessage_MessageType.HUMAN, 'Now explain what changed.'),
      buildMessage(4, ConversationMessage_MessageType.AI, 'I updated the schema and regenerated the types.'),
      buildMessage(5, ConversationMessage_MessageType.HUMAN, 'Anything else to verify?'),
      buildMessage(6, ConversationMessage_MessageType.AI, 'Run the tests and inspect the generated client.'),
      buildMessage(7, ConversationMessage_MessageType.HUMAN, 'Okay, continue.'),
    ],
  })

  const summary = buildConversationSummary(request)

  expect(summary.previousConversationSummaryBubbleId).toBe('bubble-prev')
  expect(summary.includesToolResults).toBe(true)
  expect(summary.strategy).toBe('arbitrary_summary_plus_tool_result_truncation')
  expect(summary.summary).toMatch(/Previous summarized context:/)
  expect(summary.summary).toMatch(/\[tool:shell\] migration output/)
})

it('conversation summaries persist latest and speculative variants to sqlite', async () => {
  const request = create(StreamUnifiedChatRequestSchema, {
    conversationId: 'conv-persist',
    conversation: Array.from({ length: 10 }, (_, index) => buildMessage(
      index + 1,
      index % 2 === 0 ? ConversationMessage_MessageType.HUMAN : ConversationMessage_MessageType.AI,
      `Persisted message ${index + 1}`,
    )),
  })

  const latest = buildConversationSummary(request)
  const speculative = buildSpeculativeConversationSummaries(request)

  await persistConversationSummaries('conv-persist', 'latest', [latest])
  await persistConversationSummaries('conv-persist', 'speculative', speculative)

  const loadedLatest = await getLatestConversationSummary('conv-persist')
  const loadedSpeculative = await listSpeculativeConversationSummaries('conv-persist')

  expect(loadedLatest).toBeTruthy()
  expect(loadedLatest?.truncationLastBubbleIdInclusive).toBe(latest.truncationLastBubbleIdInclusive)
  expect(loadedSpeculative.length).toBe(speculative.length)
  expect(
    loadedSpeculative.map(summary => summary.truncationLastBubbleIdInclusive).sort(),
  ).toEqual(
    speculative.map(summary => summary.truncationLastBubbleIdInclusive).sort(),
  )
})
