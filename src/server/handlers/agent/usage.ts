import type { LLMUsage } from '../llm/types';

export interface UsageTotals {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

export function emptyUsageTotals(): UsageTotals {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
}

export function addUsage(totals: UsageTotals, usage: LLMUsage): UsageTotals {
    return {
        inputTokens: totals.inputTokens + usage.inputTokens,
        outputTokens: totals.outputTokens + usage.outputTokens,
        cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    };
}

/**
 * 近似当前会话上下文占用。
 *
 * provider 的 inputTokens 代表本轮 prompt 规模，outputTokens 代表本轮新增 assistant 内容。
 * 对于未压缩对话，使用 input + output 的单调最大值，能比硬编码 0 更接近客户端需要的上下文压力信号。
 */
export function estimateContextTokens(usage: LLMUsage): number {
    return Math.max(0, usage.inputTokens + usage.outputTokens);
}

export function clampTokenDetails(usedTokens: number, maxTokens: number): { usedTokens: number; maxTokens: number } {
    const safeMax = Math.max(1, maxTokens);
    return {
        usedTokens: Math.max(0, Math.min(usedTokens, safeMax)),
        maxTokens: safeMax,
    };
}

export function computeContextUsagePercent(usedTokens: number, maxTokens: number): number {
    const { usedTokens: safeUsed, maxTokens: safeMax } = clampTokenDetails(usedTokens, maxTokens);
    return Number(((safeUsed / safeMax) * 100).toFixed(2));
}

export function shouldTriggerCompaction(usedTokens: number, maxTokens: number, thresholdPercent = 90): boolean {
    return computeContextUsagePercent(usedTokens, maxTokens) >= thresholdPercent;
}
