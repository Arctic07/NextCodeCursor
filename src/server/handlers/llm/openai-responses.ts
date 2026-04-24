/**
 * OpenAI Responses API Provider
 *
 * 走 POST /v1/responses + SSE streaming, 区别于 openai.ts 的 Chat Completions API。
 *
 * 关键差异:
 *   - 输入: instructions (system) + input items[] (非 messages[])
 *   - 输出: ResponseStreamEvent 联合类型 (非 choices[].delta)
 *   - 工具: function_call 是独立 output item, 不嵌套在 message 里
 *   - 推理: reasoning: { effort, summary } 对象 (非 reasoning_effort 顶层字段)
 *   - 存储: store=false (BYOK 不存储到 OpenAI 服务端)
 *   - 内置工具: web_search / image_generation 由 OpenAI 服务端执行
 *
 * 参考: Codex CLI (codex-rs/core/src/client.rs) 的 HTTP/SSE 路径
 */
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses'
import OpenAI from 'openai'
import type { ProviderEntry } from '../../data/defaults'
import { logger } from '../../logger'
import { encodeResponsesInput, encodeResponsesTools } from './conversationCodec'
import { createProxiedFetch } from './proxyFetch'
import { createTransformDiagnostics, hasTransformMutations, transformMessages } from './transformMessages'
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from './types'

export class OpenAIResponsesProvider implements LLMProvider {
  readonly name = 'openai-responses'
  private client: OpenAI

  constructor(entry: ProviderEntry) {
    const opts: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: entry.auth.value,
    }
    if (entry.baseUrl) {
      opts.baseURL = entry.baseUrl
    }
    const proxiedFetch = createProxiedFetch(entry.proxyUrl)
    if (proxiedFetch) {
      opts.fetch = proxiedFetch
    }
    this.client = new OpenAI(opts)
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    const diagnostics = createTransformDiagnostics('openai-responses', request.messages.length)
    const transformed = transformMessages(request.messages, 'openai-responses', diagnostics, request.model)
    if (hasTransformMutations(diagnostics)) {
      logger.debug({
        provider: 'openai-responses',
        model: request.model,
        ...diagnostics,
      }, '[HISTORY_REPAIR] provider conversation transformed')
    }
    const encoded = encodeResponsesInput(transformed)
    const tools = encodeResponsesTools(request.tools)

    const params: ResponseCreateParamsStreaming = {
      model: request.model,
      stream: true,
      store: false,
      input: encoded.items,
      max_output_tokens: request.maxTokens ?? 8192,
    }

    if (encoded.instructions) {
      params.instructions = encoded.instructions
    }

    if (tools) {
      params.tools = tools
      params.tool_choice = 'auto'
    }

    // Reasoning — Responses API 用 reasoning 嵌套对象 (非顶层 reasoning_effort)
    // max 是 Anthropic 专有,映射到 xhigh
    if (request.thinkingLevel) {
      params.reasoning = {
        effort: request.thinkingLevel === 'max' ? 'xhigh' : request.thinkingLevel,
        summary: 'auto',
      }
      // encrypted_content 用于多轮保留推理上下文 (参照 Codex CLI)
      params.include = ['reasoning.encrypted_content']
    }

    const stream = await this.client.responses.create(params)

    // 跟踪活跃的 function_call items (item_id → { callId, name })
    const activeCalls = new Map<string, { callId: string, name: string }>()
    let sawToolCalls = false

    for await (const event of stream) {
      switch (event.type) {
        // ── 文本输出 ──
        case 'response.output_text.delta': {
          yield { type: 'text_delta', text: event.delta }
          break
        }

        // ── 推理 (thinking) ──
        case 'response.reasoning_summary_text.delta': {
          yield { type: 'thinking_delta', text: event.delta }
          break
        }

        // ── 工具调用 ──
        case 'response.output_item.added': {
          const item = event.item
          if (item.type === 'function_call') {
            const itemId = item.id ?? item.call_id
            activeCalls.set(itemId, { callId: item.call_id, name: item.name })
            yield { type: 'tool_use_start', id: item.call_id, name: item.name }
            sawToolCalls = true
          }
          break
        }

        case 'response.function_call_arguments.delta': {
          const call = activeCalls.get(event.item_id)
          if (call) {
            yield { type: 'tool_use_delta', id: call.callId, input: event.delta }
          }
          break
        }

        case 'response.output_item.done': {
          const item = event.item
          if (item.type === 'function_call') {
            const itemId = item.id ?? item.call_id
            const call = activeCalls.get(itemId)
            if (call) {
              yield { type: 'tool_use_done', id: call.callId }
            }
          }
          else if (item.type === 'reasoning') {
            // Pi 方式: 存整个 ResponseReasoningItem JSON 以便回传时完整还原
            yield { type: 'thinking_done', signature: JSON.stringify(item) }
          }
          break
        }

        // ── 完成 ──
        case 'response.completed': {
          const r = event.response
          yield {
            type: 'done',
            stopReason: sawToolCalls
              ? 'tool_use'
              : r.status === 'incomplete'
                ? 'max_tokens'
                : 'end_turn',
            usage: {
              inputTokens: r.usage?.input_tokens ?? 0,
              outputTokens: r.usage?.output_tokens ?? 0,
            },
          }
          break
        }

        // ── 失败 / 不完整 ──
        case 'response.failed': {
          const err = event.response?.error
          throw new Error(`OpenAI Responses API failed: ${err?.message ?? 'unknown error'}`)
        }

        case 'response.incomplete': {
          yield {
            type: 'done',
            stopReason: 'max_tokens',
            usage: { inputTokens: 0, outputTokens: 0 },
          }
          break
        }

        // 其他事件 (created, in_progress, content_part, web_search, image_gen 等) — 暂不处理
        default:
          break
      }
    }
  }
}
