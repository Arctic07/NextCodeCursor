import { describe, expect, it } from 'vitest'
import { buildMessages } from '../handlers/agent/protocol'

function preambleOf(msgs: ReturnType<typeof buildMessages>): string {
  const preamble = msgs[1].content
  return typeof preamble === 'string' ? preamble : preamble.map(b => (b.type === 'text' ? b.text : '')).join('')
}

function stubParsed(overrides: Record<string, unknown>): Parameters<typeof buildMessages>[0] {
  return {
    userText: 'q',
    modelId: 'claude-sonnet-4',
    conversationId: 'c',
    mode: 'AGENT_MODE_AGENT',
    isSummarize: false,
    userRules: [],
    projectRules: [],
    agentSkills: [],
    env: {},
    isGitRepo: false,
    mcpServers: [],
    mcpBasePath: '',
    mcpTools: [],
    mcpInstructions: [],
    ideState: undefined,
    documentations: [],
    cursorCommands: [],
    selectedSkills: [],
    extraContextEntries: [],
    webSearchEnabled: false,
    webFetchEnabled: false,
    readLintsEnabled: false,
    historyBlobIds: [],
    historyTurns: [],
    historySummaryArchiveIds: [],
    selectedImages: [],
    prependUserMessages: [],
    isResume: false,
    conversationNotesListing: '',
    sharedNotesListing: '',
    ...overrides,
  } as Parameters<typeof buildMessages>[0]
}

describe('buildPreambleUserMessage — Step 2 injection', () => {
  it('emits <ide_state> block with visible + recentlyViewed files', () => {
    const pre = preambleOf(buildMessages(stubParsed({
      ideState: {
        visibleFiles: [
          { path: '/a/b.ts', relativePath: 'b.ts', totalLines: 100, cursorLine: 42, cursorText: 'const x = 1' },
        ],
        recentlyViewedFiles: [{ path: '/a/c.ts', totalLines: 50 }],
      },
    })))
    expect(pre).toContain('<ide_state')
    expect(pre).toContain('path="/a/b.ts"')
    expect(pre).toContain('cursorLine="42"')
    expect(pre).toContain('const x = 1')
    expect(pre).toContain('<recently_viewed_files>')
    expect(pre).toContain('path="/a/c.ts"')
  })

  it('skips <ide_state> entirely when absent or empty', () => {
    const pre = preambleOf(buildMessages(stubParsed({})))
    expect(pre).not.toContain('<ide_state')

    const pre2 = preambleOf(buildMessages(stubParsed({
      ideState: { visibleFiles: [], recentlyViewedFiles: [] },
    })))
    expect(pre2).not.toContain('<ide_state')
  })

  it('emits <mcp_instructions>, merging requestContext.mcp_instructions with mcpServers.serverUseInstructions', () => {
    const pre = preambleOf(buildMessages(stubParsed({
      mcpInstructions: [
        { serverName: 'fs', instructions: 'paths must be under /tmp', serverIdentifier: 'f1' },
      ],
      mcpServers: [
        { serverName: 'fs', folderPath: '/x', serverUseInstructions: 'ignored (already in instructions)' },
        { serverName: 'db', folderPath: '/y', serverUseInstructions: 'read-only' },
      ],
    })))
    expect(pre).toContain('<mcp_instructions')
    expect(pre).toContain('server="fs"')
    expect(pre).toContain('paths must be under /tmp')
    expect(pre).toContain('server="db"')
    expect(pre).toContain('read-only')
    expect(pre).not.toContain('ignored (already in instructions)')
  })

  it('emits <attached_skills>, <attached_docs>, <cursor_commands> blocks when fields present', () => {
    const pre = preambleOf(buildMessages(stubParsed({
      selectedSkills: [{ fullPath: '/skills/a.md', description: 'format helper' }],
      documentations: [{ docId: 'react', name: 'React Docs' }],
      cursorCommands: [{ name: 'lint', content: 'eslint .' }],
    })))
    expect(pre).toContain('<attached_skills')
    expect(pre).toContain('fullPath="/skills/a.md"')
    expect(pre).toContain('format helper')

    expect(pre).toContain('<attached_docs')
    expect(pre).toContain('docId="react"')
    expect(pre).toContain('name="React Docs"')

    expect(pre).toContain('<cursor_commands')
    expect(pre).toContain('name="lint"')
    expect(pre).toContain('eslint .')
  })

  it('emits <extra_context> with inline data and a pending placeholder for blob entries', () => {
    const pre = preambleOf(buildMessages(stubParsed({
      extraContextEntries: [
        { data: 'inline piece one' },
        { blobId: 'blob-xyz' },
        { data: 'inline piece two' },
      ],
    })))
    expect(pre).toContain('<extra_context')
    expect(pre).toContain('inline piece one')
    expect(pre).toContain('inline piece two')
    expect(pre).toContain('<extra_context_pending blob_count="1" />')
  })

  it('block ordering: ide_state before rules; mcp_instructions after skills', () => {
    const pre = preambleOf(buildMessages(stubParsed({
      userRules: ['be terse'],
      mcpInstructions: [{ serverName: 's', instructions: 'x', serverIdentifier: 'i' }],
      selectedSkills: [{ fullPath: '/s.md', description: 'd' }],
      ideState: { visibleFiles: [{ path: '/a.ts', totalLines: 1 }], recentlyViewedFiles: [] },
    })))
    const ide = pre.indexOf('<ide_state')
    const rules = pre.indexOf('<rules')
    const attachedSkills = pre.indexOf('<attached_skills')
    const mcp = pre.indexOf('<mcp_instructions')
    expect(ide).toBeGreaterThanOrEqual(0)
    expect(rules).toBeGreaterThan(ide)
    expect(attachedSkills).toBeGreaterThan(rules)
    expect(mcp).toBeGreaterThan(attachedSkills)
  })
})
