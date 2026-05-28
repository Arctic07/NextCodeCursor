import type { ParsedPatch } from '../handlers/agent/toolkit/definitions/ApplyPatch'
import { describe, expect, it } from 'vitest'
import { applyPatchToContent } from '../handlers/agent/toolkit/definitions/ApplyPatch'
import { applyStringEditToContent } from '../handlers/agent/toolkit/definitions/Edit'
import { resolveToolPath } from '../handlers/agent/toolkit/pathUtils'
import { buildEditPlan, buildExecArgs } from '../handlers/agent/tools'

describe('tool path handling', () => {
  it('preserves raw path strings and only rejects null bytes', () => {
    expect(resolveToolPath('src/index.ts', '/workspace/project')).toBe('src/index.ts')
    expect(resolveToolPath(' C:\\repo\\file.txt ')).toBe(' C:\\repo\\file.txt ')
    expect(() => resolveToolPath('bad\0path')).toThrow(/null bytes/)
  })

  it('preserves Edit paths, uses LF canonical text, and rejects ambiguous replacements', () => {
    const ambiguousPlan = buildEditPlan('Edit', {
      path: 'sample.txt',
      old_string: 'one',
      new_string: 'ONE',
    }, 'call-edit')
    expect(ambiguousPlan.path).toBe('sample.txt')
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
    }, 'call-edit')

    expect(plan.path).toBe('sample.txt')
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
    expect(result.fileText).toBe('one\nTWO\none\n')

    const resultWithRawCrlfNewString = applyStringEditToContent({
      path: plan.path,
      beforeContent: 'one\r\ntwo\r\n',
      oldString: 'two',
      newString: 'TWO\r\nTHREE',
      replaceAll: false,
    })
    expect(resultWithRawCrlfNewString.fileText).toBe('one\nTWO\nTHREE\n')
    expect(resultWithRawCrlfNewString.fileText).not.toContain('\r')
  })

  it('builds ApplyPatch plans without server-side path rewriting and applies patch to supplied content', () => {
    const plan = buildEditPlan('ApplyPatch', {
      patch: `*** Begin Patch
*** Update File: sample.txt
@@
-old
+new
*** End Patch
`,
    }, 'call-patch')

    expect(plan.kind).toBe('applyPatch')
    if (plan.kind !== 'applyPatch')
      throw new Error('expected applyPatch plan')
    expect(plan.path).toBe('sample.txt')
    expect(applyPatchToContent(plan.parsedPatch as ParsedPatch, 'old\n')).toBe('new\n')
    expect(applyPatchToContent(plan.parsedPatch as ParsedPatch, 'old\r\n')).toBe('new\n')
  })

  it('normalizes Write contents to LF canonical text and preserves relative paths', () => {
    const args = buildExecArgs('Write', {
      path: 'created.txt',
      contents: 'a\r\nb',
    }, 'call-write')

    expect(args.path).toBe('created.txt')
    expect(args.fileText).toBe('a\nb')
  })
})
