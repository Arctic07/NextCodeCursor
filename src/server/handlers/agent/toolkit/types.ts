import type { LLMTool } from '../../llm/types';
import type { ProviderType } from '../../../data/defaults';

export interface ToolExecBuildOptions {
    conversationId?: string;
    currentModelId?: string;
}

/**
 * Provider 族 — 将 4 种 ProviderType 归约为 3 种工具目录。
 * openai-chat 与 openai-responses 共享同一套工具定义。
 */
export type ProviderFamily = 'anthropic' | 'openai' | 'gemini';

export function toProviderFamily(pt: ProviderType): ProviderFamily {
    switch (pt) {
        case 'anthropic': return 'anthropic';
        case 'openai-chat':
        case 'openai-responses': return 'openai';
        case 'gemini': return 'gemini';
        default: return 'anthropic';
    }
}

/**
 * Cursor Agent 交互模式 — 决定暴露哪些工具给 LLM。
 * 客户端通过 AGENT_MODE_* 枚举传入，这里归约为小写。
 */
export type CursorAgentMode = 'agent' | 'ask' | 'plan' | 'debug';

/**
 * 模式过滤规则:
 *   - agent/debug: 完整工具集
 *   - ask: 只读子集 (移除写入/删除/子任务工具)
 *   - plan: 类似 agent，可扩展 CreatePlan 等规划工具
 */
const ASK_MODE_EXCLUDED_TOOLS = new Set([
    'StrReplace', 'Write', 'Delete', 'Task', 'Subagent',
    'EditNotebook', 'GenerateImage',
]);

export function filterToolsForMode(tools: LLMTool[], mode: string): LLMTool[] {
    // 客户端传 "AGENT_MODE_ASK" 格式, 归约为 "ask"
    const normalized = mode.replace('AGENT_MODE_', '').toLowerCase() as CursorAgentMode;
    switch (normalized) {
        case 'ask':
            return tools.filter(t => !ASK_MODE_EXCLUDED_TOOLS.has(t.name));
        case 'plan':
        case 'agent':
        case 'debug':
        default:
            return tools;
    }
}

export interface ToolRegistryEntry {
    canonicalName: string;
    /** 所有 provider 可能使用的工具名。LLM 回调时用 findToolByAlias() 匹配。 */
    aliases: string[];
    cursorToolType: string;
    execArgsType: string | null;
    /**
     * 按 provider 族分化的 LLM 工具定义。
     * 包含该工具面向 LLM 的 name / description / inputSchema。
     * 未列出的 provider 族不会暴露此工具。
     */
    llmToolByProvider: Partial<Record<ProviderFamily, LLMTool>>;
    buildStartedArgs?: (input: Record<string, unknown>, callId: string) => Record<string, unknown>;
    buildExecArgs?: (
        input: Record<string, unknown>,
        callId: string,
        options?: ToolExecBuildOptions,
    ) => Record<string, unknown>;
}
