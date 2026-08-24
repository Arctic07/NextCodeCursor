import { expect, it } from 'vitest'
import { buildShellToolResult, buildToolResultText } from '../handlers/agent/toolResults'

/**
 * Shell 输出截断 — 对齐 cursor-agent-exec 的 `co` 累加器 (ao = 1e4, 两侧各 5000)。
 *
 * 官方语义:
 *   合并输出 <= 10000  → interleaved_output 全文, 不填截断字段
 *   合并输出 >  10000  → interleaved_output 置空, 填 output_head/output_tail/elided_chars
 */

function shellInput() {
  return { command: 'pnpm build' }
}

it('keeps full output and omits truncation fields when combined output is within threshold', () => {
  const stdout = 'x'.repeat(4000)
  const stderr = 'y'.repeat(4000)

  const envelope = buildShellToolResult(shellInput(), { stdout, stderr, exitCode: 0 })
  const value = (envelope.result as { case: string, value: Record<string, unknown> }).value

  expect(value.output).toBe(stdout + stderr)
  expect(value.outputHead).toBeUndefined()
  expect(value.outputTail).toBeUndefined()
  expect(value.elidedChars).toBeUndefined()
})

it('emits head/tail/elided and clears interleaved output beyond threshold', () => {
  // 合并 20000 字符: head 取前 5000(全 A), tail 取后 5000(全 B)
  const stdout = 'A'.repeat(10000)
  const stderr = 'B'.repeat(10000)

  const envelope = buildShellToolResult(shellInput(), { stdout, stderr, exitCode: 1 })
  const value = (envelope.result as { case: string, value: Record<string, unknown> }).value

  expect((envelope.result as { case: string }).case).toBe('failure')
  expect(value.output).toBe('')
  expect(value.outputHead).toBe('A'.repeat(5000))
  expect(value.outputTail).toBe('B'.repeat(5000))
  expect(value.elidedChars).toBe(10000) // 20000 - 10000
  // stdout/stderr 仍保留原文 (官方各自上限 1MB)
  expect(value.stdout).toBe(stdout)
  expect(value.stderr).toBe(stderr)
})

it('renders head + elision marker + tail in tool result text, preserving the tail', () => {
  const stdout = `HEAD_MARKER${'a'.repeat(9989)}`
  const stderr = `${'b'.repeat(9989)}TAIL_MARKER`

  const envelope = buildShellToolResult(shellInput(), { stdout, stderr, exitCode: 1 })
  const text = buildToolResultText('shellToolCall', envelope, shellInput())

  expect(text).toContain('HEAD_MARKER')
  // 关键: 尾部必须保留 —— 朴素头部截断会把编译/测试报错丢掉
  expect(text).toContain('TAIL_MARKER')
  expect(text).toMatch(/chars elided/)
})

it('passes client-provided truncation fields through normalization', () => {
  // 客户端直接回完整 ShellResult 的路径 (后台 shell / AwaitShell)
  const raw = {
    result: {
      case: 'success',
      value: {
        command: 'pnpm test',
        workingDirectory: '/repo',
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: '',
        outputHead: 'CLIENT_HEAD',
        outputTail: 'CLIENT_TAIL',
        elidedChars: 4242,
      },
    },
  }

  const text = buildToolResultText('shellToolCall', raw, { command: 'pnpm test' })
  expect(text).toContain('CLIENT_HEAD')
  expect(text).toContain('CLIENT_TAIL')
  expect(text).toContain('4242 chars elided')
})
