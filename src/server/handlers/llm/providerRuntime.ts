import type { LLMContentBlock, LLMProvider, LLMMessage, LLMStreamRequest, LLMTool, LLMToolResultBlock } from './types';
import type { ProviderEntry, ProviderType } from '../../data/defaults';
import { AnthropicProvider } from './anthropic';
import { OpenAIChatProvider } from './openai-chat';
import { OpenAIResponsesProvider } from './openai-responses';
import { GeminiProvider } from './gemini';
import { resolveModel } from '../models/mapper';
import type { ProviderStateStrategy } from './stateStrategy';
import { anthropicStateStrategy, geminiStateStrategy, openAIStateStrategy } from './stateStrategy';
import { resolvePromptProfile, type ProviderPromptProfile } from './promptProfile';
import type { ProviderToolCatalog } from './toolCatalog';
import {
    anthropicConversationCodec,
    geminiConversationCodec,
    openAIChatConversationCodec,
    openAIResponsesConversationCodec,
    type ProviderConversationCodec,
} from './conversationCodec';
import type { SemanticTurn } from './semanticConversation';
import { llmMessageToStoredMessage } from './storedTranscript';
import { filterToolsForMode } from '../agent/toolkit/types';

export interface PreparedProviderConversation {
    normalizedMessages: LLMMessage[];
    semanticTurns: SemanticTurn[];
}

export interface PreparedProviderRequest {
    conversation: PreparedProviderConversation;
    request: LLMStreamRequest;
}

export interface ProviderRoundTransition {
    assistantAdded: boolean;
    flushedToolResults: number;
    shouldContinue: boolean;
}

export interface ProviderRoundContext {
    pendingToolResults: LLMToolResultBlock[];
    createToolResult(params: {
        toolCallId: string;
        toolName: string;
        content: string;
        isError: boolean;
    }): LLMToolResultBlock;
    recordToolResult(messages: LLMMessage[], result: LLMToolResultBlock): void;
    transition(messages: LLMMessage[], assistantContent: LLMContentBlock[]): ProviderRoundTransition;
}

export interface ProviderRuntime {
    provider: LLMProvider;
    stateStrategy: ProviderStateStrategy;
    conversationCodec: ProviderConversationCodec;
    promptProfile: ProviderPromptProfile;
    toolCatalog: ProviderToolCatalog;
    model: string;
    thinking: boolean;
    contextTokenLimit: number;
    contextTokenLimitForMaxMode: number;
    supportsAutoContext: boolean;
    prepareConversation(messages: LLMMessage[]): PreparedProviderConversation;
    prepareStreamRequest(messages: LLMMessage[], extraTools?: LLMTool[], maxTokens?: number, mode?: string): PreparedProviderRequest;
    listRuntimeTools(extraTools?: LLMTool[], mode?: string): LLMTool[];
    createRoundContext(): ProviderRoundContext;
    transitionRound(messages: LLMMessage[], assistantContent: LLMContentBlock[], pendingToolResults?: LLMToolResultBlock[]): ProviderRoundTransition;
}

/**
 * Provider SDK 实例缓存 — 按 ProviderEntry.id 维度复用 client。
 * 同一个 entry 的多次解析共享一个 client; 编辑 providers.json 后通过
 * resetProviderInstanceCache() 重置 (目前仅在测试用,生产期可加 watch 自动重置)。
 */
const providerInstances = new Map<string, LLMProvider>();

function instantiateProvider(entry: ProviderEntry): LLMProvider {
    switch (entry.type) {
        case 'anthropic': return new AnthropicProvider(entry);
        case 'openai-chat': return new OpenAIChatProvider(entry);
        case 'openai-responses': return new OpenAIResponsesProvider(entry);
        case 'gemini': return new GeminiProvider(entry);
    }
}

function getProviderForEntry(entry: ProviderEntry): LLMProvider {
    let inst = providerInstances.get(entry.id);
    if (!inst) {
        inst = instantiateProvider(entry);
        providerInstances.set(entry.id, inst);
    }
    return inst;
}

export function resetProviderInstanceCache(): void {
    providerInstances.clear();
}

function getStateStrategy(name: ProviderType): ProviderStateStrategy {
    switch (name) {
        case 'anthropic': return anthropicStateStrategy;
        case 'openai-chat':
        case 'openai-responses': return openAIStateStrategy;
        case 'gemini': return geminiStateStrategy;
    }
}

function getConversationCodec(name: ProviderType): ProviderConversationCodec {
    switch (name) {
        case 'anthropic': return anthropicConversationCodec;
        case 'openai-chat': return openAIChatConversationCodec;
        case 'openai-responses': return openAIResponsesConversationCodec;
        case 'gemini': return geminiConversationCodec;
    }
}

function syntheticProviderEntry(type: ProviderType): ProviderEntry {
    return {
        id: `__synthetic__${type}`,
        name: `Synthetic ${type}`,
        type,
        baseUrl: '',
        auth: { kind: 'apiKey', value: '' },
        models: [],
    };
}

export function resolveProviderRuntime(modelId: string): ProviderRuntime {
    const resolved = resolveModel(modelId);
    const promptProfile = resolvePromptProfile(modelId);
    const conversationCodec = getConversationCodec(resolved.provider);
    const stateStrategy = getStateStrategy(resolved.provider);
    const providerEntry = resolved.providerEntry ?? syntheticProviderEntry(resolved.provider);
    const prepareConversation = (messages: LLMMessage[]): PreparedProviderConversation => {
        const normalizedMessages = conversationCodec.normalizeMessages(messages);
        return {
            normalizedMessages,
            semanticTurns: conversationCodec.normalizeStoredTranscript(normalizedMessages.map(llmMessageToStoredMessage)),
        };
    };
    const listRuntimeTools = (extraTools: LLMTool[] = [], mode?: string): LLMTool[] => {
        const builtins = promptProfile.toolCatalog.listBuiltins();
        const all = [...builtins, ...extraTools];
        return mode ? filterToolsForMode(all, mode) : all;
    };
    return {
        provider: getProviderForEntry(providerEntry),
        stateStrategy,
        conversationCodec,
        promptProfile,
        toolCatalog: promptProfile.toolCatalog,
        model: resolved.apiModel,
        thinking: resolved.thinking,
        contextTokenLimit: resolved.contextTokenLimit,
        contextTokenLimitForMaxMode: resolved.contextTokenLimitForMaxMode,
        supportsAutoContext: resolved.supportsAutoContext,
        prepareConversation,
        prepareStreamRequest(messages: LLMMessage[], extraTools: LLMTool[] = [], maxTokens = 8192, mode?: string): PreparedProviderRequest {
            const conversation = prepareConversation(messages);
            return {
                conversation,
                request: {
                    model: resolved.apiModel,
                    messages: conversation.normalizedMessages,
                    tools: listRuntimeTools(extraTools, mode),
                    thinking: resolved.thinking,
                    thinkingLevel: resolved.thinkingLevel,
                    thinkingBudgetTokens: resolved.thinkingBudgetTokens,
                    maxTokens,
                },
            };
        },
        listRuntimeTools,
        createRoundContext(): ProviderRoundContext {
            const pendingToolResults: LLMToolResultBlock[] = [];
            return {
                pendingToolResults,
                createToolResult(params) {
                    return stateStrategy.createToolResult(params);
                },
                recordToolResult(messages: LLMMessage[], result: LLMToolResultBlock): void {
                    stateStrategy.addToolResult(messages, pendingToolResults, result);
                },
                transition(messages: LLMMessage[], assistantContent: LLMContentBlock[]): ProviderRoundTransition {
                    const assistantAdded = assistantContent.length > 0;
                    if (assistantAdded) {
                        messages.push({ role: 'assistant', content: assistantContent });
                    }
                    const flushedToolResults = pendingToolResults.length;
                    if (flushedToolResults > 0) {
                        stateStrategy.flushToolResults(messages, pendingToolResults);
                    }
                    return {
                        assistantAdded,
                        flushedToolResults,
                        shouldContinue: flushedToolResults > 0,
                    };
                },
            };
        },
        transitionRound(messages: LLMMessage[], assistantContent: LLMContentBlock[], pendingToolResults: LLMToolResultBlock[] = []): ProviderRoundTransition {
            const assistantAdded = assistantContent.length > 0;
            if (assistantAdded) {
                messages.push({ role: 'assistant', content: assistantContent });
            }
            const flushedToolResults = pendingToolResults.length;
            if (flushedToolResults > 0) {
                stateStrategy.flushToolResults(messages, pendingToolResults);
            }
            return {
                assistantAdded,
                flushedToolResults,
                shouldContinue: flushedToolResults > 0,
            };
        },
    };
}
