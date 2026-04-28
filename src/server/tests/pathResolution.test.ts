import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveToolPath } from '../handlers/agent/toolkit/pathUtils'
import { buildExecArgs } from '../handlers/agent/tools'

describe('tool path resolution', () => {
  it('resolves relative paths against workspace instead of process cwd', () => {
    expect(resolveToolPath('src/index.ts', '/workspace/project')).toBe('/workspace/project/src/index.ts')
  })

  it('normalizes Windows absolute, MSYS, UNC, and drive-relative paths', () => {
    expect(resolveToolPath('src/index.ts', 'C:\\repo')).toBe('C:\\repo\\src\\index.ts')
    expect(resolveToolPath('/c/Users/me/project/file.ts', 'C:\\repo')).toBe('C:\\Users\\me\\project\\file.ts')
    expect(resolveToolPath('//server/share/project/file.ts', 'C:\\repo')).toBe('\\\\server\\share\\project\\file.ts')
    expect(() => resolveToolPath('C:relative.txt', 'C:\\repo')).toThrow(/drive-relative/)
  })
})

describe('edit/write tool path handling', () => {
  it('resolves Edit paths, preserves CRLF, and rejects ambiguous replacements', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-edit-'))
    try {
      const file = join(dir, 'sample.txt')
      writeFileSync(file, 'one\r\ntwo\r\none\r\n', 'utf8')

      expect(() => buildExecArgs('Edit', {
        path: 'sample.txt',
        old_string: 'one',
        new_string: 'ONE',
      }, 'call-edit', { workspacePath: dir })).toThrow(/Found 2 matches/)

      const args = buildExecArgs('Edit', {
        path: 'sample.txt',
        old_string: 'two',
        new_string: 'TWO',
      }, 'call-edit', { workspacePath: dir })

      expect(args.path).toBe(file)
      expect(args.fileText).toBe('one\r\nTWO\r\none\r\n')
      expect(args.beforeContent).toBe('one\r\ntwo\r\none\r\n')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not normalize Write contents and still resolves relative paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-write-'))
    try {
      const args = buildExecArgs('Write', {
        path: 'created.txt',
        contents: 'a\r\nb',
      }, 'call-write', { workspacePath: dir })

      expect(args.path).toBe(join(dir, 'created.txt'))
      expect(args.fileText).toBe('a\r\nb')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
