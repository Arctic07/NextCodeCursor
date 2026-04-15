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
 * 承载官方前置 user scaffold。块顺序:
 *   <user_info>
 *   <agent_transcripts>
 *   <ide_state>              ← Step 2
 *   <rules>
 *   <agent_skills>           全量可用 skill
 *   <attached_skills>        ← Step 2 用户手动 @ 的 skill 子集
 *   <attached_docs>          ← Step 2
 *   <cursor_commands>        ← Step 2 用户触发的 /command
 *   <mcp_instructions>       ← Step 2
 *   <extra_context>          ← Step 2 (blob 分支待 Step 4)
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

  // ── <ide_state> ── (来自 selectedContext.invocation_context.ide_state)
  const ideSection = buildIdeStateSection(parsed)
  if (ideSection)
    parts.push(ideSection)

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

  // ── <attached_skills> ── (用户手动 @ 的 skill,对 LLM 是"现在立刻用")
  if (parsed.selectedSkills.length > 0) {
    let attachedSkills = `<attached_skills description="Skills the user explicitly attached to this message. Follow them immediately before other work.">\n`
    for (const skill of parsed.selectedSkills) {
      attachedSkills += `<attached_skill fullPath="${escapeXml(skill.fullPath)}">${escapeXml(skill.description)}</attached_skill>\n`
    }
    attachedSkills += `</attached_skills>`
    parts.push(attachedSkills)
  }

  // ── <attached_docs> ── (用户 @ 的 @Docs 引用,只含 docId + name)
  if (parsed.documentations.length > 0) {
    let docsSection = `<attached_docs description="Documentation references the user attached. Fetch their content with the appropriate doc tool before relying on them.">\n`
    for (const doc of parsed.documentations) {
      docsSection += `<attached_doc docId="${escapeXml(doc.docId)}" name="${escapeXml(doc.name)}" />\n`
    }
    docsSection += `</attached_docs>`
    parts.push(docsSection)
  }

  // ── <cursor_commands> ── (用户触发的 /command 定义)
  if (parsed.cursorCommands.length > 0) {
    let cmdSection = `<cursor_commands description="Commands the user invoked via /<name>. Follow each command's content as an instruction for this turn.">\n`
    for (const cmd of parsed.cursorCommands) {
      cmdSection += `<cursor_command name="${escapeXml(cmd.name)}">${escapeXml(cmd.content)}</cursor_command>\n`
    }
    cmdSection += `</cursor_commands>`
    parts.push(cmdSection)
  }

  // ── <mcp_instructions> ── (每个 MCP server 的 use instructions)
  // 合并 requestContext.mcp_instructions 与 mcp_file_system_options.mcpDescriptors.serverUseInstructions,
  // 按 serverName 去重,前者优先。
  const mcpInstrMap = new Map<string, string>()
  for (const ins of parsed.mcpInstructions) {
    if (ins.serverName && ins.instructions)
      mcpInstrMap.set(ins.serverName, ins.instructions)
  }
  for (const srv of parsed.mcpServers) {
    if (srv.serverName && srv.serverUseInstructions && !mcpInstrMap.has(srv.serverName))
      mcpInstrMap.set(srv.serverName, srv.serverUseInstructions)
  }
  if (mcpInstrMap.size > 0) {
    let mcpSection = `<mcp_instructions description="Usage notes provided by the MCP servers connected to this workspace. Follow them when calling the corresponding tools.">\n`
    for (const [serverName, instructions] of mcpInstrMap) {
      mcpSection += `<mcp_instruction server="${escapeXml(serverName)}">\n${escapeXml(instructions)}\n</mcp_instruction>\n`
    }
    mcpSection += `</mcp_instructions>`
    parts.push(mcpSection)
  }

  // ── <extra_context> ── (inline data 条目;blob 分支等 Step 4 通过 blob store 取回)
  const extraInlineEntries = parsed.extraContextEntries.filter(e => typeof e.data === 'string' && e.data.length > 0)
  const extraBlobCount = parsed.extraContextEntries.filter(e => e.blobId).length
  if (extraInlineEntries.length > 0 || extraBlobCount > 0) {
    let extraSection = `<extra_context description="Additional context the client attached alongside the user message.">\n`
    for (const entry of extraInlineEntries) {
      extraSection += `<extra_context_entry>${escapeXml(entry.data!)}</extra_context_entry>\n`
    }
    if (extraBlobCount > 0) {
      // 暂以占位的形式保留痕迹,真正取回数据待 Step 4
      extraSection += `<extra_context_pending blob_count="${extraBlobCount}" />\n`
    }
    extraSection += `</extra_context>`
    parts.push(extraSection)
  }

  return parts.join('\n\n')
}

/** 组装 <ide_state> XML 块;当 ideState 为空或无文件时返回 null */
function buildIdeStateSection(parsed: ParsedRunRequest): string | null {
  const ide = parsed.ideState
  if (!ide)
    return null
  if (ide.visibleFiles.length === 0 && ide.recentlyViewedFiles.length === 0)
    return null

  let section = `<ide_state description="A snapshot of the user's IDE at the moment this message was sent. The first visible file is typically what they are looking at right now.">\n`

  if (ide.visibleFiles.length > 0) {
    section += `<visible_files>\n`
    for (const f of ide.visibleFiles) {
      const attrs = [`path="${escapeXml(f.path)}"`]
      if (f.relativePath)
        attrs.push(`relativePath="${escapeXml(f.relativePath)}"`)
      if (f.totalLines > 0)
        attrs.push(`totalLines="${f.totalLines}"`)
      if (f.cursorLine !== undefined)
        attrs.push(`cursorLine="${f.cursorLine}"`)
      if (f.activeCommand)
        attrs.push(`activeCommand="${escapeXml(f.activeCommand)}"`)
      const inner = f.cursorText ? escapeXml(f.cursorText) : ''
      section += `<file ${attrs.join(' ')}>${inner}</file>\n`
    }
    section += `</visible_files>\n`
  }

  if (ide.recentlyViewedFiles.length > 0) {
    section += `<recently_viewed_files>\n`
    for (const f of ide.recentlyViewedFiles) {
      const attrs = [`path="${escapeXml(f.path)}"`]
      if (f.relativePath)
        attrs.push(`relativePath="${escapeXml(f.relativePath)}"`)
      if (f.totalLines > 0)
        attrs.push(`totalLines="${f.totalLines}"`)
      section += `<file ${attrs.join(' ')} />\n`
    }
    section += `</recently_viewed_files>\n`
  }

  section += `</ide_state>`
  return section
}

function buildCurrentUserTurn(parsed: ParsedRunRequest): string {
  return `<user_query>\n${parsed.userText}\n</user_query>`
}
