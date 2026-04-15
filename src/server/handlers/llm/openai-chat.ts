/**
 * OpenAI GPT Provider
 *
 * 实现 LLMProvider 接口，封装 openai SDK。
 * 支持 tool_calls, streaming, 以及 OpenAI 兼容端点。
 */
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import type { ProviderEntry } from '../../data/defaults';
import type { LLMProvider, LLMStreamRequest, LLMStreamEvent } from './types';
import { encodeOpenAIRequestMessages, encodeOpenAITools } from './conversationCodec';
import { createProxiedFetch } from './proxyFetch';

export class OpenAIChatProvider implements LLMProvider {
    readonly name = 'openai-chat';
    private client: OpenAI;

    constructor(entry: ProviderEntry) {
        const opts: ConstructorParameters<typeof OpenAI>[0] = {
            apiKey: entry.auth.value,
        };
        if (entry.baseUrl) {
            opts.baseURL = entry.baseUrl;
        }
        const proxiedFetch = createProxiedFetch(entry.proxyUrl);
        if (proxiedFetch) {
            opts.fetch = proxiedFetch;
        }
        this.client = new OpenAI(opts);
    }

    async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
        const params: ChatCompletionCreateParamsStreaming = {
            model: request.model,
            messages: encodeOpenAIRequestMessages(request.messages),
            max_tokens: request.maxTokens ?? 8192,
            stream: true,
            stream_options: { include_usage: true },
        };

        const tools = encodeOpenAITools(request.tools);
        if (tools) {
            params.tools = tools;
        }

        // OpenAI reasoning 枚举与 ProviderModel.thinkingLevel 完全对齐,直接透传
        // (gpt-5 / o-series 模型消费,其他模型忽略)
        if (request.thinkingLevel) {
            params.reasoning_effort = request.thinkingLevel;
        }

        const stream = await this.client.chat.completions.create(params);

        const toolCalls = new Map<number, { id: string; name: string }>();
        let usage: { inputTokens: number; outputTokens: number } | null = null;
        let sawToolCalls = false;

        for await (const chunk of stream) {
            if (chunk.usage) {
                usage = {
                    inputTokens: chunk.usage.prompt_tokens,
                    outputTokens: chunk.usage.completion_tokens,
                };
            }

            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            if (!delta) continue;

            if (typeof delta.content === 'string' && delta.content.length > 0) {
                yield { type: 'text_delta', text: delta.content };
            }

            if (delta.tool_calls) {
                sawToolCalls = true;
                for (const tc of delta.tool_calls) {
                    const existing = toolCalls.get(tc.index) ?? { id: '', name: '' };
                    const next = {
                        id: tc.id ?? existing.id,
                        name: tc.function?.name ?? existing.name,
                    };

                    const shouldStart = !existing.id && !!next.id && !!next.name;
                    toolCalls.set(tc.index, next);

                    if (shouldStart) {
                        yield { type: 'tool_use_start', id: next.id, name: next.name };
                    }

                    if (tc.function?.arguments) {
                        yield {
                            type: 'tool_use_delta',
                            id: next.id,
                            input: tc.function.arguments,
                        };
                    }
                }
            }

            if (choice?.finish_reason === 'tool_calls') {
                for (const [, toolCall] of toolCalls) {
                    if (toolCall.id) {
                        yield { type: 'tool_use_done', id: toolCall.id };
                    }
                }
            }
        }

        yield {
            type: 'done',
            stopReason: sawToolCalls ? 'tool_use' : 'end_turn',
            usage: usage ?? { inputTokens: 0, outputTokens: 0 },
        };
    }
}
