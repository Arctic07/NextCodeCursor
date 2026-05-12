import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import type { ToolCall, UserMessage } from '../../gen/agent_v1_pb'
import {
  AgentMode,
  AssistantMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  SimulatedMsgReason,
  ThinkingMessageSchema,
  UserMessageSchema,
} from '../../gen/agent_v1_pb'
import type { ParsedRunRequest } from './protocol/types'
import { encodeBinaryBlob } from './blob'
import { getCachedBlob } from './blobStore'
import { logger } from '../../logger'

function resolveAgentMode(mode: string): AgentMode {
  const normalized = mode.replace('AGENT_MODE_', '').toLowerCase()
  switch (normalized) {
    case 'agent': return AgentMode.AGENT
    case 'ask': return AgentMode.ASK
    case 'plan': return AgentMode.PLAN
    case 'debug': return AgentMode.DEBUG
    case 'triage': return AgentMode.TRIAGE
    default: return AgentMode.AGENT
  }
}

export interface EncodedBlob {
  blobId: string
  blobData: string
}

export interface TurnBaseline {
  userMessageBlobId: string
  stepBlobIds: string[]
  requestId?: string
}

export class ActiveTurnTracker {
  private readonly stepBlobIds: string[]

  constructor(
    readonly userMessageBlobId: string,
    stepBlobIds: string[] = [],
    readonly requestId?: string,
  ) {
    this.stepBlobIds = [...stepBlobIds]
  }

  static fromTurnBlobId(turnBlobId: string): ActiveTurnTracker | null {
    const baseline = readTurnBaseline(turnBlobId)
    if (!baseline)
      return null
    return new ActiveTurnTracker(baseline.userMessageBlobId, baseline.stepBlobIds, baseline.requestId)
  }

  addThinking(text: string, durationMs = 0): EncodedBlob | null {
    if (!text)
      return null
    const blob = encodeBinaryBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: 'thinkingMessage',
        value: create(ThinkingMessageSchema, {
          text,
          durationMs,
        }),
      },
    })))
    this.stepBlobIds.push(blob.blobId)
    return blob
  }

  addAssistantText(text: string): EncodedBlob | null {
    if (!text)
      return null
    const blob = encodeBinaryBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: 'assistantMessage',
        value: create(AssistantMessageSchema, {
          text,
        }),
      },
    })))
    this.stepBlobIds.push(blob.blobId)
    return blob
  }

  addCompletedToolCall(toolCall: ToolCall): EncodedBlob {
    const blob = encodeBinaryBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: 'toolCall',
        value: toolCall,
      },
    })))
    this.stepBlobIds.push(blob.blobId)
    return blob
  }

  materializeTurnBlob(): EncodedBlob {
    return encodeBinaryBlob(toBinary(ConversationTurnStructureSchema, create(ConversationTurnStructureSchema, {
      turn: {
        case: 'agentConversationTurn',
        value: {
          userMessage: Buffer.from(this.userMessageBlobId, 'base64'),
          steps: this.stepBlobIds.map(id => Buffer.from(id, 'base64')),
          ...(this.requestId ? { requestId: this.requestId } : {}),
        },
      },
    })))
  }
}

export function createCurrentTurnUserMessageBlob(params: {
  parsed: ParsedRunRequest
  fallbackMessageId: string
}): { blob: EncodedBlob, messageId: string } {
  const raw = params.parsed.rawUserMessage
  const messageId = typeof raw?.messageId === 'string' && raw.messageId.length > 0
    ? raw.messageId
    : params.fallbackMessageId

  const init: Partial<UserMessage> & Record<string, unknown> = {
    text: params.parsed.userText,
    messageId,
    mode: resolveAgentMode(params.parsed.mode),
  }

  if (typeof raw?.richText === 'string' && raw.richText.length > 0)
    init.richText = raw.richText

  if (params.parsed.isBackgroundTaskCompletion) {
    init.isSimulatedMsg = true
    init.simulatedMsgReason = SimulatedMsgReason.BACKGROUND_TASK_COMPLETION
  }

  const blob = encodeBinaryBlob(toBinary(UserMessageSchema, create(UserMessageSchema, init as any)))
  return { blob, messageId }
}

export function readTurnBaseline(turnBlobId: string): TurnBaseline | null {
  const blobData = getCachedBlob(turnBlobId)
  if (!blobData)
    return null
  try {
    const turn = fromBinary(ConversationTurnStructureSchema, Buffer.from(blobData, 'base64'))
    if (turn.turn.case !== 'agentConversationTurn')
      return null
    const value = turn.turn.value
    return {
      userMessageBlobId: Buffer.from(value.userMessage).toString('base64'),
      stepBlobIds: value.steps.map(step => Buffer.from(step).toString('base64')),
      requestId: value.requestId,
    }
  }
  catch (error) {
    logger.warn({ turnBlobId, error: (error as Error).message }, '[TURN] failed to decode turn baseline')
    return null
  }
}
