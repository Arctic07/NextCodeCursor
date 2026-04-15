import type { LLMContentBlock, LLMMessage } from '../../llm/types'
import type { ProviderPromptProfile } from '../../llm/promptProfile'
import type { ParsedRunRequest } from './types'
import { resolvePromptProfile } from '../../llm/promptProfile'
import { buildAnthropicSystemPrompt } from './prompts/anthropicSystem'
import { buildComposerFallbackSystemPrompt } from './prompts/composerFallback'
import { buildOpenAISystemPrompt } from './prompts/openaiSystem'
import { escapeXml } from './shared'

/**
 * 从 ParsedRunRequest 构造官方风格的首轮 messages 数组。
 *
 * 目前按官方抓包对齐为三段:
 *   1) system
 *   2) preamble user (<user_info>/<agent_transcripts>/<rules>/<agent_skills>)
 *   3) current-turn user (<user_query>)
 */
export function buildMessages(
  parsed: ParsedRunRequest,
  promptProfile: ProviderPromptProfile = resolvePromptProfile(parsed.modelId),
): [LLMMessage, LLMMessage, LLMMessage] {
  const userQueryText = buildCurrentUserTurn(parsed)

  // 当用户附带图片时,构建 LLMContentBlock[] 而非纯文本
  let currentUserContent: string | LLMContentBlock[]
  if (parsed.selectedImages.length > 0) {
    const imageBlocks: LLMContentBlock[] = parsed.selectedImages.map(img => ({
      type: 'image' as const,
      mimeType: img.mimeType,
      data: img.data,
    }))
    currentUserContent = [...imageBlocks, { type: 'text' as const, text: userQueryText }]
  }
  else {
    currentUserContent = userQueryText
  }

  return [
    { role: 'system', content: buildSystemPrompt(parsed, promptProfile) },
    { role: 'user', content: buildPreambleUserMessage(parsed) },
    { role: 'user', content: currentUserContent },
  ]
}

/**
 * 组装 system prompt
 *
 * 按 promptProfile 分发到三套模板:
 * - composer-fallback  → Composer 轻量 prompt
 * - openai-chat / openai-responses → GPT 专用架构
 * - 其他 (Anthropic / Gemini) → 主模板
 */
function buildSystemPrompt(parsed: ParsedRunRequest, promptProfile: ProviderPromptProfile): string {
  if (promptProfile.systemPromptStyle === 'composer-fallback') {
    return buildComposerFallbackSystemPrompt()
  }
  if (promptProfile.provider === 'openai-chat' || promptProfile.provider === 'openai-responses') {
    return buildOpenAISystemPrompt(parsed, promptProfile)
  }
  return buildAnthropicSystemPrompt(parsed, promptProfile)
}

/**
 * 组装 preamble user message。
 *
 * 这一段承载官方前置 user scaffold:
 * <user_info> + <agent_transcripts> + <rules> + <agent_skills>
 */
function buildPreambleUserMessage(parsed: ParsedRunRequest): string {
  const parts: string[] = []

  // ── <user_info> ──
  const infoLines: string[] = []
  if (parsed.env.osVersion)
    infoLines.push(`OS Version: ${parsed.env.osVersion}`)
  if (parsed.env.shell)
    infoLines.push(`Shell: ${parsed.env.shell}`)
  if (parsed.env.workspacePaths?.length)
    infoLines.push(`Workspace Path: ${parsed.env.workspacePaths[0]}`)
  infoLines.push(`Is directory a git repo: ${parsed.isGitRepo ? 'Yes' : 'No'}`)
  const now = new Date()
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  infoLines.push(`Today's date: ${dayNames[now.getDay()]} ${monthNames[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`)
  if (parsed.env.terminalsFolder)
    infoLines.push(`Terminals folder: ${parsed.env.terminalsFolder}`)

  parts.push(`<user_info>\n${infoLines.join('\n\n')}\n</user_info>`)

  // ── <agent_transcripts> ──
  if (parsed.env.agentTranscriptsFolder) {
    parts.push(`<agent_transcripts>
Agent transcripts (past chats) live in ${parsed.env.agentTranscriptsFolder}. They have names like <uuid>.jsonl, cite them to the user as [<title for chat <=6 words>](<uuid excluding .jsonl>). NEVER cite subagent transcripts/IDs; you can only cite parent uuids. Don't discuss the folder structure.
</agent_transcripts>`)
  }

  // ── <rules> ──
  if (parsed.userRules.length > 0 || parsed.projectRules.length > 0) {
    let rulesSection = `<rules>
The rules section has a number of possible rules/memories/context that you should consider. In each subsection, we provide instructions about what information the subsection contains and how you should consider/follow the contents of the subsection.\n\n`

    if (parsed.userRules.length > 0) {
      rulesSection += `<user_rules description="These are rules set by the user that you should follow if appropriate.">\n`
      for (const rule of parsed.userRules) {
        rulesSection += `<user_rule>${rule}</user_rule>\n`
      }
      rulesSection += `</user_rules>\n`
    }

    if (parsed.projectRules.length > 0) {
      rulesSection += `<project_rules description="These are rules specific to the project.">\n`
      for (const rule of parsed.projectRules) {
        rulesSection += `<project_rule path="${escapeXml(rule.fullPath)}">${rule.content}</project_rule>\n`
      }
      rulesSection += `</project_rules>\n`
    }

    rulesSection += `</rules>`
    parts.push(rulesSection)
  }

  // ── <agent_skills> ──
  if (parsed.agentSkills.length > 0) {
    let skillsSection = `<agent_skills>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge. To use a skill, read the skill file at the provided absolute path using the Read tool, then follow the instructions within. When a skill is relevant, read and follow it IMMEDIATELY as your first action. NEVER just announce or mention a skill without actually reading and following it. Only use skills listed below.


<available_skills description="Skills the agent can use. Use the Read tool with the provided absolute path to fetch full contents.">\n`

    for (const skill of parsed.agentSkills) {
      skillsSection += `<agent_skill fullPath="${escapeXml(skill.fullPath)}">${escapeXml(skill.description)}</agent_skill>\n\n`
    }

    skillsSection += `</available_skills>
</agent_skills>`
    parts.push(skillsSection)
  }

  return parts.join('\n\n')
}

function buildCurrentUserTurn(parsed: ParsedRunRequest): string {
  return `<user_query>\n${parsed.userText}\n</user_query>`
}
