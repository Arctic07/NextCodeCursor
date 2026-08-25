/**
 * Token 计数工具 — 基于 gpt-tokenizer (o200k_base)
 *
 * 用于 Context Window breakdown 估算。跨 provider 误差 ~10-15%，
 * 足以驱动 UI 进度条显示。不用于计费。
 */
import { encode } from 'gpt-tokenizer/encoding/o200k_base'

export function countTokens(text: string): number {
  if (!text) return 0
  return encode(text, { allowedSpecial: 'all' }).length
}

export type ContextCategory =
  | 'system_prompt'
  | 'tools'
  | 'rules'
  | 'skills'
  | 'mcp'
  | 'subagents'
  | 'conversation'
  | 'summarized_conversation'

const CATEGORY_LABELS: Record<ContextCategory, string> = {
  system_prompt: 'System prompt',
  tools: 'Tool definitions',
  rules: 'Rules',
  skills: 'Skills',
  mcp: 'MCP & dynamic tools',
  subagents: 'Subagent definitions',
  conversation: 'Conversation',
  summarized_conversation: 'Summarized conversation',
}

export class ContextTokenTracker {
  private counts = new Map<ContextCategory, number>()

  add(category: ContextCategory, tokens: number): void {
    this.counts.set(category, (this.counts.get(category) ?? 0) + tokens)
  }

  addText(category: ContextCategory, text: string): void {
    if (text) this.add(category, countTokens(text))
  }

  get(category: ContextCategory): number {
    return this.counts.get(category) ?? 0
  }

  get total(): number {
    let sum = 0
    for (const v of this.counts.values()) sum += v
    return sum
  }

  toBreakdownCategories(): Array<{ id: string, label: string, estimatedTokens: number }> {
    const out: Array<{ id: string, label: string, estimatedTokens: number }> = []
    for (const [id, tokens] of this.counts) {
      if (tokens > 0)
        out.push({ id, label: CATEGORY_LABELS[id] ?? id, estimatedTokens: tokens })
    }
    return out
  }
}
