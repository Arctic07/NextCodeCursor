import type { LLMContentBlock, LLMMessage } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { buildMessages, parseRunRequest } from '../handlers/agent/protocol'
import { llmMessageToBlobMessage, normalizeBlobMessage, restoreBlobMessageToLLMMessage } from '../handlers/agent/transcript'
import {
  anthropicConversationCodec,
  encodeAnthropicRequestMessages,
  encodeGeminiRequestMessages,
  encodeOpenAIRequestMessages,
  geminiConversationCodec,
  openAIChatConversationCodec,
} from '../handlers/llm/conversationCodec'

// 1px PNG (base64)
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// ─── parseRunRequest: selectedImages extraction ─────────────────────────────

it('parseRunRequest extracts selectedImages from inline data (protobuf-es oneof)', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-img-1',
      action: {
        userMessageAction: {
          userMessage: {
            text: 'describe this image',
            mode: 'AGENT_MODE_AGENT',
            selectedContext: {
              selectedImages: [
                {
                  uuid: 'img-uuid-1',
                  path: '/tmp/screenshot.png',
                  mimeType: 'image/png',
                  dimension: { width: 800, height: 600 },
                  dataOrBlobId: {
                    case: 'data',
                    value: Buffer.from(TINY_PNG_BASE64, 'base64'),
                  },
                },
              ],
            },
          },
          requestContext: {},
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  expect(parsed.selectedImages).toHaveLength(1)
  expect(parsed.selectedImages[0]!.mimeType).toBe('image/png')
  expect(parsed.selectedImages[0]!.data).toBe(TINY_PNG_BASE64)
  expect(parsed.userText).toBe('describe this image')
})

it('parseRunRequest extracts selectedImages from blobIdWithData', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-img-2',
      action: {
        userMessageAction: {
          userMessage: {
            text: 'what is this',
            mode: 'AGENT_MODE_AGENT',
            selectedContext: {
              selectedImages: [
                {
                  uuid: 'img-uuid-2',
                  mimeType: 'image/jpeg',
                  dataOrBlobId: {
                    case: 'blobIdWithData',
                    value: {
                      blobId: Buffer.from('blob-ref-123'),
                      data: Buffer.from(TINY_PNG_BASE64, 'base64'),
                    },
                  },
                },
              ],
            },
          },
          requestContext: {},
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  expect(parsed.selectedImages).toHaveLength(1)
  expect(parsed.selectedImages[0]!.mimeType).toBe('image/jpeg')
  expect(parsed.selectedImages[0]!.data).toBe(TINY_PNG_BASE64)
})

it('parseRunRequest skips images with blob-only reference (no inline data)', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-img-3',
      action: {
        userMessageAction: {
          userMessage: {
            text: 'hello',
            mode: 'AGENT_MODE_AGENT',
            selectedContext: {
              selectedImages: [
                {
                  uuid: 'img-uuid-3',
                  mimeType: 'image/png',
                  dataOrBlobId: {
                    case: 'blobId',
                    value: Buffer.from('blob-only-ref'),
                  },
                },
              ],
            },
          },
          requestContext: {},
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  expect(parsed.selectedImages).toHaveLength(0)
})

it('parseRunRequest extracts multiple images', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-img-4',
      action: {
        userMessageAction: {
          userMessage: {
            text: 'compare these',
            mode: 'AGENT_MODE_AGENT',
            selectedContext: {
              selectedImages: [
                {
                  uuid: 'img-a',
                  mimeType: 'image/png',
                  dataOrBlobId: { case: 'data', value: Buffer.from(TINY_PNG_BASE64, 'base64') },
                },
                {
                  uuid: 'img-b',
                  mimeType: 'image/webp',
                  dataOrBlobId: { case: 'data', value: Buffer.from(TINY_PNG_BASE64, 'base64') },
                },
              ],
            },
          },
          requestContext: {},
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  expect(parsed.selectedImages).toHaveLength(2)
  expect(parsed.selectedImages[0]!.mimeType).toBe('image/png')
  expect(parsed.selectedImages[1]!.mimeType).toBe('image/webp')
})

// ─── parseRunRequest: Cursor actual JSON format (toJson flattened oneof) ─────

it('parseRunRequest extracts image from Cursor actual format (blobIdWithData as top-level field)', () => {
  // Cursor toJson() flattens oneof: blobIdWithData appears as top-level field, not inside dataOrBlobId
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-img-cursor-1',
      action: {
        userMessageAction: {
          userMessage: {
            text: 'describe this screenshot',
            mode: 'AGENT_MODE_AGENT',
            selectedContext: {
              selectedImages: [
                {
                  uuid: '57e2db9d-74dc-4069-a1ad-184333d45a8d',
                  path: '/Users/test/images/screenshot.png',
                  dimension: { width: 486, height: 308 },
                  mimeType: 'image/png',
                  blobIdWithData: {
                    blobId: 'yP8grk25gcgFbclhHcM2bV8pnjJiDBB3MLLl2yzMCqQ=',
                    data: TINY_PNG_BASE64,
                  },
                },
              ],
            },
          },
          requestContext: {},
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  expect(parsed.selectedImages).toHaveLength(1)
  expect(parsed.selectedImages[0]!.mimeType).toBe('image/png')
  expect(parsed.selectedImages[0]!.data).toBe(TINY_PNG_BASE64)
})

it('parseRunRequest extracts image from Cursor actual format (data as top-level field)', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-img-cursor-2',
      action: {
        userMessageAction: {
          userMessage: {
            text: 'what is this',
            mode: 'AGENT_MODE_AGENT',
            selectedContext: {
              selectedImages: [
                {
                  uuid: 'img-flat-data',
                  mimeType: 'image/jpeg',
                  data: TINY_PNG_BASE64,
                },
              ],
            },
          },
          requestContext: {},
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  expect(parsed.selectedImages).toHaveLength(1)
  expect(parsed.selectedImages[0]!.mimeType).toBe('image/jpeg')
  expect(parsed.selectedImages[0]!.data).toBe(TINY_PNG_BASE64)
})

it('parseRunRequest skips blob-only reference in Cursor flat format', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-img-cursor-3',
      action: {
        userMessageAction: {
          userMessage: {
            text: 'hello',
            mode: 'AGENT_MODE_AGENT',
            selectedContext: {
              selectedImages: [
                {
                  uuid: 'img-blob-only',
                  mimeType: 'image/png',
                  blobId: 'yP8grk25gcgFbclhHcM2bV8pnjJiDBB3MLLl2yzMCqQ=',
                },
              ],
            },
          },
          requestContext: {},
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  expect(parsed.selectedImages).toHaveLength(0)
})

it('parseRunRequest returns empty selectedImages when no images attached', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-img-5',
      action: {
        userMessageAction: {
          userMessage: { text: 'no images', mode: 'AGENT_MODE_AGENT' },
          requestContext: {},
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  expect(parsed.selectedImages).toHaveLength(0)
})

// ─── buildMessages: image content blocks ────────────────────────────────────

it('buildMessages returns LLMContentBlock[] with image blocks when images present', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-build-img',
      action: {
        userMessageAction: {
          userMessage: {
            text: 'what is this',
            mode: 'AGENT_MODE_AGENT',
            selectedContext: {
              selectedImages: [{
                uuid: 'img-build',
                mimeType: 'image/png',
                dataOrBlobId: { case: 'data', value: Buffer.from(TINY_PNG_BASE64, 'base64') },
              }],
            },
          },
          requestContext: { env: { workspacePaths: ['/workspace'] } },
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  const [systemMsg, _preambleMsg, currentUserMsg] = buildMessages(parsed)

  expect(systemMsg!.role).toBe('system')
  expect(typeof systemMsg!.content).toBe('string')

  // currentUserMsg.content should be LLMContentBlock[] when images present
  expect(Array.isArray(currentUserMsg!.content)).toBe(true)
  const blocks = currentUserMsg!.content as LLMContentBlock[]

  const imageBlocks = blocks.filter(b => b.type === 'image')
  const textBlocks = blocks.filter(b => b.type === 'text')

  expect(imageBlocks).toHaveLength(1)
  expect(textBlocks).toHaveLength(1)

  const img = imageBlocks[0] as Extract<LLMContentBlock, { type: 'image' }>
  expect(img.mimeType).toBe('image/png')
  expect(img.data).toBe(TINY_PNG_BASE64)

  const txt = textBlocks[0] as Extract<LLMContentBlock, { type: 'text' }>
  expect(txt.text).toMatch(/<user_query>/)
  expect(txt.text).toMatch(/what is this/)
})

it('buildMessages returns plain string content when no images', () => {
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-build-noimgs',
      action: {
        userMessageAction: {
          userMessage: { text: 'just text', mode: 'AGENT_MODE_AGENT' },
          requestContext: { env: { workspacePaths: ['/workspace'] } },
        },
      },
      modelDetails: { modelId: 'claude-sonnet-4' },
    },
  })

  const [, , currentUserMsg] = buildMessages(parsed)
  expect(typeof currentUserMsg!.content).toBe('string')
  expect(currentUserMsg!.content as string).toMatch(/<user_query>\njust text\n<\/user_query>/)
})

// ─── Anthropic codec: image block encoding ──────────────────────────────────

it('anthropic codec preserves image blocks in user messages', () => {
  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/png', data: TINY_PNG_BASE64 },
        { type: 'text', text: 'describe this' },
      ],
    },
  ]

  const normalized = anthropicConversationCodec.normalizeMessages(messages)
  expect(normalized).toHaveLength(1)
  const blocks = normalized[0]!.content as LLMContentBlock[]
  expect(blocks.some(b => b.type === 'image')).toBe(true)
})

it('anthropic request encoding converts image blocks to base64 source format', () => {
  const encoded = encodeAnthropicRequestMessages([
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/jpeg', data: TINY_PNG_BASE64 },
        { type: 'text', text: 'what is this' },
      ],
    },
  ])

  expect(encoded.system).toBe('sys')
  expect(encoded.messages).toHaveLength(1)

  const userMsg = encoded.messages[0]!
  expect(userMsg.role).toBe('user')
  const content = userMsg.content as unknown as Array<Record<string, unknown>>
  expect(content).toHaveLength(2)

  const imageBlock = content[0]!
  expect(imageBlock.type).toBe('image')
  const source = imageBlock.source as Record<string, unknown>
  expect(source.type).toBe('base64')
  expect(source.media_type).toBe('image/jpeg')
  expect(source.data).toBe(TINY_PNG_BASE64)

  const textBlock = content[1]!
  expect(textBlock.type).toBe('text')
  expect(textBlock.text).toBe('what is this')
})

// ─── OpenAI codec: image block encoding ─────────────────────────────────────

it('openai codec preserves image blocks in user messages instead of collapsing to text', () => {
  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/png', data: TINY_PNG_BASE64 },
        { type: 'text', text: 'describe' },
      ],
    },
  ]

  const normalized = openAIChatConversationCodec.normalizeMessages(messages)
  expect(normalized).toHaveLength(1)

  // should NOT collapse to string when images present
  expect(Array.isArray(normalized[0]!.content)).toBe(true)
  const blocks = normalized[0]!.content as LLMContentBlock[]
  expect(blocks).toHaveLength(2)
  expect(blocks[0]!.type).toBe('image')
  expect(blocks[1]!.type).toBe('text')
})

it('openai codec collapses user message to text when no images', () => {
  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: ' world' },
      ],
    },
  ]

  const normalized = openAIChatConversationCodec.normalizeMessages(messages)
  expect(typeof normalized[0]!.content).toBe('string')
  expect(normalized[0]!.content).toBe('hello world')
})

it('openai request encoding converts image blocks to data URI format', () => {
  const encoded = encodeOpenAIRequestMessages([
    {
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/png', data: TINY_PNG_BASE64 },
        { type: 'text', text: 'what is this' },
      ],
    },
  ])

  expect(encoded).toHaveLength(1)
  const userMsg = encoded[0]!
  expect(userMsg.role).toBe('user')

  const content = (userMsg as { content: unknown[] }).content
  expect(content).toHaveLength(2)

  const imagepart = content[0] as Record<string, unknown>
  expect(imagepart.type).toBe('image_url')
  const imageUrl = imagepart.image_url as Record<string, unknown>
  expect(imageUrl.url).toBe(`data:image/png;base64,${TINY_PNG_BASE64}`)
  expect(imageUrl.detail).toBe('high')

  const textPart = content[1] as Record<string, unknown>
  expect(textPart.type).toBe('text')
  expect(textPart.text).toBe('what is this')
})

// ─── Gemini codec: image block encoding ─────────────────────────────────────

it('gemini codec preserves image blocks in user messages', () => {
  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/webp', data: TINY_PNG_BASE64 },
        { type: 'text', text: 'analyze' },
      ],
    },
  ]

  const normalized = geminiConversationCodec.normalizeMessages(messages)
  expect(normalized).toHaveLength(1)
  const blocks = normalized[0]!.content as LLMContentBlock[]
  expect(blocks.some(b => b.type === 'image')).toBe(true)
})

it('gemini request encoding converts image blocks to inlineData format', () => {
  const encoded = encodeGeminiRequestMessages([
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/webp', data: TINY_PNG_BASE64 },
        { type: 'text', text: 'describe' },
      ],
    },
  ])

  expect(encoded.systemInstruction).toBe('sys')
  expect(encoded.contents).toHaveLength(1)

  const userContent = encoded.contents[0]!
  expect(userContent.role).toBe('user')
  expect(userContent.parts).toHaveLength(2)

  const imagePart = userContent.parts![0]!
  expect(imagePart.inlineData).toBeTruthy()
  expect(imagePart.inlineData!.mimeType).toBe('image/webp')
  expect(imagePart.inlineData!.data).toBe(TINY_PNG_BASE64)

  const textPart = userContent.parts![1]!
  expect(textPart.text).toBe('describe')
})

// ─── storedTranscript: image block round-trip ───────────────────────────────

it('image block survives normalizeBlobMessage → restoreBlobMessageToLLMMessage round-trip', () => {
  const original: LLMMessage = {
    role: 'user',
    content: [
      { type: 'image', mimeType: 'image/png', data: TINY_PNG_BASE64 },
      { type: 'text', text: 'describe this screenshot' },
    ],
  }

  const blob = normalizeBlobMessage({
    role: original.role,
    content: original.content,
  })
  const restored = restoreBlobMessageToLLMMessage(blob as unknown as Record<string, unknown>)

  expect(restored).toBeTruthy()
  expect(Array.isArray(restored!.content)).toBe(true)
  const blocks = restored!.content as LLMContentBlock[]
  expect(blocks).toHaveLength(2)

  const imgBlock = blocks[0] as Extract<LLMContentBlock, { type: 'image' }>
  expect(imgBlock.type).toBe('image')
  expect(imgBlock.mimeType).toBe('image/png')
  expect(imgBlock.data).toBe(TINY_PNG_BASE64)

  const txtBlock = blocks[1] as Extract<LLMContentBlock, { type: 'text' }>
  expect(txtBlock.type).toBe('text')
  expect(txtBlock.text).toBe('describe this screenshot')
})

it('image block survives llmMessageToBlobMessage → restoreBlobMessageToLLMMessage round-trip', () => {
  const original: LLMMessage = {
    role: 'user',
    content: [
      { type: 'image', mimeType: 'image/jpeg', data: TINY_PNG_BASE64 },
      { type: 'text', text: 'what is this' },
    ],
  }

  const stored = llmMessageToBlobMessage(original)
  const restored = restoreBlobMessageToLLMMessage(stored as unknown as Record<string, unknown>)

  expect(restored).toBeTruthy()
  const blocks = restored!.content as LLMContentBlock[]
  const imgBlock = blocks.find(b => b.type === 'image') as Extract<LLMContentBlock, { type: 'image' }>
  expect(imgBlock).toBeTruthy()
  expect(imgBlock.mimeType).toBe('image/jpeg')
  expect(imgBlock.data).toBe(TINY_PNG_BASE64)
})

it('mixed content with image + tool_use + text normalizes and restores correctly', () => {
  const original: LLMMessage = {
    role: 'user',
    content: [
      { type: 'image', mimeType: 'image/gif', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' },
      { type: 'text', text: 'analyze the code in this screenshot' },
    ],
  }

  const blob = normalizeBlobMessage({
    role: original.role,
    content: original.content,
  })
  const restored = restoreBlobMessageToLLMMessage(blob as unknown as Record<string, unknown>)

  expect(restored).toBeTruthy()
  const blocks = restored!.content as LLMContentBlock[]
  expect(blocks).toHaveLength(2)
  expect(blocks[0]!.type).toBe('image')
  expect((blocks[0] as Extract<LLMContentBlock, { type: 'image' }>).mimeType).toBe('image/gif')
})
