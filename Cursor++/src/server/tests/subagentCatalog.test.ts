import { describe, expect, it } from 'vitest'
import { getCursorAgentTools } from '../handlers/agent/cursorTools'
import { contextualizeSubagentTools } from '../handlers/agent/subagentCatalog'

describe('custom Subagent catalog', () => {
  it('adds ref-only restored custom subagents to Task schema without mutating the registry', () => {
    const original = getCursorAgentTools('anthropic')
    const taskBefore = original.find(tool => tool.name === 'Task')!
    const beforeEnum = ((taskBefore.inputSchema.properties as any).subagent_type as any).enum as string[]
    const contextualized = contextualizeSubagentTools(original, [{
      fullPath: '/workspace/.cursor/agents/reviewer.md',
      name: 'workspace-reviewer',
      description: 'Reviews workspace changes.',
      tools: ['Read', 'Grep'],
      model: 'inherit',
      prompt: 'Review carefully.',
      permissionMode: 'readonly',
      isBackground: false,
      forceDefaultModel: false,
      raw: {},
    }])
    const taskAfter = contextualized.find(tool => tool.name === 'Task')!
    const afterEnum = ((taskAfter.inputSchema.properties as any).subagent_type as any).enum as string[]

    expect(afterEnum).toContain('workspace-reviewer')
    expect(taskAfter.description).toContain('workspace-reviewer (read-only): Reviews workspace changes.')
    expect(beforeEnum).not.toContain('workspace-reviewer')
    expect(taskAfter).not.toBe(taskBefore)
  })
})
