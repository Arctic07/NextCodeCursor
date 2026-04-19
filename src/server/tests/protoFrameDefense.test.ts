import { toBinary } from '@bufbuild/protobuf'
/**
 * Proto 帧毒性防御测试
 *
 * 层 1: validateFrame — toBinary 预验证,毒帧在 Server 侧拦截 (throw ProtoSerializeError)
 * 层 2: runToolCall catch — 集成测试需要完整 session + client exec 握手,
 *       这里只验证 ProtoSerializeError 类型契约和帧构造的安全性。
 */
import { describe, expect, it } from 'vitest'
import { AgentServerMessageSchema } from '../gen/agent_v1_pb'
import { toProtoValueMap } from '../handlers/agent/protoValue'
import { execMessage, ProtoSerializeError, toolCallCompleted, toolCallStarted } from '../handlers/agent/stream'
import { normalizeImageData } from '../handlers/agent/toolkit/results/mcpToolResults'

describe('protoSerializeError 类型契约', () => {
  it('是 Error 子类,带 fieldHint', () => {
    const err = new ProtoSerializeError('test error', 'McpImageContent.data')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ProtoSerializeError)
    expect(err.name).toBe('ProtoSerializeError')
    expect(err.message).toBe('test error')
    expect(err.fieldHint).toBe('McpImageContent.data')
  })

  it('可被 catch 按类型区分', () => {
    let caught = false
    try {
      throw new ProtoSerializeError('test')
    }
    catch (e) {
      if (e instanceof ProtoSerializeError)
        caught = true
    }
    expect(caught).toBe(true)
  })
})

describe('层 1: 帧预验证 — 正常帧通过 toBinary 验证', () => {
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

describe('层 1: normalizeImageData 防御 — MCP image bytes 转换', () => {
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
