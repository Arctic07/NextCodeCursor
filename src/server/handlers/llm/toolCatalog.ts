import type { LLMTool } from './types';
import type { Provider } from '../../runtime-config';
import type { ProviderType } from '../../data/defaults';
import { getCursorAgentTools } from '../agent/cursorTools';

export interface CanonicalToolIntent {
    id: string;
    aliases: string[];
}

export interface ProviderToolCatalog {
    readonly provider: Provider;
    readonly variant: 'main' | 'fallback';
    readonly promptVocabulary: string[];
    readonly observedTranscriptTools: string[];
    listBuiltins(): LLMTool[];
    getCanonicalToolIntents(): CanonicalToolIntent[];
}

const OPENAI_OBSERVED = ['Shell', 'Glob', 'rg', 'AwaitShell', 'ReadFile', 'Delete', 'EditNotebook', 'TodoWrite', 'ReadLints', 'WebSearch', 'WebFetch', 'GenerateImage', 'AskQuestion', 'Subagent', 'ListMcpResources', 'FetchMcpResource', 'SwitchMode', 'ApplyPatch', 'Write'];
const OPENAI_VOCAB = ['Shell', 'ReadFile', 'ApplyPatch', 'Write', 'SwitchMode', 'CallMcpTool', 'ListMcpResources', 'FetchMcpResource', 'ReadLints'];

const OBSERVED_TRANSCRIPT_TOOLS: Record<Provider, string[]> = {
    'anthropic': ['Shell', 'Read', 'Edit', 'Write', 'Delete', 'Glob', 'Grep', 'ReadLints', 'WebSearch', 'WebFetch', 'AskQuestion', 'TodoWrite', 'Task', 'EditNotebook', 'GenerateImage', 'SwitchMode', 'AwaitShell', 'ListMcpResources', 'FetchMcpResource'],
    'openai-chat': OPENAI_OBSERVED,
    'openai-responses': OPENAI_OBSERVED,
    'gemini': ['Shell', 'Glob', 'Grep', 'AwaitShell', 'Read', 'Delete', 'Edit', 'Write', 'TodoWrite', 'ReadLints', 'WebSearch', 'WebFetch', 'GenerateImage', 'AskQuestion', 'Task', 'ListMcpResources', 'FetchMcpResource', 'SwitchMode'],
};

const PROMPT_VOCABULARY: Record<Provider, string[]> = {
    'anthropic': ['Shell', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'ReadLints', 'TodoWrite', 'Task', 'SwitchMode', 'ListMcpResources', 'FetchMcpResource'],
    'openai-chat': OPENAI_VOCAB,
    'openai-responses': OPENAI_VOCAB,
    'gemini': ['Shell', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'ReadLints', 'TodoWrite', 'Task', 'SwitchMode', 'ListMcpResources', 'FetchMcpResource'],
};

const CANONICAL_INTENTS: CanonicalToolIntent[] = [
    { id: 'read', aliases: ['Read', 'read_file', 'ReadFile'] },
    { id: 'edit', aliases: ['Edit', 'edit_file'] },
    { id: 'write', aliases: ['Write', 'write_file'] },
    { id: 'delete', aliases: ['Delete', 'delete_file'] },
    { id: 'glob', aliases: ['Glob', 'glob', 'file_search'] },
    { id: 'grep', aliases: ['Grep', 'grep', 'rg', 'grep_search'] },
    { id: 'read_lints', aliases: ['ReadLints', 'read_lints'] },
    { id: 'shell', aliases: ['Shell', 'shell', 'run_terminal_command'] },
    { id: 'web_search', aliases: ['WebSearch', 'web_search'] },
    { id: 'web_fetch', aliases: ['WebFetch', 'web_fetch'] },
    { id: 'ask_question', aliases: ['AskQuestion', 'ask_question'] },
    { id: 'todo_write', aliases: ['TodoWrite', 'update_todos', 'todo_write'] },
    { id: 'task', aliases: ['Task', 'task', 'Subagent'] },
    { id: 'mcp', aliases: ['CallMcpTool', 'mcp', 'call_mcp_tool'] },
    { id: 'list_mcp_resources', aliases: ['ListMcpResources', 'list_mcp_resources'] },
    { id: 'fetch_mcp_resource', aliases: ['FetchMcpResource', 'ReadMcpResource', 'fetch_mcp_resource', 'read_mcp_resource'] },
    { id: 'edit_notebook', aliases: ['EditNotebook', 'edit_notebook'] },
    { id: 'generate_image', aliases: ['GenerateImage', 'generate_image'] },
    { id: 'switch_mode', aliases: ['SwitchMode', 'switch_mode'] },
    { id: 'await', aliases: ['AwaitShell', 'Await', 'await'] },
];

class StaticProviderToolCatalog implements ProviderToolCatalog {
    constructor(
        readonly provider: Provider,
        readonly variant: 'main' | 'fallback',
        readonly promptVocabulary: string[],
        readonly observedTranscriptTools: string[],
        private readonly providerType: ProviderType,
    ) {}

    listBuiltins(): LLMTool[] {
        return getCursorAgentTools(this.providerType);
    }

    getCanonicalToolIntents(): CanonicalToolIntent[] {
        return CANONICAL_INTENTS;
    }
}

export function getProviderToolCatalog(provider: Provider, variant: 'main' | 'fallback' = 'main'): ProviderToolCatalog {
    // Provider (runtime-config) 和 ProviderType (defaults) 的值域一致
    const providerType = provider as ProviderType;
    return new StaticProviderToolCatalog(
        provider,
        variant,
        PROMPT_VOCABULARY[provider],
        OBSERVED_TRANSCRIPT_TOOLS[provider],
        providerType,
    );
}
