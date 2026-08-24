import type { LLMMessage } from '../handlers/llm/types'
import { describe, expect, it } from 'vitest'
import { formatMessageForSummary } from '../handlers/agent/compactionStrategy'
import { buildMcpToolResultText } from '../handlers/agent/toolkit/results/mcpToolResults'

/**
 * 两件与 MCP 大输出相关的事:
 *
 * 1. 溢写渲染 —— 客户端 (cursor-agent-exec) 在 MCP 工具响应超 40000 bytes 时
 *    写盘到 {projectDir}/agent-tools/{uuid}.txt,把 text 置空、改带
 *    output_location 回传。服务端若只读 text 会得到空串,LLM 只看到
 *    "MCP tool completed successfully."。
 *
 * 2. 摘要保护 —— GetDynamicTools 返回的是工具 schema,压缩成自然语言后精度丢失,
 *    而 LLM 会"记得"查过这些工具,拿编造的参数去调。
 */

function textItem(text: string, outputLocation?: Record<string, unknown>) {
  return { content: { case: 'text', value: { text, ...(outputLocation ? { outputLocation } : {}) } } }
}

describe('溢写输出渲染', () => {
  it('text 为空但有 outputLocation 时,渲染文件路径与大小', () => {
    const out = buildMcpToolResultText('mcpToolCall', 'success', {
      content: [textItem('', { filePath: '/proj/agent-tools/abc.txt', sizeBytes: 51200, lineCount: 1200 })],
    })
    expect(out).toContain('Content written to file: /proj/agent-tools/abc.txt')
    expect(out).toContain('50.0 KB')
    expect(out).toContain('1200 lines')
    // 绝不能退化成"成功但无输出"
    expect(out).not.toContain('MCP tool completed successfully.')
  })

  it('小于 1024 字节按 bytes 显示 (对齐客户端格式化)', () => {
    const out = buildMcpToolResultText('mcpToolCall', 'success', {
      content: [textItem('', { filePath: '/p/a.txt', sizeBytes: 512, lineCount: 3 })],
    })
    expect(out).toContain('Size: 512 bytes, 3 lines')
  })

  it('text 有内容时优先用 text,不受 outputLocation 影响', () => {
    const out = buildMcpToolResultText('mcpToolCall', 'success', {
      content: [textItem('actual inline output', { filePath: '/p/a.txt', sizeBytes: 10, lineCount: 1 })],
    })
    expect(out).toBe('actual inline output')
  })

  it('混合内容: 内联项与溢写项都保留', () => {
    const out = buildMcpToolResultText('mcpToolCall', 'success', {
      content: [
        textItem('first part'),
        textItem('', { filePath: '/p/b.txt', sizeBytes: 2048, lineCount: 40 }),
      ],
    })
    expect(out).toContain('first part')
    expect(out).toContain('/p/b.txt')
    expect(out).toContain('2.0 KB')
  })

  it('outputLocation 缺 filePath 时不产出半截文案', () => {
    const out = buildMcpToolResultText('mcpToolCall', 'success', {
      content: [textItem('', { sizeBytes: 100, lineCount: 2 })],
    })
    expect(out).toBe('MCP tool completed successfully.')
  })
})

describe('摘要时保护 MCP schema', () => {
  const SCHEMA_JSON = JSON.stringify({ mode: 'namespace', tools: [{ tool: 'decompile', inputSchema: {} }] })

  it('anthropic 形态: GetDynamicTools 结果替换为占位符', () => {
    const msg: LLMMessage = {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 't1', toolName: 'GetDynamicTools', content: SCHEMA_JSON }],
    }
    const out = formatMessageForSummary(msg)
    expect(out).toContain('omitted from summary')
    expect(out).toContain('call GetDynamicTools again')
    expect(out).not.toContain('inputSchema')
  })

  it('openai 形态: role=tool 消息同样被替换', () => {
    const msg: LLMMessage = {
      role: 'tool',
      content: SCHEMA_JSON,
      toolCallId: 't1',
      toolName: 'GetDynamicTools',
    }
    const out = formatMessageForSummary(msg)
    expect(out).toContain('omitted from summary')
    expect(out).not.toContain('inputSchema')
  })

  it('其他工具的结果原样进摘要', () => {
    const msg: LLMMessage = {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 't1', toolName: 'Shell', content: 'build succeeded' }],
    }
    expect(formatMessageForSummary(msg)).toContain('build succeeded')
  })

  it('openai 形态下非 GetDynamicTools 的输出格式保持不变', () => {
    const msg: LLMMessage = { role: 'tool', content: 'shell output', toolCallId: 't1', toolName: 'Shell' }
    const out = formatMessageForSummary(msg)
    expect(out).toContain('shell output')
    // 未加 [tool result] 前缀 —— 保持既有行为,避免影响所有历史会话的摘要
    expect(out).not.toContain('[tool result]')
  })
})
