import { toBinary } from '@bufbuild/protobuf'
/**
 * Proto 帧构造回归测试
 *
 * 这里不再在生产路径做额外 toBinary 预验证；测试仅覆盖关键帧最终
 * protobuf binary 序列化安全性，以及 MCP image bytes 规范化。
 */
import { describe, expect, it } from 'vitest'
import { AgentServerMessageSchema } from '../gen/agent_v1_pb'
import { toProtoValueMap } from '../handlers/agent/protoValue'
import { execMessage, toolCallCompleted, toolCallStarted } from '../handlers/agent/stream'
import { buildFileExecToolResult } from '../handlers/agent/toolkit/results/fileToolResults'
import { normalizeImageData } from '../handlers/agent/toolkit/results/mcpToolResults'

describe('关键 AgentServerMessage 帧可正常 toBinary 序列化', () => {
  it('toolCallStarted: readToolCall 帧安全', () => {
    const frame = toolCallStarted('call-1', 'readToolCall', { path: '/test.ts' }, 'model-1')
    expect(frame).toBeDefined()
    expect(() => toBinary(AgentServerMessageSchema, frame)).not.toThrow()
  })

  it('toolCallStarted: shellToolCall 帧安全', () => {
    const frame = toolCallStarted('call-2', 'shellToolCall', {
      command: 'ls -la',
      workingDirectory: '/tmp',
    }, 'model-1')
    expect(frame).toBeDefined()
    expect(() => toBinary(AgentServerMessageSchema, frame)).not.toThrow()
  })

  it('toolCallCompleted: readToolCall 带 success result 帧安全', () => {
    const frame = toolCallCompleted(
      'call-1',
      'readToolCall',
      { path: '/test.ts' },
      { result: { case: 'success', value: { content: 'file content' } } },
      'model-1',
    )
    expect(() => toBinary(AgentServerMessageSchema, frame)).not.toThrow()
  })

  it('toolCallCompleted: readToolCall 带 binary data (图片) result 帧安全', () => {
    const fakeImageBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const frame = toolCallCompleted(
      'call-img',
      'readToolCall',
      { path: '/test.png' },
      {
        result: {
          case: 'success',
          value: {
            path: '/test.png',
            totalLines: 0,
            fileSize: 8,
            output: { case: 'data', value: fakeImageBytes },
          },
        },
      },
      'model-1',
    )
    expect(() => toBinary(AgentServerMessageSchema, frame)).not.toThrow()
  })

  it('toolCallCompleted: readToolCall 带 dataBlobId result 帧安全', () => {
    const blobId = new Uint8Array([0x01, 0x02, 0x03])
    const frame = toolCallCompleted(
      'call-blob',
      'readToolCall',
      { path: '/test.png' },
      {
        result: {
          case: 'success',
          value: {
            path: '/test.png',
            totalLines: 0,
            fileSize: 1024,
            output: { case: 'dataBlobId', value: blobId },
          },
        },
      },
      'model-1',
    )
    expect(() => toBinary(AgentServerMessageSchema, frame)).not.toThrow()
  })

  it('toolCallCompleted: readToolCall 带 error result 帧安全', () => {
    const frame = toolCallCompleted(
      'call-1',
      'readToolCall',
      { path: '/nonexist' },
      { result: { case: 'error', value: { message: 'file not found' } } },
      'model-1',
    )
    expect(() => toBinary(AgentServerMessageSchema, frame)).not.toThrow()
  })

  it('execMessage: readArgs 帧安全', () => {
    const frame = execMessage(1, 'exec-1', 'readArgs', { path: '/test.ts' })
    expect(() => toBinary(AgentServerMessageSchema, frame)).not.toThrow()
  })

  it('execMessage: mcpArgs 帧安全 (正确构造的 MCP args)', () => {
    const frame = execMessage(1, 'exec-mcp', 'mcpArgs', {
      name: 'browser_navigate',
      args: toProtoValueMap({ url: 'https://example.com' }),
      toolCallId: 'call-1',
      providerIdentifier: 'cursor-ide-browser',
      toolName: 'browser_navigate',
    })
    expect(() => toBinary(AgentServerMessageSchema, frame)).not.toThrow()
  })

  it('toolCallCompleted: mcpToolCall 带 text content 帧安全', () => {
    const frame = toolCallCompleted(
      'call-mcp',
      'mcpToolCall',
      { name: 'test', args: {}, toolCallId: 'c', providerIdentifier: 'p', toolName: 't' },
      {
        result: {
          case: 'success',
          value: {
            content: [{
              content: { case: 'text', value: { text: 'hello world' } },
            }],
          },
        },
      },
      'model-1',
    )
    expect(() => toBinary(AgentServerMessageSchema, frame)).not.toThrow()
  })
})

describe('readToolCall binary data — toJson() base64 string 安全编码', () => {
  it('buildFileExecToolResult 处理 base64 data (toJson 输出) → toBinary 安全', () => {
    //
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47]).toString('base64')
    const envelope = buildFileExecToolResult('readToolCall', {
      readResult: {
        success: {
          path: '/test.png',
          totalLines: 0,
          fileSize: 4,
          data: pngHeader, // toJson() 会把 bytes 转为 base64 string
        },
      },
    }, { path: '/test.png' })
    expect(envelope).not.toBeNull()
    const frame = toolCallCompleted('call-b64', 'readToolCall', { path: '/test.png' }, envelope, 'model-1')
    expect(() => toBinary(AgentServerMessageSchema, frame)).not.toThrow()
  })

  it('buildFileExecToolResult 处理 dataBlobId → toBinary 安全', () => {
    //
    const blobId = Buffer.from('blob-123').toString('base64')
    const envelope = buildFileExecToolResult('readToolCall', {
      readResult: {
        success: {
          path: '/test.png',
          totalLines: 0,
          fileSize: 1024,
          dataBlobId: blobId,
        },
      },
    }, { path: '/test.png' })
    expect(envelope).not.toBeNull()
    const output = (envelope as any).result.value.output
    expect(output.case).toBe('dataBlobId')
    expect(output.value).toBeInstanceOf(Uint8Array)
  })
})

describe('normalizeImageData — MCP image bytes 转换', () => {
  it('normalizeImageData 将 base64 string 转为 Uint8Array', () => {
    const result = normalizeImageData('aGVsbG8=') // "hello" base64
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(result).toString('utf-8')).toBe('hello')
  })

  it('normalizeImageData 对 undefined 返回空 Uint8Array (不 crash)', () => {
    const result = normalizeImageData(undefined)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(0)
  })

  it('normalizeImageData 对 null 返回空 Uint8Array (不 crash)', () => {
    const result = normalizeImageData(null)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(0)
  })

  it('normalizeImageData 对 Uint8Array 原样返回', () => {
    const input = new Uint8Array([1, 2, 3])
    const result = normalizeImageData(input)
    expect(result).toBe(input)
  })

  it('normalizeImageData 对 Buffer 转为 Uint8Array', () => {
    const input = Buffer.from('test')
    const result = normalizeImageData(input)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(result).toString()).toBe('test')
  })
})
