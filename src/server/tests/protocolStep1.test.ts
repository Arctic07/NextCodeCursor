import { describe, expect, it } from 'vitest'
import { parseRunRequest } from '../handlers/agent/protocol'

describe('parseRunRequest — Step 1 field coverage', () => {
  it('extracts mcp_instructions from requestContext (proto field 14)', () => {
    const parsed = parseRunRequest({
      runRequest: {
        conversationId: 'c1',
        action: {
          userMessageAction: {
            userMessage: { text: 'hi' },
            requestContext: {
              mcpInstructions: [
                { serverName: 'fs', instructions: 'use paths under /tmp', serverIdentifier: 'fs-1' },
                { serverName: 'db', instructions: 'read-only', serverIdentifier: 'db-2' },
              ],
            },
          },
        },
        modelDetails: { modelId: 'm' },
      },
    })
    expect(parsed.mcpInstructions).toEqual([
      { serverName: 'fs', instructions: 'use paths under /tmp', serverIdentifier: 'fs-1' },
      { serverName: 'db', instructions: 'read-only', serverIdentifier: 'db-2' },
    ])
  })

  it('decodes invocation_context.ide_state into visible/recentlyViewed file lists', () => {
    const parsed = parseRunRequest({
      runRequest: {
        conversationId: 'c2',
        action: {
          userMessageAction: {
            userMessage: {
              text: 'check',
              selectedContext: {
                invocationContext: {
                  ideState: {
                    visibleFiles: [
                      { path: '/a/b.ts', relativePath: 'b.ts', totalLines: 100, cursorPosition: { line: 42, text: 'const x = 1' } },
                    ],
                    recentlyViewedFiles: [
                      { path: '/a/c.ts', totalLines: 10 },
                    ],
                  },
                },
              },
            },
            requestContext: {},
          },
        },
        modelDetails: { modelId: 'm' },
      },
    })
    expect(parsed.ideState?.visibleFiles).toHaveLength(1)
    expect(parsed.ideState?.visibleFiles[0]).toMatchObject({
      path: '/a/b.ts',
      relativePath: 'b.ts',
      totalLines: 100,
      cursorLine: 42,
      cursorText: 'const x = 1',
    })
    expect(parsed.ideState?.recentlyViewedFiles).toHaveLength(1)
    expect(parsed.ideState?.recentlyViewedFiles[0]).toMatchObject({ path: '/a/c.ts', totalLines: 10 })
  })

  it('extracts documentations / cursor_commands / selected_skills from selectedContext', () => {
    const parsed = parseRunRequest({
      runRequest: {
        conversationId: 'c3',
        action: {
          userMessageAction: {
            userMessage: {
              text: 'x',
              selectedContext: {
                documentations: [{ docId: 'doc1', name: 'React Docs' }],
                cursorCommands: [{ name: 'lint', content: 'eslint .' }],
                selectedSkills: [{ fullPath: '/skill/a.md', description: 'formatting helper' }],
              },
            },
            requestContext: {},
          },
        },
        modelDetails: { modelId: 'm' },
      },
    })
    expect(parsed.documentations).toEqual([{ docId: 'doc1', name: 'React Docs' }])
    expect(parsed.cursorCommands).toEqual([{ name: 'lint', content: 'eslint .' }])
    expect(parsed.selectedSkills).toEqual([{ fullPath: '/skill/a.md', description: 'formatting helper' }])
  })

  it('decodes extra_context_entries with data scalar and oneof forms', () => {
    const parsed = parseRunRequest({
      runRequest: {
        conversationId: 'c4',
        action: {
          userMessageAction: {
            userMessage: {
              text: 'y',
              selectedContext: {
                extraContextEntries: [
                  { data: 'inline-string-1' },
                  { dataOrBlobId: { case: 'data', value: 'inline-string-2' } },
                  { dataOrBlobId: { case: 'blobId', value: 'blob-id-bytes' } },
                ],
              },
            },
            requestContext: {},
          },
        },
        modelDetails: { modelId: 'm' },
      },
    })
    expect(parsed.extraContextEntries).toHaveLength(3)
    expect(parsed.extraContextEntries[0]).toEqual({ data: 'inline-string-1' })
    expect(parsed.extraContextEntries[1]).toEqual({ data: 'inline-string-2' })
    expect(parsed.extraContextEntries[2]).toEqual({ blobId: 'blob-id-bytes' })
  })

  it('merges top-level mcp_tools (field 4) with requestContext.tools (field 7), deduped by name', () => {
    const parsed = parseRunRequest({
      runRequest: {
        conversationId: 'c5',
        mcpTools: {
          mcpTools: [
            { name: 'shared', description: 'top-level variant', inputSchema: {} },
            { name: 'top-only', description: 'from top level', inputSchema: {} },
          ],
        },
        action: {
          userMessageAction: {
            userMessage: { text: 'z' },
            requestContext: {
              tools: [
                { name: 'shared', description: 'request-context wins', inputSchema: { a: 1 } },
                { name: 'ctx-only', description: 'from requestContext', inputSchema: {} },
              ],
            },
          },
        },
        modelDetails: { modelId: 'm' },
      },
    })
    // requestContext.tools wins for duplicates
    const byName = Object.fromEntries(parsed.mcpTools.map(t => [t.name, t]))
    expect(byName.shared.description).toBe('request-context wins')
    expect(byName.shared.inputSchema).toEqual({ a: 1 })
    expect(byName['ctx-only']).toBeDefined()
    expect(byName['top-only']).toBeDefined()
    expect(parsed.mcpTools).toHaveLength(3)
  })

  it('falls back to top-level mcp_file_system_options when requestContext does not carry it', () => {
    const parsed = parseRunRequest({
      runRequest: {
        conversationId: 'c6',
        mcpFileSystemOptions: {
          workspaceProjectDir: '/proj',
          mcpDescriptors: [
            { serverName: 's1', folderPath: '/proj/mcps/s1', serverUseInstructions: 'use me' },
          ],
        },
        action: {
          userMessageAction: {
            userMessage: { text: 'q' },
            requestContext: {},
          },
        },
        modelDetails: { modelId: 'm' },
      },
    })
    expect(parsed.mcpBasePath).toBe('/proj/mcps')
    expect(parsed.mcpServers).toEqual([
      { serverName: 's1', folderPath: '/proj/mcps/s1', serverUseInstructions: 'use me' },
    ])
  })

  it('classifies rules across flattened oneof and native oneof shapes', () => {
    const parsed = parseRunRequest({
      runRequest: {
        conversationId: 'c-rules',
        action: {
          userMessageAction: {
            userMessage: { text: 'hi' },
            requestContext: {
              rules: [
                // flattened oneof — the @bufbuild/protobuf toJson output
                { fullPath: '/settings/user-rule-1', content: 'Always reply in Chinese', type: { global: {} } },
                // native protobuf-es oneof — type: { case, value }
                { fullPath: '/settings/user-rule-2', content: 'CLAUDE', type: { type: { case: 'global', value: {} } } },
                // file-globbed project rule (flattened form with globs array)
                { fullPath: '/proj/.cursor/rules/a.mdc', content: 'TS rule', type: { fileGlobbed: { globs: ['**/*.ts'] } } },
                // agentFetched skill via rules channel
                { fullPath: '/skill.mdc', content: '', type: { agentFetched: { description: 'helper' } } },
                // no type at all — content-only user rule
                { fullPath: '', content: 'bare rule' },
              ],
            },
          },
        },
        modelDetails: { modelId: 'm' },
      },
    })
    expect(parsed.userRules).toEqual([
      'Always reply in Chinese',
      'CLAUDE',
      'bare rule',
    ])
    expect(parsed.projectRules).toHaveLength(1)
    expect(parsed.projectRules[0]).toMatchObject({
      fullPath: '/proj/.cursor/rules/a.mdc',
      content: 'TS rule',
      glob: '**/*.ts',
    })
    expect(parsed.agentSkills.some(s => s.fullPath === '/skill.mdc' && s.description === 'helper')).toBe(true)
  })

  it('honors requestContext on resume_action (multi-round rules/mcp re-push)', () => {
    const parsed = parseRunRequest({
      runRequest: {
        conversationId: 'c7',
        action: {
          resumeAction: {
            requestContext: {
              mcpInstructions: [{ serverName: 'resumed', instructions: 'rules persist', serverIdentifier: 'r1' }],
              tools: [{ name: 'resume-tool', description: 'd', inputSchema: {} }],
            },
          },
        },
        modelDetails: { modelId: 'm' },
      },
    })
    expect(parsed.isResume).toBe(true)
    expect(parsed.mcpInstructions).toHaveLength(1)
    expect(parsed.mcpInstructions[0].serverName).toBe('resumed')
    expect(parsed.mcpTools.map(t => t.name)).toContain('resume-tool')
  })
})
