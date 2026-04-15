import type { StoredMessage } from '../llm/storedTranscript'
import type { LLMContentBlock, LLMMessage } from '../llm/types'
import {
  llmMessageToStoredMessage,
  normalizeStoredMessage,
  restoreStoredMessage,
  storedMessageToLLMMessage,

} from '../llm/storedTranscript'

export interface BlobMessage {
  role: string
  content: unknown
  toolCallId?: string
  toolName?: string
  isError?: boolean
  id?: string
  providerOptions?: Record<string, unknown>
}

export function normalizeBlobMessage(message: BlobMessage): StoredMessage {
  return normalizeStoredMessage(message)
}

export function restoreBlobMessageToLLMMessage(message: Record<string, unknown>): LLMMessage | null {
  const stored = restoreStoredMessage(message)
  return stored ? storedMessageToLLMMessage(stored) : null
}

export function llmMessageToBlobMessage(message: LLMMessage): StoredMessage {
  return llmMessageToStoredMessage(message)
}

export function summarizeAssistantContent(content: string | LLMContentBlock[] | undefined): { thinking?: string, text?: string } {
  if (!Array.isArray(content)) {
    return { text: typeof content === 'string' && content ? content : undefined }
  }

  const thinking = content
    .filter(block => block.type === 'thinking')
    .map(block => block.text)
    .join('')
  const text = content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')

  return {
    thinking: thinking || undefined,
    text: text || undefined,
  }
}
