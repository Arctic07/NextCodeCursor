import {
    arr,
    bool,
    envelope,
    obj,
    resultCase,
    str,
    truncate,
    type ToolResultEnvelope,
} from './shared';

function normalizeMcpContentItem(value: unknown): Record<string, unknown> {
    const item = obj(value);
    const content = obj(item.content);

    if (typeof content.case === 'string') {
        if (content.case === 'text') {
            const textValue = obj(content.value);
            return {
                content: {
                    case: 'text',
                    value: {
                        text: str(textValue.text),
                        ...(textValue.outputLocation ? { outputLocation: obj(textValue.outputLocation) } : {}),
                    },
                },
            };
        }
        if (content.case === 'image') {
            const imageValue = obj(content.value);
            return {
                content: {
                    case: 'image',
                    value: {
                        data: imageValue.data,
                        mimeType: str(imageValue.mimeType),
                    },
                },
            };
        }
    }

    if (item.text) {
        const textValue = obj(item.text);
        return {
            content: {
                case: 'text',
                value: {
                    text: str(textValue.text),
                    ...(textValue.outputLocation ? { outputLocation: obj(textValue.outputLocation) } : {}),
                },
            },
        };
    }
    if (item.image) {
        const imageValue = obj(item.image);
        return {
            content: {
                case: 'image',
                value: {
                    data: imageValue.data,
                    mimeType: str(imageValue.mimeType),
                },
            },
        };
    }

    return {
        content: {
            case: 'text',
            value: {
                text: '',
            },
        },
    };
}

export function buildMcpExecToolResult(
    cursorToolType: string,
    execClientMsg: Record<string, unknown>,
    input: Record<string, unknown>,
): ToolResultEnvelope | null {
    switch (cursorToolType) {
        case 'mcpToolCall': {
            const mr = obj(execClientMsg.mcpResult);
            const mc = resultCase(mr);
            return mc ? { result: mc } : { result: { case: 'error', value: { error: 'no result' } } };
        }
        case 'listMcpResourcesToolCall': {
            const lr = obj(execClientMsg.listMcpResourcesExecResult);
            const lc = resultCase(lr);
            return lc ? { result: lc } : { result: { case: 'error', value: { error: 'no result' } } };
        }
        case 'readMcpResourceToolCall': {
            const rr = obj(execClientMsg.readMcpResourceExecResult);
            const rc = resultCase(rr);
            return rc ? { result: rc } : { result: { case: 'error', value: { error: 'no result', uri: str(input.uri) } } };
        }
        default:
            return null;
    }
}

export function normalizeMcpToolResult(
    cursorToolType: string,
    resultCaseName: string,
    value: Record<string, unknown>,
    input: Record<string, unknown>,
): ToolResultEnvelope | null {
    switch (cursorToolType) {
        case 'mcpToolCall':
            if (resultCaseName === 'success') {
                return envelope('success', {
                    content: arr<Record<string, unknown>>(value.content).map(normalizeMcpContentItem),
                    isError: bool(value.isError),
                    ...(value.structuredContent ? { structuredContent: obj(value.structuredContent) } : {}),
                });
            }
            return envelope(resultCaseName || 'error', value);
        case 'listMcpResourcesToolCall':
            if (resultCaseName === 'success') {
                return envelope('success', {
                    resources: arr<Record<string, unknown>>(value.resources).map(resource => ({
                        uri: str(resource.uri),
                        server: str(resource.server),
                        ...(typeof resource.name === 'string' ? { name: resource.name } : {}),
                        ...(typeof resource.description === 'string' ? { description: resource.description } : {}),
                        ...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType } : {}),
                        annotations: Object.fromEntries(
                            Object.entries(obj(resource.annotations)).map(([key, v]) => [key, str(v)]),
                        ),
                    })),
                });
            }
            return envelope(resultCaseName || 'error', value);
        case 'readMcpResourceToolCall':
            if (resultCaseName === 'success') {
                const annotations = Object.fromEntries(
                    Object.entries(obj(value.annotations)).map(([key, v]) => [key, str(v)]),
                );
                const content = obj(value.content);
                const normalizedContent = typeof content.case === 'string'
                    ? content
                    : (typeof value.text === 'string'
                        ? { case: 'text', value: value.text }
                        : { case: 'blob', value: value.blob });
                return envelope('success', {
                    uri: str(value.uri, str(input.uri)),
                    ...(typeof value.name === 'string' ? { name: value.name } : {}),
                    ...(typeof value.description === 'string' ? { description: value.description } : {}),
                    ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
                    annotations,
                    ...(typeof value.downloadPath === 'string' ? { downloadPath: value.downloadPath } : {}),
                    content: normalizedContent,
                });
            }
            return envelope(resultCaseName || 'error', value);
        default:
            return null;
    }
}

export function buildMcpToolResultText(
    cursorToolType: string,
    resultCaseName: string,
    value: Record<string, unknown>,
): string | null {
    switch (cursorToolType) {
        case 'mcpToolCall':
            if (resultCaseName === 'success') {
                const items = arr<Record<string, unknown>>(value.content);
                const lines = items.map(item => {
                    const content = obj(item.content);
                    if (content.case === 'text') return str(obj(content.value).text);
                    if (content.case === 'image') return `[image ${str(obj(content.value).mimeType, 'unknown')}]`;
                    return JSON.stringify(item);
                }).filter(Boolean);
                if (lines.length > 0) return truncate(lines.join('\n\n'), 12000);
                if (value.structuredContent) return truncate(JSON.stringify(value.structuredContent, null, 2), 12000);
                return 'MCP tool completed successfully.';
            }
            return `MCP ${resultCaseName || 'error'}: ${JSON.stringify(value)}`;
        case 'listMcpResourcesToolCall':
            if (resultCaseName === 'success') {
                const resources = arr<Record<string, unknown>>(value.resources);
                return resources.length > 0
                    ? truncate(resources.map(resource => `${str(resource.server)} ${str(resource.uri)}${str(resource.name) ? ` — ${str(resource.name)}` : ''}`).join('\n'))
                    : 'No MCP resources available.';
            }
            return `List MCP resources ${resultCaseName || 'error'}: ${JSON.stringify(value)}`;
        case 'readMcpResourceToolCall':
            if (resultCaseName === 'success') {
                const content = obj(value.content);
                if (content.case === 'text') return truncate(str(content.value), 12000);
                if (content.case === 'blob') return `Read MCP resource ${str(value.uri)} (binary blob).`;
                return truncate(JSON.stringify(value), 12000);
            }
            return `Read MCP resource ${resultCaseName || 'error'}: ${JSON.stringify(value)}`;
        default:
            return null;
    }
}
