import { str, arr, bool } from '../shared';
import type { ToolRegistryEntry } from '../types';

/**
 * CreatePlan — Plan Mode 专用工具
 *
 * Proto: createPlanToolCall (field 17)
 * Args: CreatePlanArgs { plan, todos[], overview, name, is_project?, phases[] }
 * Result: CreatePlanResult { plan_uri, oneof { success: {}, error: { error } } }
 *
 * 流程: 交互握手 (CreatePlanRequestQuery → CreatePlanRequestResponse)
 * 客户端创建 .plan.md 文件并返回 planUri。
 *
 * 此工具不暴露给 LLM（由系统在 Plan Mode 下自动注入），
 * 但需要注册以处理 LLM 主动调用 CreatePlan 的情况。
 */
export const CreatePlanTool: ToolRegistryEntry = {
    canonicalName: 'CreatePlan',
    aliases: ['CreatePlan'],
    cursorToolType: 'createPlanToolCall',
    execArgsType: null,
    llmToolByProvider: {
        // Plan Mode 时由系统注入，不在标准工具列表中
    },
    buildStartedArgs: (input) => ({
        plan: str(input.plan),
        todos: arr<Record<string, unknown>>(input.todos),
        overview: str(input.overview),
        name: str(input.name),
        ...(typeof input.is_project === 'boolean' ? { isProject: input.is_project } : {}),
        ...(Array.isArray(input.phases) ? { phases: input.phases } : {}),
    }),
};
