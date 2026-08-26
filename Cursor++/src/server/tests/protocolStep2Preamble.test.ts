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
    requestContextTransport: 'legacy',
    clientSupportsDynamicTools: false,
    cursorDynamicTools: [],
    dynamicToolCount: 0,
    dynamicToolTransitionReminder: false,
    mode: 'AGENT_MODE_AGENT',
    isSummarize: false,
    isSubagent: false,
    isBackgroundTaskCompletion: false,
    backgroundTaskCompletions: [],
    userRules: [],
    alwaysRules: [],
    projectRules: [],
    cursorRules: [],
    agentSkills: [],
    customSubagents: [],
    disabledTeamRules: [],
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
    selectedCursorRules: [],
    extraContextEntries: [],
    webSearchEnabled: false,
    webFetchEnabled: false,
    readLintsEnabled: false,
    readPaths: [],
    historyBlobIds: [],
    historyTurnBlobIds: [],
    historyTurns: [],
    historySummaryArchiveIds: [],
    selectedImages: [],
    prependUserMessages: [],
    isResume: false,
    interruptedResolutions: [],
    isExecutePlan: false,
    conversationNotesListing: '',
    sharedNotesListing: '',
    codeSelections: [],
    terminalSelections: [],
    fileContents: {},
    projectLayouts: [],
    externalLinks: [],
    selectedSubagents: [],
    selectedBrowsers: [],
    recentAgentsContext: [],
    subagentModelOverrides: [],
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

  it('emits manually attached Skills, docs, and cursor commands when present', () => {
    const pre = preambleOf(buildMessages(stubParsed({
      selectedSkills: [{
        fullPath: '/skills/a/SKILL.md',
        content: 'Follow the formatter workflow.',
        description: 'format helper',
        disableModelInvocation: false,
        environments: [],
        disabledEnvironments: [],
        globs: [],
        scopedTo: [],
        raw: {},
      }],
      documentations: [{ docId: 'react', name: 'React Docs' }],
      cursorCommands: [{ name: 'lint', content: 'eslint .' }],
    })))
    expect(pre).toContain('<manually_attached_skills>')
    expect(pre).toContain('Path: /skills/a/SKILL.md')
    expect(pre).toContain('Follow the formatter workflow.')

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
      selectedSkills: [{
        fullPath: '/s/SKILL.md',
        content: 'do it',
        description: 'd',
        disableModelInvocation: false,
        environments: [],
        disabledEnvironments: [],
        globs: [],
        scopedTo: [],
        raw: {},
      }],
      ideState: { visibleFiles: [{ path: '/a.ts', totalLines: 1 }], recentlyViewedFiles: [] },
    })))
    const ide = pre.indexOf('<ide_state')
    const rules = pre.indexOf('<rules')
    const attachedSkills = pre.indexOf('<manually_attached_skills>')
    const mcp = pre.indexOf('<mcp_instructions')
    expect(ide).toBeGreaterThanOrEqual(0)
    expect(rules).toBeGreaterThan(ide)
    expect(attachedSkills).toBeGreaterThan(rules)
    expect(mcp).toBeGreaterThan(attachedSkills)
  })

  it('keeps always rules eager, lists agentFetched rules, and defers fileGlobbed bodies to Read', () => {
    const always = {
      fullPath: '/workspace/.cursor/rules/always.mdc',
      content: 'ALWAYS_BODY',
      kind: 'global',
      source: 0,
      globs: [],
      environments: [],
      disabledEnvironments: [],
      scopedTo: [],
      frontmatter: '',
      raw: {},
    }
    const globbed = {
      fullPath: '/workspace/.cursor/rules/typescript.mdc',
      content: 'GLOBBED_BODY',
      kind: 'fileGlobbed',
      source: 0,
      globs: ['**/*.ts'],
      environments: [],
      disabledEnvironments: [],
      scopedTo: [],
      frontmatter: '',
      raw: {},
    }
    const fetched = {
      fullPath: '/workspace/.cursor/rules/database.mdc',
      content: 'FETCHED_BODY',
      kind: 'agentFetched',
      source: 0,
      description: 'Database migrations',
      globs: [],
      environments: [],
      disabledEnvironments: [],
      scopedTo: [],
      frontmatter: '',
      raw: {},
    }
    const pre = preambleOf(buildMessages(stubParsed({
      env: { workspacePaths: ['/workspace'] },
      alwaysRules: [always],
      projectRules: [globbed, fetched],
      cursorRules: [always, globbed, fetched],
    })))

    expect(pre).toContain('<always_applied_workspace_rules')
    expect(pre).toContain('ALWAYS_BODY')
    expect(pre).toContain('<agent_requestable_workspace_rule fullPath="/workspace/.cursor/rules/database.mdc">Database migrations')
    expect(pre).not.toContain('FETCHED_BODY')
    expect(pre).not.toContain('GLOBBED_BODY')
    expect(pre).not.toContain('fullPath="/workspace/.cursor/rules/typescript.mdc"')
  })

  it('renders a path-based Skill catalog without leaking SKILL.md content', () => {
    const pre = preambleOf(buildMessages(stubParsed({
      contextTokenLimit: 200_000,
      agentSkills: [{
        fullPath: '/workspace/.cursor/skills/review/SKILL.md',
        content: 'SECRET_SKILL_BODY',
        description: 'Review code changes carefully.',
        disableModelInvocation: false,
        environments: [],
        disabledEnvironments: [],
        globs: [],
        scopedTo: [],
        raw: {},
      }],
    })))
    expect(pre).toContain('<agent_skills>')
    expect(pre).toContain('<agent_skill fullPath="/workspace/.cursor/skills/review/SKILL.md">Review code changes carefully.</agent_skill>')
    expect(pre).not.toContain('SECRET_SKILL_BODY')
  })

  it('omits Skill entries when the official 2% catalog budget is exhausted', () => {
    const skills = Array.from({ length: 8 }, (_, index) => ({
      fullPath: `/workspace/.cursor/skills/skill-${index}/SKILL.md`,
      content: `body-${index}`,
      description: `Skill ${index} ${'description '.repeat(30)}`,
      disableModelInvocation: false,
      environments: [],
      disabledEnvironments: [],
      globs: [],
      scopedTo: [],
      raw: {},
    }))
    const pre = preambleOf(buildMessages(stubParsed({ contextTokenLimit: 1_000, agentSkills: skills })))
    expect(pre).toContain('Additional skills omitted from this initial list')
    expect(pre).toContain('/workspace/.cursor/skills')
    expect(pre).not.toContain('body-0')
  })

  it('advertises cursor dynamic namespace and emits the 0→N transition reminder', () => {
    const messages = buildMessages(stubParsed({
      cursorDynamicTools: [{
        tool: 'TodoWrite',
        description: 'Manage todos.',
        inputSchema: { type: 'object' },
      }],
      dynamicToolCount: 1,
      dynamicToolTransitionReminder: true,
    }))
    expect(messages[0].content).toContain('<namespace name="cursor" tools="TodoWrite"')
    expect(messages[0].content).toContain('source="cursor"')
    expect(messages[2].content).toContain('Dynamic tools have been enabled for this conversation')
    expect(messages[2].content).toContain('called through CallDynamicTool')
  })
})
