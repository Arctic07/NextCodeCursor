import type { ParsedPatch } from '../handlers/agent/toolkit/definitions/ApplyPatch'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatchToContent } from '../handlers/agent/toolkit/definitions/ApplyPatch'
import { applyStringEditToContent } from '../handlers/agent/toolkit/definitions/Edit'
import { resolveToolPath } from '../handlers/agent/toolkit/pathUtils'
import { buildEditPlan, buildExecArgs } from '../handlers/agent/tools'

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

      const ambiguousPlan = buildEditPlan('Edit', {
        path: 'sample.txt',
        old_string: 'one',
        new_string: 'ONE',
      }, 'call-edit', { workspacePath: dir })
      expect(ambiguousPlan.path).toBe(file)
      expect(() => applyStringEditToContent({
        path: ambiguousPlan.path,
        beforeContent: 'one\r\ntwo\r\none\r\n',
        oldString: 'one',
        newString: 'ONE',
        replaceAll: false,
      })).toThrow(/Found 2 matches/)

      const plan = buildEditPlan('Edit', {
        path: 'sample.txt',
        old_string: 'two',
        new_string: 'TWO',
      }, 'call-edit', { workspacePath: dir })

      expect(plan.path).toBe(file)
      expect(plan.kind).toBe('stringReplace')
      if (plan.kind !== 'stringReplace')
        throw new Error('expected stringReplace plan')
      const result = applyStringEditToContent({
        path: plan.path,
        beforeContent: 'one\r\ntwo\r\none\r\n',
        oldString: plan.oldString,
        newString: plan.newString,
        replaceAll: plan.replaceAll,
      })
      expect(result.fileText).toBe('one\r\nTWO\r\none\r\n')

      const resultWithRawCrlfNewString = applyStringEditToContent({
        path: plan.path,
        beforeContent: 'one\r\ntwo\r\n',
        oldString: 'two',
        newString: 'TWO\r\nTHREE',
        replaceAll: false,
      })
      expect(resultWithRawCrlfNewString.fileText).toBe('one\r\nTWO\r\nTHREE\r\n')
      expect(resultWithRawCrlfNewString.fileText).not.toContain('\r\r\n')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds ApplyPatch plans without reading server fs and applies patch to supplied content', () => {
    const plan = buildEditPlan('ApplyPatch', {
      patch: `*** Begin Patch
*** Update File: sample.txt
@@
-old
+new
*** End Patch
`,
    }, 'call-patch', { workspacePath: '/workspace' })

    expect(plan.kind).toBe('applyPatch')
    if (plan.kind !== 'applyPatch')
      throw new Error('expected applyPatch plan')
    expect(plan.path).toBe('/workspace/sample.txt')
    expect(applyPatchToContent(plan.parsedPatch as ParsedPatch, 'old\n')).toBe('new\n')
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
