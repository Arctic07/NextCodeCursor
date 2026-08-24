/**
 * Tool Call 处理
 *
 * Agent 协议中的工具调用生命周期 (从原始抓包分析):
 *
 * 1. LLM 返回 tool_use block:
 *    → partialToolCall (预告，参数未完成)
 *    → tokenDelta ×N (参数 tokens)
 *    → toolCallStarted (参数完整)
 *
 * 2. Server 发送执行指令给 Client:
 *    → execServerMessage (grepArgs/readArgs/writeArgs/shellStreamArgs/...)
 *
 * 3. Client 本地执行，通过 BidiAppend 回传:
 *    ← execClientMessage (grepResult/readResult/writeResult/...)
 *    ← execClientControlMessage (streamClose)
 *
 * 4. Server 收到结果:
 *    → kvServerMessage (保存工具结果 blob)
 *    → checkpoint (更新 token 计数)
 *    → toolCallCompleted (含完整 args + result)
 *
 * 5. 将结果喂回 LLM 继续生成 (可能触发更多 tool calls)
 *
 * 工具类型与 exec 通道映射 (from CURSOR_API_SPEC.md §9.4):
 *   shell      → shellStreamArgs / shellStream (流式: start/stdout/exit)
 *   glob       → grepArgs / grepResult (复用 grep 通道, outputMode=files_with_matches)
 *   grep       → grepArgs / grepResult
 *   read       → readArgs / readResult
 *   write/edit → writeArgs / writeResult
 *   delete     → deleteArgs / deleteResult
 *   readLints  → diagnosticsArgs / diagnosticsResult
 *   task       → subagentArgs / subagentResult
 *   await      → 分流: shell 走 readArgs/readResult (读 {terminalsFolder}/{shellId}.txt),
 *                subagent 走 subagentAwaitArgs/subagentAwaitResult。
 *                分流依据是 session 后台 job 注册表的 kind (见 toolRuntime.ts awaitToolCall 分支)。
 *   mcp        → mcpArgs / mcpResult
 *   webSearch  → 无 exec 通道 (Server 端执行)
 *   webFetch   → 无 exec 通道 (Server 端执行)
 *   askQuestion → 无 exec 通道 (Client UI 处理)
 *   updateTodos → 无 exec 通道 (Client 本地处理)
 */

import { logger } from '../../logger';
import type { EditPlan } from './toolkit/editPlans';
import { buildRegisteredEditPlan, buildRegisteredExecArgs, findToolByAlias, findToolByCursorType } from './toolRegistry';
import type { ToolExecBuildOptions } from './toolkit/types';

export interface AvailableMcpTool {
    name: string;
    providerIdentifier?: string;
    toolName?: string;
    /** 归属 server identifier — 回传 McpArgs.server_identifier,限定客户端工具查找范围 */
    serverIdentifier?: string;
}

/**
 * 将 LLM 返回的字符串枚举值转换为 proto int32 枚举值
 *
 * LLM 通过 tool_use 返回的字段值可能是字符串 (如 "TODO_STATUS_PENDING")，
 * 但 proto 中定义的是 int32 enum。需要转换后才能正确序列化。
 */
const TODO_STATUS_MAP: Record<string, number> = {
    'TODO_STATUS_UNSPECIFIED': 0,
    'TODO_STATUS_PENDING': 1,
    'TODO_STATUS_IN_PROGRESS': 2,
    'TODO_STATUS_COMPLETED': 3,
    'TODO_STATUS_CANCELLED': 4,
    // 新 lowercase 枚举（官方 Cursor 工具使用）
    'pending': 1,
    'in_progress': 2,
    'completed': 3,
    'cancelled': 4,
};

/**
 * 将 LLM tool_use input 中的字符串枚举转换为 proto 兼容的 int32
 *
 * 目前处理:
 *   - TodoItem.status: "TODO_STATUS_PENDING" → 1
 */
export function sanitizeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
        return {
            ...input,
            todos: (input.todos as Array<Record<string, unknown>>).map(todo => ({
                ...todo,
                status: typeof todo.status === 'string'
                    ? (TODO_STATUS_MAP[todo.status] ?? 0)
                    : todo.status,
            })),
        };
    }
    return input;
}

// extractToolResult 已移除 — 被 toolkit/results/* 的分模块实现完全替代。
// 旧代码用 switch-case 按 cursorToolType 硬编码,
// 新架构通过 toolResults.ts 链式调度到各 toolkit/results/*.ts 子模块。

/** LLM tool_use block → Cursor tool 类型映射 */
export interface ToolCallInfo {
    callId: string;
    name: string;
    input: Record<string, unknown>;
}

/**
 * 将 LLM tool name 映射到 Cursor 的 toolCall 类型
 *
 * LLM (Anthropic/OpenAI) 返回的 tool name 格式:
 *   read_file, write_file, shell, grep, glob, delete_file, ...
 *
 * Cursor 的 toolCall oneof 类型:
 *   shellToolCall, globToolCall, grepToolCall, readToolCall, editToolCall,
 *   deleteToolCall, readLintsToolCall, webSearchToolCall, webFetchToolCall,
 *   askQuestionToolCall, taskToolCall, mcpToolCall, updateTodosToolCall
 */
export function mapToolName(llmToolName: string): string {
    return findToolByAlias(llmToolName)?.cursorToolType ?? llmToolName;
}

export function mapPartialToolName(llmToolName: string): string {
    if (llmToolName.startsWith('user-')) return 'mcpToolCall';
    return mapToolName(llmToolName);
}

/**
 * 将 Cursor toolCall 类型映射到 execServerMessage 的 args 类型
 *
 * 返回 null 表示该工具无需 exec 通道 (Server 端或 Client 本地处理)
 */
export function mapToolToExecArgs(cursorToolType: string): string | null {
    return findToolByCursorType(cursorToolType)?.execArgsType ?? null;
}

/**
 * 构造 execServerMessage 的 args 对象
 *
 * 按 LLM 工具名（alias）查找构建函数，生成 Cursor 协议的 exec args。
 */
export function buildExecArgs(
    llmToolName: string,
    input: Record<string, unknown>,
    callId: string,
    options: ToolExecBuildOptions = {},
): Record<string, unknown> {
    const registered = buildRegisteredExecArgs(llmToolName, input, callId, options);
    if (registered) return registered;
    logger.warn({ llmToolName }, '[TOOL] unknown tool name for exec args');
    return { toolCallId: callId };
}

export function buildEditPlan(
    llmToolName: string,
    input: Record<string, unknown>,
    callId: string,
    options: ToolExecBuildOptions = {},
): EditPlan {
    const plan = buildRegisteredEditPlan(llmToolName, input, callId, options);
    if (plan) return plan;
    throw new Error(`Tool ${llmToolName} does not support edit plans`);
}

export function resolveToolCall(
    llmToolName: string,
    input: Record<string, unknown>,
    availableMcpTools: AvailableMcpTool[] = [],
): { cursorToolType: string; sanitizedInput: Record<string, unknown> } {
    const sanitizedInput = sanitizeToolInput(llmToolName, input);

    // dynamic namespace 模式: LLM 直接调 CallDynamicTool,自带
    // namespace + toolName + arguments (官方 LLM 侧参数名,实测 3.15.6)。
    // 这里把它映射成 McpArgs 需要的路由字段。
    //
    // namespace 的值官方用的是 serverIdentifier (如 user-ida-pro-mcp) ——
    // <dynamic_tools> 段里的 name 属性就是它。但也接受 serverName,
    // 因为 LLM 可能从 mcp_instructions 等处读到展示名。
    //
    // CallMcpTool / server 是本项目早期实现与旧版本的参数名,保留兼容,
    // 避免会话中途升级时正在进行的调用失配。
    if (llmToolName === 'CallDynamicTool' || llmToolName === 'call_dynamic_tool'
      || llmToolName === 'CallMcpTool' || llmToolName === 'call_mcp_tool') {
        const server = String(input.namespace ?? input.server ?? '');
        const toolName = String(input.toolName ?? input.tool_name ?? '');
        const args = (input.arguments ?? input.args ?? {}) as Record<string, unknown>;

        const matched = availableMcpTools.find(t =>
            t.toolName === toolName
            && (t.serverIdentifier === server || t.providerIdentifier === server));
        // 路由结果直接决定 McpArgs 发给哪个 server。matched=false 时走的是
        // "按 LLM 给的字面量硬发"这条兜底路径 —— 客户端很可能报 tool not found,
        // 所以单独记一条,便于把"名字对不上"和"MCP server 本身故障"区分开。
        logger[matched ? 'debug' : 'warn']({
            llmToolName,
            namespace: server,
            toolName,
            argKeys: Object.keys(args),
            routed: matched
                ? { name: matched.name, serverIdentifier: matched.serverIdentifier }
                : null,
            knownMcpTools: matched ? undefined : availableMcpTools.length,
        }, matched
            ? '[DYNAMIC-TOOLS] CallDynamicTool routed'
            : '[DYNAMIC-TOOLS] CallDynamicTool not in routing table — forwarding as-is');
        // 未匹配到也照发 —— 客户端 callTool 以 toolName 为准,serverIdentifier 仅作过滤器;
        // 宁可让客户端报 "tool not found",也好过我们这里静默吞掉调用。
        return {
            cursorToolType: 'mcpToolCall',
            sanitizedInput: {
                name: matched?.name ?? (server ? `${server}-${toolName}` : toolName),
                args,
                providerIdentifier: matched?.providerIdentifier ?? server,
                toolName,
                serverIdentifier: matched?.serverIdentifier ?? server,
            },
        };
    }

    const descriptor = availableMcpTools.find(tool => tool.name === llmToolName);

    if (descriptor && (descriptor.providerIdentifier || descriptor.toolName)) {
        return {
            cursorToolType: 'mcpToolCall',
            sanitizedInput: {
                name: llmToolName,
                args: sanitizedInput,
                providerIdentifier: descriptor.providerIdentifier ?? '',
                toolName: descriptor.toolName ?? '',
                serverIdentifier: descriptor.serverIdentifier ?? '',
            },
        };
    }

    return {
        cursorToolType: mapToolName(llmToolName),
        sanitizedInput,
    };
}
