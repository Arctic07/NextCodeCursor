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
/**
 * 拆解 Claude Code 的扁平 MCP 工具名 `mcp__<server>__<tool>`。
 *
 * 切分规则照抄客户端 (workbench.desktop.main.js 的 hook matcher 转换 lQg):
 *
 *   if (o.startsWith("mcp__")) {
 *     const c = o.split("__");
 *     if (c.length >= 3) { const l = c.slice(2).join("__"); push(`MCP:${l}`) }
 *   }
 *
 * 由此确定三点:
 *   - 前缀 `mcp__` **大小写敏感** (客户端用 startsWith,非正则)
 *   - server 是第 2 段,不含 `__`
 *   - toolName 是第 3 段起,**可以含 `__`** (slice(2).join("__"))
 *
 * 需要说明的是,客户端这段代码只用于把 Claude Code 的 hook 配置翻译成 Cursor
 * 格式 —— 它旁边就是 Bash→Shell / Read→Read 这张 Claude Code 工具名映射表。
 * 客户端本身**从不用这个命名收发工具调用**,所以这层归一纯属服务端职责:
 * 模型(Claude 系)按其训练惯例发出该形式,我们负责翻译成 McpArgs 范式。
 *
 * 实测样本 (1-ClaudeCodeRev.log 2026-08-25) 里 server 段两种形态都出现过:
 *   mcp__user-ida-pro-mcp__instance_list   ← serverIdentifier
 *   mcp__ida-pro-mcp__instance_list        ← 用户在 mcp.json 里写的名字
 *
 * 后者其实更贴近用户认知 —— `user-` 并非名字的一部分,而是 Cursor 内部按配置
 * 作用域加的前缀 (workbench 的 mcp-config-service.ts):
 *
 *   computeIdentifier(e)       → `${prefix}${e.name}` (有 extensionId 时再插一段)
 *   computeIdentifierPrefix(p) → p ? `project-${p}-` : "user-"
 *
 * 即 serverIdentifier = 作用域前缀 + 用户写的 name,项目级配置的前缀还是
 * `project-{projectPath}-`。用户和模型认的都是 name,所以 server 段两种形态
 * 都得认 —— 且不能靠"剥掉 user- 前缀"来归一,前缀形态不止一种。
 */
export function parseFlatMcpToolName(name: string): { server: string; toolName: string } | null {
    if (!name.startsWith('mcp__')) return null;
    const parts = name.split('__');
    if (parts.length < 3) return null;
    const server = parts[1];
    const toolName = parts.slice(2).join('__');
    return server && toolName ? { server, toolName } : null;
}

/**
 * 用路由表把扁平名解析成权威条目。
 *
 * server/tool 的权威来源是路由表 —— 客户端经 requestContext 下发,或 discovery
 * 时经 mcpStateExecArgs 取回,不是模型给的这串字符。
 *
 * 匹配以 toolName 为主、server 为辅,对齐客户端 MCPService.callTool 的语义:
 * 它按 toolName 查找,serverIdentifier 只用来限定范围
 * (`for (const g in tools) { if (s && g !== s) continue; ... }`)。
 * 因此 server 段写成 providerIdentifier 时仍能落到正确条目上。
 */
function resolveFlatMcpTool(
    parsed: { server: string; toolName: string },
    availableMcpTools: AvailableMcpTool[],
): AvailableMcpTool | undefined {
    const sameTool = availableMcpTools.filter(t => t.toolName === parsed.toolName);
    if (sameTool.length === 0) return undefined;
    const byServer = sameTool.find(t =>
        t.serverIdentifier === parsed.server || t.providerIdentifier === parsed.server);
    if (byServer) return byServer;
    // server 段对不上但工具名唯一 —— 按客户端"以 toolName 为准"的语义接受
    return sameTool.length === 1 ? sameTool[0] : undefined;
}

export function mapToolName(llmToolName: string): string {
    const registered = findToolByAlias(llmToolName)?.cursorToolType;
    if (registered) return registered;
    if (parseFlatMcpToolName(llmToolName)) return 'mcpToolCall';
    return llmToolName;
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

    // Claude Code 扁平命名 `mcp__<server>__<tool>` → Cursor McpArgs 范式。
    // 放在按名精确匹配之后: 真有工具就注册成这个名字时仍走 descriptor 路径。
    const flat = availableMcpTools.some(t => t.name === llmToolName)
        ? null
        : parseFlatMcpToolName(llmToolName);
    if (flat) {
        const matched = resolveFlatMcpTool(flat, availableMcpTools);
        // 命中路由表 = 正常的命名归一;未命中说明 discovery 还没跑过或工具不存在,
        // 此时按解析值照发 —— 让客户端给出结构化 tool-not-found,
        // 总好过把它无法解析的 toolCall case 丢过去。
        logger[matched ? 'debug' : 'warn']({
            llmToolName,
            server: flat.server,
            toolName: flat.toolName,
            routed: matched?.name ?? null,
            routingTableSize: matched ? undefined : availableMcpTools.length,
        }, matched
            ? '[DYNAMIC-TOOLS] flat mcp__ name resolved via routing table'
            : '[DYNAMIC-TOOLS] flat mcp__ name not in routing table — forwarding parsed values');
        return {
            cursorToolType: 'mcpToolCall',
            sanitizedInput: {
                name: matched?.name ?? llmToolName,
                args: sanitizedInput,
                providerIdentifier: matched?.providerIdentifier ?? flat.server,
                toolName: matched?.toolName ?? flat.toolName,
                serverIdentifier: matched?.serverIdentifier ?? flat.server,
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
