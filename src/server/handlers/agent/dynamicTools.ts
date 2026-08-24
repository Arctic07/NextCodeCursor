/**
 * Dynamic Tools — GetDynamicTools 结果渲染
 *
 * 1:1 复刻官方 Cursor 3.15.6 的返回结构。所有形状与常量都来自实测套取
 * (analysis/mcp-dynamic-tools.md §4.5),非推断:
 *
 *   {"namespace":"x","toolName":"y"} → {mode:"single_tool", namespace, namespaceStatus, tool}
 *   {"namespace":"x"}                → {mode:"namespace",   namespace, namespaceStatus, tools[]}
 *   {"pattern":"re"}                 → {mode:"search",      pattern, matches[]}
 *   {}                               → {mode:"catalog",     namespaces[]}
 *
 * 两条关键差异 (照抄,勿"优化"):
 *   - inputSchema 只在 single_tool / namespace 出现;search / catalog 只给
 *     tool + description。对应 prompt 里 "namespace and single-tool lookups
 *     always return the complete description"。
 *   - search / catalog 的 description 超过 185 字符时截断为
 *     slice(0,185) + "... [truncated]",总长恰好 200。实测未截断样本最长 179。
 */
import type { McpStateServerInfo, McpStateToolDefinition } from './mcpState';

/** 截断后缀 — 实测原文,长度 15 */
const TRUNCATION_SUFFIX = '... [truncated]';
/** 截断保留的正文长度 — 实测 185,加后缀恰好 200 */
const TRUNCATION_BODY_LIMIT = 185;

/**
 * search / catalog 模式的 description 裁剪。
 * 未超限时原样返回(不追加后缀)。
 */
export function shortenDescription(description: string): string {
    if (description.length <= TRUNCATION_BODY_LIMIT)
        return description;
    return description.slice(0, TRUNCATION_BODY_LIMIT) + TRUNCATION_SUFFIX;
}

/**
 * 服务端自动追加的认证工具。
 *
 * 实测: requestContext.supports_mcp_auth = true 时,每个 MCP namespace 的
 * tools 末尾都会多出这一项 —— 它**不在**客户端下发的 descriptor 里,
 * 由服务端凭空补上。
 */
export const MCP_AUTH_TOOL = {
    tool: 'mcp_auth',
    description: 'Authenticate this MCP server so its tools can be used.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

export interface DynamicToolsQuery {
    /** LLM 侧参数名是 namespace,proto 侧字段名是 server */
    namespace?: string;
    toolName?: string;
    pattern?: string;
}

/** 一个可被 discovery 的 namespace */
export interface DynamicNamespace {
    name: string;
    source: 'mcp' | 'cursor';
    /** MCP namespace 用它 (实测 "ready") */
    status?: string;
    /** cursor namespace 用它,与 status 互斥 */
    description?: string;
    tools: Array<{ tool: string; description: string; inputSchema: Record<string, unknown> }>;
}

/** 把 mcpState 拉回的 server 转成 namespace;supportsMcpAuth 时补 mcp_auth */
export function toDynamicNamespace(
    server: McpStateServerInfo,
    supportsMcpAuth: boolean,
): DynamicNamespace {
    const tools = server.tools.map((t: McpStateToolDefinition) => ({
        tool: t.toolName,
        description: t.description,
        inputSchema: t.inputSchema,
    }));
    if (supportsMcpAuth)
        tools.push({ ...MCP_AUTH_TOOL, inputSchema: { ...MCP_AUTH_TOOL.inputSchema } });
    return {
        name: server.serverIdentifier,
        source: 'mcp',
        status: server.status,
        tools,
    };
}

/** 供 namespace / single_tool 使用的完整工具形状 */
function fullTool(t: DynamicNamespace['tools'][number]) {
    return { tool: t.tool, description: t.description, inputSchema: t.inputSchema };
}

/** 供 search / catalog 使用的精简工具形状 —— 无 inputSchema,description 截断 */
function slimTool(t: DynamicNamespace['tools'][number]) {
    return { tool: t.tool, description: shortenDescription(t.description) };
}

/**
 * namespace 元信息 —— MCP 用 namespaceStatus,cursor 用 namespaceDescription,
 * 二者互斥 (实测)。
 */
function namespaceMeta(ns: DynamicNamespace): Record<string, unknown> {
    return ns.source === 'cursor'
        ? (ns.description ? { namespaceDescription: ns.description } : {})
        : { namespaceStatus: ns.status ?? 'ready' };
}

/**
 * 渲染 GetDynamicTools 的返回体。
 *
 * @param namespaces 本次查询范围内、已取回完整 schema 的 namespace
 */
export function renderDynamicToolsResult(
    query: DynamicToolsQuery,
    namespaces: DynamicNamespace[],
): Record<string, unknown> {
    const { namespace, toolName, pattern } = query;

    // 模式 3/4: pattern 搜索 (无 namespace 限定则跨全部 namespace)
    if (pattern !== undefined && pattern !== '') {
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, 'i');
        }
        catch {
            // 非法正则退化为字面量子串匹配,不让 LLM 因写错正则而卡死
            const literal = pattern.toLowerCase();
            regex = { test: (s: string) => s.toLowerCase().includes(literal) } as RegExp;
        }
        const scope = namespace ? namespaces.filter(n => n.name === namespace) : namespaces;
        const matches: Array<Record<string, unknown>> = [];
        for (const ns of scope) {
            for (const t of ns.tools) {
                // 官方描述: "searches namespace and tool names"
                if (regex.test(t.tool) || regex.test(ns.name))
                    matches.push({ namespace: ns.name, ...slimTool(t) });
            }
        }
        return { mode: 'search', pattern, matches };
    }

    if (namespace) {
        const ns = namespaces.find(n => n.name === namespace);
        if (!ns) {
            return {
                mode: toolName ? 'single_tool' : 'namespace',
                namespace,
                namespaceStatus: 'not_found',
                error: `Namespace "${namespace}" was not found.`,
            };
        }

        // 模式 2: 单工具
        if (toolName) {
            const t = ns.tools.find(x => x.tool === toolName);
            if (!t) {
                return {
                    mode: 'single_tool',
                    namespace,
                    ...namespaceMeta(ns),
                    error: `Tool "${toolName}" was not found in namespace "${namespace}".`,
                };
            }
            return { mode: 'single_tool', namespace, ...namespaceMeta(ns), tool: fullTool(t) };
        }

        // 模式 1: 整个 namespace
        return { mode: 'namespace', namespace, ...namespaceMeta(ns), tools: ns.tools.map(fullTool) };
    }

    // 模式 5: 无参数 → 全量 catalog (精简)
    return {
        mode: 'catalog',
        namespaces: namespaces.map(ns => ({
            namespace: ns.name,
            ...namespaceMeta(ns),
            tools: ns.tools.map(slimTool),
        })),
    };
}

/**
 * 生成 preamble 里的 <dynamic_tools> 段。
 *
 * 正文逐字来自官方实测 (analysis/mcp-dynamic-tools.md §3)。namespace 列表
 * 由 mcpDescriptors 生成 —— name 必须用 serverIdentifier 而非 serverName。
 *
 * 我们只产出 source="mcp" 的 namespace: 官方把自家内置工具收进 cursor
 * namespace 是为省 token,而我们的内置工具保持扁平下发,少一层展开。
 */
export function buildDynamicToolsSection(
    servers: Array<{ serverIdentifier: string; toolNames: string[]; serverUseInstructions?: string }>,
    supportsMcpAuth: boolean,
): string {
    const entries = servers.map((s) => {
        const tools = supportsMcpAuth ? [...s.toolNames, MCP_AUTH_TOOL.tool] : s.toolNames;
        const attrs = [
            `name="${escapeXmlAttr(s.serverIdentifier)}"`,
            `tools="${escapeXmlAttr(tools.join(', '))}"`,
        ];
        if (s.serverUseInstructions)
            attrs.push(`namespaceUseInstructions="${escapeXmlAttr(s.serverUseInstructions)}"`);
        attrs.push('source="mcp"');
        return `<namespace ${attrs.join(' ')} />`;
    });

    const authNote = supportsMcpAuth
        ? `\n\nIf an MCP-backed namespace requires authentication, call \`mcp_auth\` through \`CallDynamicTool\` for that namespace, then inspect it again and retry if appropriate. Do not authenticate namespaces preemptively or repeatedly.`
        : '';

    return `
<dynamic_tools>
You have access to tools through dynamic namespaces, e.g. MCP servers, using \`GetDynamicTools\` and \`CallDynamicTool\`.

## Dynamic Tool Discovery and Invocation

Use \`GetDynamicTools\` to discover tool schemas, then \`CallDynamicTool\` to invoke one tool. Aim to minimize round-trips: ideally one discovery call followed by one invocation.

If the user mentions a product or service represented by an available namespace, and the request likely depends on it, proactively inspect that namespace before answering. If you are unsure which namespace matches, search with a relevant pattern.

\`GetDynamicTools\` supports these modes:

1. \`{"namespace":"<id>"}\`: returns schemas and full descriptions for every tool in that namespace.
2. \`{"namespace":"<id>","toolName":"<name>"}\`: returns one tool schema with its full description.
3. \`{"pattern":"<regex>"}\`: searches namespace and tool names.
4. \`{"namespace":"<id>","pattern":"<regex>"}\`: searches tools within one namespace.
5. No arguments: returns the full catalog.

Pattern-search and catalog results shorten long descriptions, marked by a trailing "${TRUNCATION_SUFFIX}"; namespace and single-tool lookups always return the complete description.

Always inspect a tool's schema before invoking it with \`CallDynamicTool\`.

If the available dynamic tools do not fully support what the user asked you to do, complete the work you can with the current tool set. In your work summary, include what you were unable to do and why. Do not use browser automation to work around missing tools unless the user explicitly asks you to use the browser.


Available dynamic tool namespaces:

<dynamic_tool_namespaces>
${entries.join('\n')}
</dynamic_tool_namespaces>${authNote}
</dynamic_tools>`;
}

function escapeXmlAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
