import type { LLMContentBlock, LLMMessage } from '../../llm/types'
import type { ProviderPromptProfile } from '../../llm/promptProfile'
import type { ParsedRunRequest } from './types'
import { resolvePromptProfile } from '../../llm/promptProfile'
import { buildAnthropicSystemPrompt } from './prompts/anthropicSystem'
import { buildComposerFallbackSystemPrompt } from './prompts/composerFallback'
import { buildModeReminder } from './prompts/modeReminders'
import { buildOpenAISystemPrompt } from './prompts/openaiSystem'
import { escapeXml } from './shared'

function truncateDescription(desc: string, maxLen: number): string {
  const oneLine = desc.replace(/\s+/g, ' ').trim()
  return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen - 1)}…`
}

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
  let base: string
  if (promptProfile.systemPromptStyle === 'composer-fallback') {
    base = buildComposerFallbackSystemPrompt()
  }
  else if (promptProfile.provider === 'openai-chat' || promptProfile.provider === 'openai-responses') {
    base = buildOpenAISystemPrompt(parsed, promptProfile)
  }
  else {
    base = buildAnthropicSystemPrompt(parsed, promptProfile)
  }

  const mode = parsed.mode.replace('AGENT_MODE_', '').toLowerCase()
  if (mode === 'plan') {
    base += `\n\n<plan_mode_guardrails>\n- In plan mode, only edit markdown files.\n- If the user is refining the plan, stay in plan mode and keep edits in markdown.\n- If the user explicitly asks you to build, implement, or write the code now, switch to agent mode before making non-markdown edits.\n</plan_mode_guardrails>`
  }

  return base
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
 *   <code_selections>        ← 用户框选代码 (Past Chats 除外) — selectedContext 通道
 *   <past_chats>             ← @ 历史对话 (拆自 codeSelections) — selectedContext 通道
 *   <terminal_selections>    ← 用户框选终端输出 — selectedContext 通道
 *   <attached_files>         ← @ 整个文件 — requestContext.file_contents 通道 (map)
 *   <attached_folders>       ← @ Folder 目录树 — requestContext.project_layouts 通道
 *   <external_links>         ← @ 链接/PDF — selectedContext 通道
 *   <attached_subagents>     ← @ subagent — selectedContext 通道
 *   <attached_browsers>      ← @ 浏览器页面 — selectedContext 通道
 *   <recent_agents>          ← 最近对话摘要 — selectedContext 通道
 *
 * 已刻意跳过的 git 字段 (gitDiff / gitDiffFromBranchToMain / gitCommits /
 *   gitPrDiffSelections / selectedPullRequests): 见 types.ts 里的说明,
 *   改由 LLM 主动用 Shell tool 跑 git 命令获取。
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

  // ── <available_skills> — 渐进式加载 (参照 Claude Code SkillTool/prompt.ts) ──
  //
  // 三层架构:
  //   Tier 1: catalog — name + 截断 description, 受 1% context 预算约束
  //   Tier 2: 用户 @ 或 LLM Read 触发时才加载完整 SKILL.md body
  //   Tier 3: skill 内引用的关联资源 (按需)
  //
  // 预算机制 (对齐 Claude Code):
  //   - SKILL_BUDGET_CONTEXT_PERCENT = 0.01 (1% of context window)
  //   - MAX_LISTING_DESC_CHARS = 250 (per skill)
  //   - 超预算: 先截短 description → 极端情况只显示 name
  if (parsed.agentSkills.length > 0) {
    const charBudget = Math.floor((parsed.contextTokenLimit ?? 200_000) * 4 * 0.01)
    const maxDescChars = 250

    const entries = parsed.agentSkills.map(s => {
      const name = s.fullPath.split('/').slice(-2, -1)[0] || s.fullPath
      const desc = truncateDescription(s.description, maxDescChars)
      return { name, desc, fullPath: s.fullPath, full: `- ${name}: ${desc}` }
    })

    const fullTotal = entries.reduce((sum, e) => sum + e.full.length + 1, 0)
    let listing: string

    if (fullTotal <= charBudget) {
      listing = entries.map(e => e.full).join('\n')
    } else {
      // 超预算: 按比例截短 description
      const nameOverhead = entries.reduce((sum, e) => sum + e.name.length + 4, 0) + entries.length
      const availableForDescs = charBudget - nameOverhead
      const maxDescLen = Math.max(20, Math.floor(availableForDescs / entries.length))

      if (maxDescLen < 20) {
        listing = entries.map(e => `- ${e.name}`).join('\n')
      } else {
        listing = entries.map(e => `- ${e.name}: ${truncateDescription(e.desc, maxDescLen)}`).join('\n')
      }
    }

    const skillsSection = `<available_skills>
The following skills are available. To use a skill, read its file with the Read tool, then follow the instructions within.
Only use skills listed here. When a skill matches the user's request, read and follow it IMMEDIATELY as your first action.

${listing}
</available_skills>`
    parts.push(skillsSection)
  }

  // ── <attached_skills> — Tier 2: 用户手动 @ 的 skill (立刻执行, 无需 Read) ──
  if (parsed.selectedSkills.length > 0) {
    let attachedSkills = `<attached_skills description="Skills the user explicitly attached. Follow them immediately before other work.">\n`
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

  // ── <code_selections> ── (编辑器框选 + ⌘+L 产生的代码片段)
  // Past Chats 不走 codeSelections 通道 (实测:Past Chats 是 @ agent-transcripts/*.jsonl 文件,
  // 走 requestContext.fileContents map,下方 <attached_files> 块里按 path 识别拆分)
  if (parsed.codeSelections.length > 0) {
    let section = `<code_selections description="Code the user framed as relevant to this request. Treat each selection as the exact region the user wants you to focus on.">\n`
    for (const sel of parsed.codeSelections) {
      const attrs = [`path="${escapeXml(sel.path)}"`]
      if (sel.relativePath)
        attrs.push(`relativePath="${escapeXml(sel.relativePath)}"`)
      if (sel.range) {
        // 注: proto 的 line/column 通常是 0-based,注入时 +1 换算为人类可读
        attrs.push(`lines="${sel.range.startLine + 1}-${sel.range.endLine + 1}"`)
      }
      section += `<code_selection ${attrs.join(' ')}>${escapeXml(sel.content)}</code_selection>\n`
    }
    section += `</code_selections>`
    parts.push(section)
  }

  // ── <terminal_selections> ── (用户框选的终端输出片段)
  if (parsed.terminalSelections.length > 0) {
    let section = `<terminal_selections description="Terminal output the user highlighted. The content is literal shell output; do not reinterpret as source code.">\n`
    for (const sel of parsed.terminalSelections) {
      const attrs: string[] = []
      if (sel.title)
        attrs.push(`title="${escapeXml(sel.title)}"`)
      if (sel.path)
        attrs.push(`path="${escapeXml(sel.path)}"`)
      if (sel.range)
        attrs.push(`lines="${sel.range.startLine + 1}-${sel.range.endLine + 1}"`)
      section += `<terminal_selection${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>${escapeXml(sel.content)}</terminal_selection>\n`
    }
    section += `</terminal_selections>`
    parts.push(section)
  }

  // ── <attached_files> + <past_chats> ──
  // 来自 requestContext.file_contents (map<path,content>)。按 path 分流:
  //   - path 含 "agent-transcripts" 视为 Past Chat (Cursor 把 @ Past Chat 渲染为 @ transcript 文件)
  //   - 其他路径为正常 @ 文件
  // 拆成两个 XML 块让 LLM 区分"当前代码文件"和"历史对话记录"的语义。
  const fileEntries = Object.entries(parsed.fileContents).filter(([p, c]) => p && c)
  if (fileEntries.length > 0) {
    const pastChatEntries = fileEntries.filter(([p]) => p.includes('agent-transcripts'))
    const normalFileEntries = fileEntries.filter(([p]) => !p.includes('agent-transcripts'))

    if (normalFileEntries.length > 0) {
      let section = `<attached_files description="Files the user attached via @File. Treat the content as canonical — it reflects the file state at the moment of the message.">\n`
      for (const [path, content] of normalFileEntries)
        section += `<attached_file path="${escapeXml(path)}">${escapeXml(content)}</attached_file>\n`
      section += `</attached_files>`
      parts.push(section)
    }

    if (pastChatEntries.length > 0) {
      let section = `<past_chats description="Prior agent transcripts (JSONL) the user attached. Reference them when the user asks about earlier conversations.">\n`
      for (const [path, content] of pastChatEntries)
        section += `<past_chat path="${escapeXml(path)}">${escapeXml(content)}</past_chat>\n`
      section += `</past_chats>`
      parts.push(section)
    }
  }

  // ── <attached_folders> ── (@ Folder — 来自 requestContext.project_layouts)
  // repeated LsDirectoryTreeNode,递归目录结构,JSON 化压入 XML 让 LLM 自行理解布局。
  // 避免 server 端手展开树 (会膨胀 token),LLM 对 JSON 树结构有较好理解能力。
  if (parsed.projectLayouts.length > 0) {
    let section = `<attached_folders description="Folders the user attached. Each node is a LsDirectoryTreeNode JSON — use Read / Glob to dive into specific files.">\n`
    for (const node of parsed.projectLayouts) {
      const path = typeof (node as { path?: unknown }).path === 'string' ? (node as { path: string }).path : ''
      const treeJson = JSON.stringify(node)
      section += `<attached_folder${path ? ` path="${escapeXml(path)}"` : ''}>${escapeXml(treeJson)}</attached_folder>\n`
    }
    section += `</attached_folders>`
    parts.push(section)
  }

  // ── <external_links> ── (用户 @ 的 URL/PDF;pdfContent 已是解析后的文本)
  if (parsed.externalLinks.length > 0) {
    let section = `<external_links description="External resources the user attached. Fetch or consult each as needed for this turn.">\n`
    for (const link of parsed.externalLinks) {
      const attrs = [`url="${escapeXml(link.url)}"`]
      if (link.filename)
        attrs.push(`filename="${escapeXml(link.filename)}"`)
      if (link.isPdf)
        attrs.push(`type="pdf"`)
      // PDF 已有正文时 inline 内容供 LLM 直接阅读;否则只留链接(LLM 可用 webFetch 取)
      const inner = link.isPdf && link.pdfContent ? escapeXml(link.pdfContent) : ''
      section += `<external_link ${attrs.join(' ')}>${inner}</external_link>\n`
    }
    section += `</external_links>`
    parts.push(section)
  }

  // ── <attached_subagents> ── (用户 @ 的 subagent;只有 name,具体能力注册表由 server 解析)
  if (parsed.selectedSubagents.length > 0) {
    let section = `<attached_subagents description="Subagents the user requested for this task. Consider delegating the appropriate work to them via the task tool.">\n`
    for (const sa of parsed.selectedSubagents)
      section += `<attached_subagent name="${escapeXml(sa.name)}" />\n`
    section += `</attached_subagents>`
    parts.push(section)
  }

  // ── <attached_browsers> ── (Cursor 浏览器集成中用户 @ 的页面)
  if (parsed.selectedBrowsers.length > 0) {
    let section = `<attached_browsers description="Browser pages the user attached. Use webFetch to read full content if relevant.">\n`
    for (const br of parsed.selectedBrowsers) {
      const attrs = [`url="${escapeXml(br.url)}"`]
      if (br.pageTitle)
        attrs.push(`title="${escapeXml(br.pageTitle)}"`)
      section += `<attached_browser ${attrs.join(' ')} />\n`
    }
    section += `</attached_browsers>`
    parts.push(section)
  }

  // ── <recent_agents> ── (最近对话列表,用户可能想引用其中某个历史对话;
  // 只含元数据, 如需正文 LLM 应用 Read tool 读 agentTranscriptsFolder/<uuid>.jsonl)
  if (parsed.recentAgentsContext.length > 0) {
    let section = `<recent_agents description="Recent prior agent conversations in this workspace. Read the transcript file when the user references one.">\n`
    for (const agent of parsed.recentAgentsContext) {
      const attrs = [`name="${escapeXml(agent.name)}"`, `path="${escapeXml(agent.path)}"`]
      const inner = agent.overview ? escapeXml(agent.overview) : ''
      section += `<recent_agent ${attrs.join(' ')}>${inner}</recent_agent>\n`
    }
    section += `</recent_agents>`
    parts.push(section)
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
  const reminder = buildModeReminder(parsed)
  const query = `<user_query>\n${parsed.userText}\n</user_query>`
  return reminder ? `${reminder}\n${query}` : query
}
