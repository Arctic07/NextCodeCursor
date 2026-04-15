import { describe, expect, it } from 'vitest'
import { cacheBlob, resetBlobCacheForTests } from '../handlers/agent/blobStore'
import { collectExtraContextBlobIds, parseRunRequest, resolveExtraContextBlobs } from '../handlers/agent/protocol'

function minimalRun(extraEntries: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    runRequest: {
      conversationId: 'c',
      action: {
        userMessageAction: {
          userMessage: {
            text: 't',
            selectedContext: { extraContextEntries: extraEntries },
          },
          requestContext: {},
        },
      },
      modelDetails: { modelId: 'm' },
    },
  }
}

describe('resolveExtraContextBlobs — Step 4', () => {
  it('replaces blobId entries with their base64-decoded text content when cached', () => {
    resetBlobCacheForTests()
    const text = 'inline extra context fetched from blob store'
    cacheBlob('blob-A', Buffer.from(text, 'utf-8').toString('base64'))

    const parsed = parseRunRequest(minimalRun([
      { dataOrBlobId: { case: 'blobId', value: 'blob-A' } },
      { data: 'inline-literal' },
    ]))
    expect(collectExtraContextBlobIds(parsed)).toEqual(['blob-A'])

    const { resolved, missed } = resolveExtraContextBlobs(parsed)
    expect(resolved).toBe(1)
    expect(missed).toBe(0)
    expect(parsed.extraContextEntries[0]).toEqual({ data: text })
    expect(parsed.extraContextEntries[1]).toEqual({ data: 'inline-literal' })
  })

  it('keeps blobId pending when the blob is not in the cache', () => {
    resetBlobCacheForTests()
    const parsed = parseRunRequest(minimalRun([
      { dataOrBlobId: { case: 'blobId', value: 'missing-blob' } },
    ]))
    const { resolved, missed } = resolveExtraContextBlobs(parsed)
    expect(resolved).toBe(0)
    expect(missed).toBe(1)
    expect(parsed.extraContextEntries[0].blobId).toBe('missing-blob')
    expect(parsed.extraContextEntries[0].data).toBeUndefined()
  })
})

describe('normalizeMcpInputSchema — Step 3 defensive', () => {
  function parsedWithSchema(schema: unknown) {
    return parseRunRequest({
      runRequest: {
        conversationId: 'c',
        action: {
          userMessageAction: {
            userMessage: { text: 't' },
            requestContext: {
              tools: [
                { name: 'user-fs-read', description: 'd', inputSchema: schema, providerIdentifier: 'p', toolName: 'read' },
              ],
            },
          },
        },
        modelDetails: { modelId: 'm' },
      },
    })
  }

  it('passes through a standard JSON Schema object untouched', () => {
    const s = { type: 'object', properties: { path: { type: 'string' } } }
    const parsed = parsedWithSchema(s)
    expect(parsed.mcpTools[0].inputSchema).toEqual(s)
  })

  it('coerces undefined / non-object schemas to { type: "object" }', () => {
    expect(parsedWithSchema(undefined).mcpTools[0].inputSchema).toEqual({ type: 'object' })
    expect(parsedWithSchema(null).mcpTools[0].inputSchema).toEqual({ type: 'object' })
    expect(parsedWithSchema('string-not-object').mcpTools[0].inputSchema).toEqual({ type: 'object' })
  })

  it('unwraps google.protobuf.Value-wrapped schema shapes', () => {
    const protoValue = {
      structValue: {
        fields: {
          type: { stringValue: 'object' },
          properties: {
            structValue: {
              fields: {
                path: { structValue: { fields: { type: { stringValue: 'string' } } } },
              },
            },
          },
        },
      },
    }
    const parsed = parsedWithSchema(protoValue)
    const schema = parsed.mcpTools[0].inputSchema
    // unwrapped form: type=object, properties contains unwrapped path def
    expect(schema.type).toBe('object')
    expect((schema.properties as Record<string, unknown>).type).toBe('object')
    // the inner struct { fields: { type: 'string' } } became an object with those fields
    const propsRoot = schema.properties as Record<string, unknown>
    const pathSpec = propsRoot.properties as Record<string, unknown> | undefined
    expect(pathSpec?.path).toBeDefined()
  })
})
