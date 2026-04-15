import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import type { LLMStreamEvent } from '../llm/types'
/**
 * Agent 流翻译器
 *
 * 将 LLM streaming events 翻译为 Cursor AgentServerMessage protobuf 帧序列。
 *
 * LLM event               → Cursor frame
 * ─────────────────────────────────────────
 * thinking_delta           → interactionUpdate.thinkingDelta
 * thinking_done            → interactionUpdate.thinkingCompleted
 * text_delta               → interactionUpdate.textDelta
 * tool_use_start           → interactionUpdate.partialToolCall
 * tool_use_delta           → interactionUpdate.tokenDelta
 * tool_use_done            → interactionUpdate.toolCallStarted
 * done                     → interactionUpdate.stepCompleted + turnEnded
 */
import { create } from '@bufbuild/protobuf'
import {
  AgentMode,
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ExecServerMessageSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  PartialToolCallUpdateSchema,
  ToolCallCompletedUpdateSchema,
  ToolCallDeltaSchema,
  ToolCallDeltaUpdateSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
  TrackedGitRepoSchema,
} from '../../gen/agent_v1_pb'
import { logger, streamLogger } from '../../logger'
import { AGENT_HEARTBEAT_INTERVAL_MS } from './constants'
import { mapPartialToolName } from './tools'

/** 构造 AgentServerMessage with interactionUpdate */
function iu(msg: Record<string, unknown>): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: 'interactionUpdate',
      value: create(InteractionUpdateSchema, {
        message: msg as any,
      }),
    },
  })
}

/** 构造 heartbeat 帧 */
export function heartbeat(): AgentServerMessage {
  return iu({ case: 'heartbeat', value: {} })
}

/** 构造 thinkingDelta 帧 */
export function thinkingDelta(text: string): AgentServerMessage {
  return iu({ case: 'thinkingDelta', value: { text, thinkingStyle: 1 } }) // 1 = THINKING_STYLE_DEFAULT
}

/** 构造 thinkingCompleted 帧 */
export function thinkingCompleted(durationMs: number): AgentServerMessage {
  return iu({ case: 'thinkingCompleted', value: { thinkingDurationMs: durationMs } })
}

/** 构造 textDelta 帧 */
export function textDelta(text: string): AgentServerMessage {
  return iu({ case: 'textDelta', value: { text } })
}

/** 构造 tokenDelta 帧 */
export function tokenDelta(tokens: number): AgentServerMessage {
  return iu({ case: 'tokenDelta', value: { tokens } })
}

/** 构造 summaryStarted 帧 */
export function summaryStarted(): AgentServerMessage {
  return iu({ case: 'summaryStarted', value: {} })
}

/** 构造 summary 帧 */
export function summary(text: string): AgentServerMessage {
  return iu({ case: 'summary', value: { summary: text } })
}

/** 构造 summaryCompleted 帧 */
export function summaryCompleted(hookMessage?: string): AgentServerMessage {
  return iu({ case: 'summaryCompleted', value: hookMessage ? { hookMessage } : {} })
}

/** 构造 stepCompleted 帧 */
export function stepCompleted(stepId: string, durationMs: number): AgentServerMessage {
  return iu({ case: 'stepCompleted', value: { stepId, stepDurationMs: BigInt(durationMs) } })
}

/** 构造 turnEnded 帧 */
export function turnEnded(inputTokens: number, outputTokens: number, cacheRead?: number, cacheWrite?: number): AgentServerMessage {
  return iu({
    case: 'turnEnded',
    value: {
      inputTokens: BigInt(inputTokens),
      outputTokens: BigInt(outputTokens),
      cacheReadTokens: BigInt(cacheRead ?? 0),
      cacheWriteTokens: BigInt(cacheWrite ?? 0),
    },
  })
}

/**
 * 构造 ToolCall protobuf 对象
 *
 * ToolCall 是 oneof "tool"，cases 包括:
 *   shellToolCall, globToolCall, grepToolCall, readToolCall, editToolCall,
 *   deleteToolCall, readLintsToolCall, mcpToolCall, webSearchToolCall,
 *   webFetchToolCall, taskToolCall, askQuestionToolCall, updateTodosToolCall, ...
 */
function buildToolCall(toolType: string, data: Record<string, unknown> | { args: Record<string, unknown>, result: unknown } = {}) {
  return create(ToolCallSchema, {
    tool: { case: toolType as any, value: data } as any,
  })
}

/**
 * 从 tool args 里提取需要提升到 *ToolCall message top-level 的字段。
 *
 * 3.0.16 proto 里部分 *ToolCall message 除了 `args` 嵌套外还有若干顶层字段。
 * 目前已知:
 *  - ShellToolCall.description (field 3, optional string)
 *    — 与 ShellArgs.description (field 15) 同时存在, 官方客户端的 UI 层会优先
 *      读取 top-level description 作为 "workingVerb / loadingVerb 的 argument" 渲染,
 *      若 top-level 为空则 fallback 显示 "Command failed to generate".
 *      详见 analysis/checkpoint-revert-protocol.md 的 Round D 记录。
 *
 * 这里集中处理这种 "args.X → top-level.X" 的映射, 避免污染每个 tool 的 buildStartedArgs。
 */
function buildToolCallValue(toolType: string, args: Record<string, unknown> | undefined, result?: unknown): Record<string, unknown> {
  const value: Record<string, unknown> = args !== undefined ? { args } : {}
  if (result !== undefined)
    value.result = result
  if (toolType === 'shellToolCall' && typeof args?.description === 'string')
    value.description = args.description
  return value
}

/** 构造 partialToolCall 帧 (工具调用预告，参数未完成) */
export function partialToolCall(callId: string, toolType: string, modelCallId: string): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: 'interactionUpdate',
      value: create(InteractionUpdateSchema, {
        message: {
          case: 'partialToolCall',
          value: create(PartialToolCallUpdateSchema, {
            callId,
            toolCall: buildToolCall(toolType),
            modelCallId,
          }),
        } as any,
      }),
    },
  })
}

/** 构造 toolCallStarted 帧 (参数完整，正式开始) */
export function toolCallStarted(callId: string, toolType: string, args: Record<string, unknown>, modelCallId: string): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: 'interactionUpdate',
      value: create(InteractionUpdateSchema, {
        message: {
          case: 'toolCallStarted',
          value: create(ToolCallStartedUpdateSchema, {
            callId,
            toolCall: buildToolCall(toolType, buildToolCallValue(toolType, args)),
            modelCallId,
          }),
        } as any,
      }),
    },
  })
}

/** 构造 toolCallCompleted 帧 */
export function toolCallCompleted(callId: string, toolType: string, args: Record<string, unknown>, result: unknown, modelCallId: string): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: 'interactionUpdate',
      value: create(InteractionUpdateSchema, {
        message: {
          case: 'toolCallCompleted',
          value: create(ToolCallCompletedUpdateSchema, {
            callId,
            toolCall: buildToolCall(toolType, buildToolCallValue(toolType, args, result)),
            modelCallId,
          }),
        } as any,
      }),
    },
  })
}

/** 构造 toolCallDelta 帧 */
export function toolCallDelta(callId: string, deltaCase: string, deltaValue: Record<string, unknown>, modelCallId: string): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: 'interactionUpdate',
      value: create(InteractionUpdateSchema, {
        message: {
          case: 'toolCallDelta',
          value: create(ToolCallDeltaUpdateSchema, {
            callId,
            toolCallDelta: create(ToolCallDeltaSchema, {
              delta: {
                case: deltaCase as any,
                value: deltaValue,
              } as any,
            }),
            modelCallId,
          }),
        } as any,
      }),
    },
  })
}

export function editToolCallStreamDelta(callId: string, streamContentDelta: string, modelCallId: string): AgentServerMessage {
  return toolCallDelta(callId, 'editToolCallDelta', {
    streamContentDelta,
  }, modelCallId)
}

export function shellToolCallStdoutDelta(callId: string, content: string, modelCallId: string): AgentServerMessage {
  return toolCallDelta(callId, 'shellToolCallDelta', {
    delta: {
      case: 'stdout',
      value: { content },
    },
  }, modelCallId)
}

export function shellToolCallStderrDelta(callId: string, content: string, modelCallId: string): AgentServerMessage {
  return toolCallDelta(callId, 'shellToolCallDelta', {
    delta: {
      case: 'stderr',
      value: { content },
    },
  }, modelCallId)
}

/** 构造 interactionQuery 帧 */
export function interactionQuery(id: number, queryCase: string, queryValue: Record<string, unknown>): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: 'interactionQuery',
      value: create(InteractionQuerySchema, {
        id,
        query: {
          case: queryCase as any,
          value: queryValue,
        } as any,
      }),
    },
  })
}

/** 构造 execServerMessage 帧 — 发送执行指令给 Client */
export function execMessage(id: number, execId: string, argsType: string, args: Record<string, unknown>): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: 'execServerMessage',
      value: create(ExecServerMessageSchema, {
        id,
        execId,
        message: {
          case: argsType as any,
          value: args,
        } as any,
      }),
    },
  })
}

/** 构造 kvServerMessage.getBlobArgs 帧 — 向 Client 请求取回 blob */
export function kvGetBlob(id: number, blobId: Uint8Array): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: 'kvServerMessage',
      value: create(KvServerMessageSchema, {
        id,
        message: {
          case: 'getBlobArgs',
          value: { blobId },
        } as any,
      }),
    },
  })
}

/**
 * 构造 kvServerMessage.setBlobArgs 帧 — 向 Client 发送 blob 存储。
 *
 * 对齐 official:
 * - system scaffold blob 使用 id=0 (proto scalar default，JSON 中通常省略)
 * - 首个 ordered blob 从 id=1 开始
 */
export function kvMessage(id: number | undefined, blobId: string, blobData: string): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: 'kvServerMessage',
      value: create(KvServerMessageSchema, {
        id: id ?? 0,
        message: {
          case: 'setBlobArgs',
          value: {
            blobId: new TextEncoder().encode(blobId),
            blobData: new TextEncoder().encode(blobData),
          },
        } as any,
      }),
    },
  })
}

/**
 * 构造 conversationCheckpointUpdate 帧
 *
 * pendingToolCalls 存储当前轮次的 assistant 完整消息（含 reasoning + text），
 * Client 用其中的 "type":"reasoning" 块来渲染可展开的 thinking 内容。
 * 格式: [JSON.stringify({ id, role: "assistant", content: [{type:"reasoning",text:...},{type:"text",text:...}] })]
 *
 * 字段对齐 (详见 analysis/checkpoint-revert-protocol.md):
 *  - turns                  : 空占位 []，真实构造依赖 blob 粒度重构 (P5)
 *  - readPaths              : 空占位 []，未跟踪 Read 工具访问文件 (P5)
 *  - mode                   : AGENT_MODE_* enum
 *  - previousWorkspaceUris  : 当前工作区 file:// URI 列表
 *  - agentType              : 固定 "ide" (对标官方实测样本, Cursor 客户端永远是 IDE agent)
 *  - trackedGitRepoBranches : 从 parsed.gitRepos 映射为 {repoPath, branchName}[]
 *  - activeBranchName       : 第一个 git repo 的 branch (官方样本表明仅取主 branch)
 *  - plans                  : map, 空占位, Plan Mode 未实现
 *  - pendingToolCalls[i].providerOptions.cursor.modelName : 对齐官方,
 *    Client 根据 modelName 判断 signature 格式 (OpenAI JSON vs Anthropic base64)
 */
export function checkpoint(
  blobIds: string[],
  usedTokens: number,
  maxTokens: number,
  mode: string,
  assistantMessage?: { thinking?: string, text?: string },
  extras?: {
    summaryArchiveIds?: string[]
    workspaceUris?: string[]
    readPaths?: string[]
    /** reasoning/text block 上的 providerOptions.cursor.modelName — 留空则不输出 providerOptions */
    modelName?: string
    /** 从 parsed.gitRepos 提取的 git 仓库列表, 对应 Cursor Client 的 trackedGitRepoBranches */
    gitRepos?: Array<{ path: string, branchName: string }>
    /** 固定 "ide", 对标官方行为. 允许覆盖但一般无需. */
    agentType?: string
  },
): AgentServerMessage {
  const encoder = new TextEncoder()

  const pendingToolCalls: string[] = []
  if (assistantMessage) {
    const content: Array<Record<string, unknown>> = []
    const providerOptions = extras?.modelName
      ? { cursor: { modelName: extras.modelName } }
      : undefined

    if (assistantMessage.thinking) {
      const reasoningBlock: Record<string, unknown> = {
        type: 'reasoning',
        text: assistantMessage.thinking,
      }
      if (providerOptions)
        reasoningBlock.providerOptions = providerOptions
      content.push(reasoningBlock)
    }
    if (assistantMessage.text) {
      const textBlock: Record<string, unknown> = {
        type: 'text',
        text: assistantMessage.text,
      }
      if (providerOptions)
        textBlock.providerOptions = providerOptions
      content.push(textBlock)
    }
    if (content.length > 0) {
      pendingToolCalls.push(JSON.stringify({
        id: '1',
        role: 'assistant',
        content,
      }))
    }
  }

  // mode 字符串 → AgentMode enum
  const agentMode = resolveAgentMode(mode)

  // 构造 trackedGitRepoBranches (proto: repeated TrackedGitRepo)
  const trackedGitRepoBranches = (extras?.gitRepos ?? []).map(r => create(TrackedGitRepoSchema, {
    repoPath: r.path,
    branchName: r.branchName,
  }))
  // activeBranchName: 取第一个 git repo 的 branch, 官方行为是仅有一个主 branch
  const activeBranchName = extras?.gitRepos?.[0]?.branchName

  logger.debug({
    rpmCount: blobIds.length,
    mode,
    agentMode,
    usedTokens,
    hasWorkspaceUris: (extras?.workspaceUris?.length ?? 0) > 0,
    hasReadPaths: (extras?.readPaths?.length ?? 0) > 0,
    gitRepoCount: trackedGitRepoBranches.length,
    activeBranchName,
    agentType: extras?.agentType ?? 'ide',
    modelName: extras?.modelName,
  }, '[AGENT] >>> CHECKPOINT EMIT (verify client roundtrip)')

  return create(AgentServerMessageSchema, {
    message: {
      case: 'conversationCheckpointUpdate',
      value: create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: blobIds.map(id => encoder.encode(id)),
        // turns 暂时发空占位 (详见 P5 blob 粒度重构任务)
        turns: [],
        pendingToolCalls,
        tokenDetails: { usedTokens, maxTokens } as any,
        summaryArchives: (extras?.summaryArchiveIds ?? []).map(id => encoder.encode(id)),
        // 以下字段官方 checkpoint 必须携带, 否则 Cursor 客户端不回传 conversationState
        mode: agentMode,
        previousWorkspaceUris: extras?.workspaceUris ?? [],
        // readPaths: 客户端根据此字段做 "同文件不重复 Read" 优化, 目前空占位
        readPaths: extras?.readPaths ?? [],
        // Round B+ (proto 3.0.16 新增字段)
        // agentType 固定 "ide" 对齐官方实测. Cursor Client 自身是 IDE agent.
        agentType: extras?.agentType ?? 'ide',
        // 从 parsed.gitRepos 映射而来, 空数组表示非 git workspace
        trackedGitRepoBranches,
        // 第一个 repo 的 branch (官方行为). 无 git 时为 undefined 则不输出.
        activeBranchName,
        // plans: map, 当前未实现 Plan Mode, 空占位
        plans: {},
      }),
    },
  })
}

function resolveAgentMode(mode: string): AgentMode {
  // 客户端传 "AGENT_MODE_AGENT" 格式, 也兼容内部用的小写 "agent"
  const normalized = mode.replace('AGENT_MODE_', '').toLowerCase()
  switch (normalized) {
    case 'agent': return AgentMode.AGENT
    case 'ask': return AgentMode.ASK
    case 'plan': return AgentMode.PLAN
    case 'debug': return AgentMode.DEBUG
    case 'triage': return AgentMode.TRIAGE
    default: return AgentMode.AGENT
  }
}

/**
 * 将 LLM streaming events 翻译为 Cursor AgentServerMessage 帧序列
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function* translateStream(
  events: AsyncIterable<LLMStreamEvent>,
  stepId: string = '1',
  onEvent?: (event: LLMStreamEvent) => void,
  keepAliveMs = AGENT_HEARTBEAT_INTERVAL_MS,
): AsyncIterable<AgentServerMessage> {
  const startTime = Date.now()
  let thinkingStartTime = startTime
  let isThinking = false
  let tokenCount = 0
  let eventCount = 0
  let thinkingChars = 0
  let textChars = 0

  const iterator = events[Symbol.asyncIterator]()

  while (true) {
    const nextPromise = iterator.next()
    let nextResult: IteratorResult<LLMStreamEvent>

    while (true) {
      const raced = await Promise.race([
        nextPromise.then(value => ({ kind: 'next' as const, value })),
        delay(keepAliveMs).then(() => ({ kind: 'heartbeat' as const })),
      ])

      if (raced.kind === 'heartbeat') {
        yield heartbeat()
        continue
      }

      nextResult = raced.value
      break
    }

    if (nextResult.done) {
      break
    }

    const event = nextResult.value
    eventCount++

    // LLM 事件逐帧详情, 用 debug 级别 (用户可在 Output 面板切 Debug 看细节)
    streamLogger.debug({
      type: event.type,
      n: eventCount,
      ...('text' in event ? { text: (event as { text: string }).text } : {}),
    }, '[LLM] event')

    onEvent?.(event)

    switch (event.type) {
      case 'thinking_delta':
        if (!isThinking) {
          isThinking = true
          thinkingStartTime = Date.now()
        }
        thinkingChars += event.text.length
        yield thinkingDelta(event.text)
        tokenCount++
        if (tokenCount % 3 === 0)
          yield tokenDelta(3)
        break

      case 'thinking_done':
        if (isThinking) {
          // Cursor UI: durationMs < 500 显示 "Thought briefly"，>= 500 显示 "Thought for Xs"
          yield thinkingCompleted(Date.now() - thinkingStartTime)
          isThinking = false
        }
        break

      case 'text_delta':
        textChars += event.text.length
        yield textDelta(event.text)
        tokenCount++
        if (tokenCount % 5 === 0)
          yield tokenDelta(5)
        break

      case 'tool_use_start':
        // 流式过程中发送 partialToolCall 预告，让 Client 知道正在调用工具
        // 对动态外部工具名（如 user-Context7-* / user-brave-search-*）先映射到合法 proto tool case。
        // 完整的 toolCallStarted + exec 由 AgentService 的 tool call loop 处理。
        yield partialToolCall(event.id, mapPartialToolName(event.name), `model-${stepId}`)
        tokenCount++
        yield tokenDelta(1)
        break

      case 'tool_use_delta':
        // 参数 token 流式传输
        tokenCount++
        if (tokenCount % 3 === 0)
          yield tokenDelta(3)
        break

      case 'tool_use_done':
        // tool_use block 完成，参数已完整
        // 实际 toolCallStarted + exec 由 AgentService 处理
        break

      case 'done': {
        yield stepCompleted(stepId, Date.now() - startTime)

        // tool_use 时不发 turnEnded — 后续还有 tool call loop
        // 只有 end_turn 时才发 turnEnded 表示本轮完成
        if (event.stopReason !== 'tool_use') {
          yield turnEnded(
            event.usage.inputTokens,
            event.usage.outputTokens,
            event.usage.cacheReadTokens,
            event.usage.cacheWriteTokens,
          )
        }

        // 终端汇总
        const dur = Date.now() - startTime
        logger.info({
          events: eventCount,
          thinkingChars,
          textChars,
          stopReason: event.stopReason,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          durationMs: dur,
        }, `[LLM] stream done (${thinkingChars}t/${textChars}c in ${dur}ms, stop=${event.stopReason})`)
        break
      }
    }
  }
}
