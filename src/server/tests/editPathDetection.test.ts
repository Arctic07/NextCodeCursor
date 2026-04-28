import { expect, it } from 'vitest'
import { detectEditPathFromToolInput, EditDeltaExtractor, normalizeDetectedEditPath } from '../handlers/agent/conversationRuntime'

it('detects path for Write/Edit payloads', () => {
  expect(detectEditPathFromToolInput('Write', '{"contents":"hello","path":"src/a.ts"}')).toBe('src/a.ts')
  expect(detectEditPathFromToolInput('Edit', '{"path":"src/b.ts","old_string":"x","new_string":"y"}')).toBe('src/b.ts')
})

it('detects target_notebook for EditNotebook', () => {
  expect(detectEditPathFromToolInput('EditNotebook', '{"target_notebook":"notes/demo.ipynb","new_string":"x"}')).toBe('notes/demo.ipynb')
})

it('detects file path from ApplyPatch patch body', () => {
  const raw = '{"patch":"*** Begin Patch\\n*** Update File: src/c.ts\\n@@\\n*** End Patch\\n"}'
  expect(detectEditPathFromToolInput('ApplyPatch', raw)).toBe('src/c.ts')
})

it('returns empty string when path not yet in accumulated input', () => {
  expect(detectEditPathFromToolInput('ApplyPatch', '{"patch":"*** Begin Patch\\n@@"}')).toBe('')
})

it('normalizes detected edit paths for partial tool call bubbles', () => {
  expect(normalizeDetectedEditPath('src/a.ts', '/workspace/project')).toBe('/workspace/project/src/a.ts')
  expect(normalizeDetectedEditPath('C:relative.txt', 'C:\\repo')).toBe('C:relative.txt')
})

it('extracts new_string and detects path in single chunk', () => {
  const ext = new EditDeltaExtractor('Edit')
  const content = ext.feed('{"path":"src/a.ts","old_string":"hello","new_string":"world"}')
  expect(ext.detectedPath).toBe('src/a.ts')
  expect(content).toBe('world')
})

it('extracts new_string across multiple chunks', () => {
  const ext = new EditDeltaExtractor('Edit')
  expect(ext.feed('{"path":"src/a.ts",')).toBeNull()
  expect(ext.detectedPath).toBe('src/a.ts')
  expect(ext.feed('"old_string":"x","new_str')).toBeNull()
  expect(ext.feed('ing":"hello"}')).toBe('hello')
})

it('detects path after new_string (content-before-path)', () => {
  const ext = new EditDeltaExtractor('Edit')
  expect(ext.feed('{"old_string":"a","new_string":"b",')).toBe('b')
  expect(ext.detectedPath).toBe('')
  expect(ext.feed('"path":"src/late.ts"}')).toBeNull()
  expect(ext.detectedPath).toBe('src/late.ts')
})

it('extracts EditNotebook new_string', () => {
  const ext = new EditDeltaExtractor('EditNotebook')
  const content = ext.feed('{"target_notebook":"notes/demo.ipynb","old_string":"x","new_string":"y"}')
  expect(ext.detectedPath).toBe('notes/demo.ipynb')
  expect(content).toBe('y')
})

it('decodes JSON escapes in extracted content', () => {
  const ext = new EditDeltaExtractor('Edit')
  const content = ext.feed('{"path":"a.ts","old_string":"x","new_string":"line1\\nline2\\ttab"}')
  expect(content).toBe('line1\nline2\ttab')
})

it('handles backslash escape at chunk boundary', () => {
  const ext = new EditDeltaExtractor('Edit')
  // chunk 1 以裸 backslash 结尾 — 转义字符跨 chunk
  expect(ext.feed('{"path":"a.ts","old_string":"x","new_string":"hello')).toBe('hello')
  // chunk 2 开头是 \n 转义序列
  expect(ext.feed('\\nworld"}')).toBe('\nworld')
})
