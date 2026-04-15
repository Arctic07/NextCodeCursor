#!/usr/bin/env node
/**
 * 从提取的 JSON 文件生成 toolkit/definitions/ 下的逐工具文件。
 *
 * 用法: node scripts/gen-tool-defs.mjs
 *
 * 生成的文件只包含 llmToolByProvider 部分（description + inputSchema）。
 * buildStartedArgs / buildExecArgs 逻辑需要手动从旧文件迁入。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ANALYSIS = join(ROOT, '..', 'analysis', 'prompts', 'tools');
const OUT_DIR = join(ROOT, 'src', 'server', 'handlers', 'agent', 'toolkit', 'definitions');

// ── 加载三家 JSON ──
const anthropic = JSON.parse(readFileSync(join(ANALYSIS, 'cursor-agent-tools-anthropic.json'), 'utf8'));
const openaiRaw = JSON.parse(readFileSync(join(ANALYSIS, 'gpt-5.4-xhigh-fast-agent-tools-openai-format.json'), 'utf8'));
const gemini = JSON.parse(readFileSync(join(ANALYSIS, 'gemini-3.1-pro-agent-tools-1776011055514.json'), 'utf8'));

// Normalize OpenAI format
const openai = openaiRaw
    .filter(t => t.function && t.function.name !== 'ApplyPatch' && t.function.name !== 'parallel')
    .map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));

// ── 工具元数据映射 ──
// canonicalName → { cursorToolType, execArgsType, aliases, openaiName, geminiName }
const TOOL_META = {
    Shell:            { cursor: 'shellToolCall',          exec: 'shellStreamArgs',         aliases: ['Shell'],              oi: 'Shell',     gm: 'Shell' },
    Glob:             { cursor: 'globToolCall',           exec: 'grepArgs',                aliases: ['Glob'],               oi: 'Glob',      gm: 'Glob' },
    Grep:             { cursor: 'grepToolCall',           exec: 'grepArgs',                aliases: ['Grep', 'rg'],         oi: 'rg',        gm: 'Grep' },
    Await:            { cursor: 'awaitToolCall',          exec: null,                      aliases: ['Await'],              oi: 'Await',     gm: 'Await' },
    Read:             { cursor: 'readToolCall',           exec: 'readArgs',                aliases: ['Read', 'ReadFile'],   oi: 'ReadFile',  gm: 'Read' },
    Delete:           { cursor: 'deleteToolCall',         exec: 'deleteArgs',              aliases: ['Delete'],             oi: 'Delete',    gm: 'Delete' },
    StrReplace:       { cursor: 'editToolCall',           exec: 'writeArgs',               aliases: ['StrReplace'],         oi: 'StrReplace',gm: 'StrReplace' },
    Write:            { cursor: 'editToolCall',           exec: 'writeArgs',               aliases: ['Write'],              oi: 'Write',     gm: 'Write' },
    EditNotebook:     { cursor: 'editNotebookToolCall',   exec: null,                      aliases: ['EditNotebook'],       oi: 'EditNotebook', gm: null },
    TodoWrite:        { cursor: 'updateTodosToolCall',    exec: null,                      aliases: ['TodoWrite'],          oi: 'TodoWrite', gm: 'TodoWrite' },
    ReadLints:        { cursor: 'readLintsToolCall',      exec: 'diagnosticsArgs',         aliases: ['ReadLints'],          oi: 'ReadLints', gm: 'ReadLints' },
    WebSearch:        { cursor: 'webSearchToolCall',      exec: null,                      aliases: ['WebSearch'],          oi: 'WebSearch', gm: 'WebSearch' },
    WebFetch:         { cursor: 'webFetchToolCall',       exec: null,                      aliases: ['WebFetch'],           oi: 'WebFetch',  gm: 'WebFetch' },
    GenerateImage:    { cursor: 'generateImageToolCall',  exec: null,                      aliases: ['GenerateImage'],      oi: 'GenerateImage', gm: 'GenerateImage' },
    AskQuestion:      { cursor: 'askQuestionToolCall',    exec: null,                      aliases: ['AskQuestion'],        oi: 'AskQuestion', gm: 'AskQuestion' },
    Task:             { cursor: 'taskToolCall',           exec: 'subagentArgs',            aliases: ['Task', 'Subagent'],   oi: 'Subagent',  gm: 'Task' },
    ListMcpResources: { cursor: 'listMcpResourcesToolCall', exec: 'listMcpResourcesExecArgs', aliases: ['ListMcpResources'], oi: 'ListMcpResources', gm: 'ListMcpResources' },
    FetchMcpResource: { cursor: 'readMcpResourceToolCall', exec: 'readMcpResourceExecArgs', aliases: ['FetchMcpResource'],  oi: 'FetchMcpResource', gm: 'FetchMcpResource' },
    SwitchMode:       { cursor: 'switchModeToolCall',     exec: null,                      aliases: ['SwitchMode'],         oi: 'SwitchMode', gm: 'SwitchMode' },
};

// ── Gemini schema type 大写化 ──
function uppercaseTypes(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const out = { ...schema };
    if (typeof out.type === 'string') {
        out.type = out.type.toUpperCase();
    }
    if (out.properties) {
        out.properties = {};
        for (const [k, v] of Object.entries(schema.properties)) {
            out.properties[k] = uppercaseTypes(v);
        }
    }
    if (out.items) {
        out.items = uppercaseTypes(out.items);
    }
    return out;
}

// ── 转义 description 为 TS 模板字面量 ──
function escapeTemplateLiteral(s) {
    return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

// ── 生成单个工具文件 ──
function generateToolFile(canonicalName) {
    const meta = TOOL_META[canonicalName];
    if (!meta) throw new Error(`Unknown tool: ${canonicalName}`);

    // 查找三家的定义
    const aDef = anthropic.find(t => t.name === canonicalName);
    const oDef = openai.find(t => t.name === meta.oi);
    const gDef = gemini.find(t => t.name === (meta.gm || canonicalName));

    const lines = [];
    lines.push(`import type { ToolRegistryEntry } from '../types';`);
    lines.push(``);

    // ── Anthropic LLMTool ──
    if (aDef) {
        lines.push(`const ANTHROPIC = {`);
        lines.push(`    name: '${aDef.name}',`);
        lines.push(`    description: \`${escapeTemplateLiteral(aDef.description)}\`,`);
        lines.push(`    inputSchema: ${JSON.stringify(aDef.input_schema, null, 8).replace(/\n/g, '\n    ')},`);
        lines.push(`};`);
        lines.push(``);
    }

    // ── OpenAI LLMTool ──
    if (oDef) {
        lines.push(`const OPENAI = {`);
        lines.push(`    name: '${oDef.name}',`);
        lines.push(`    description: \`${escapeTemplateLiteral(oDef.description)}\`,`);
        lines.push(`    inputSchema: ${JSON.stringify(oDef.input_schema, null, 8).replace(/\n/g, '\n    ')},`);
        lines.push(`};`);
        lines.push(``);
    }

    // ── Gemini LLMTool ──
    if (gDef) {
        // Gemini SDK 要求 type 值大写 (OBJECT, STRING, NUMBER, ...)
        const geminiSchema = gDef.parameters || {};
        const isAlreadyUppercase = geminiSchema.type === 'OBJECT';
        const finalSchema = isAlreadyUppercase ? geminiSchema : uppercaseTypes(aDef ? aDef.input_schema : geminiSchema);

        lines.push(`const GEMINI = {`);
        lines.push(`    name: '${gDef.name}',`);
        lines.push(`    description: \`${escapeTemplateLiteral(gDef.description)}\`,`);
        lines.push(`    inputSchema: ${JSON.stringify(finalSchema, null, 8).replace(/\n/g, '\n    ')},`);
        lines.push(`};`);
        lines.push(``);
    }

    // ── ToolRegistryEntry ──
    lines.push(`export const ${canonicalName}Tool: ToolRegistryEntry = {`);
    lines.push(`    canonicalName: '${canonicalName}',`);
    lines.push(`    aliases: ${JSON.stringify(meta.aliases)},`);
    lines.push(`    cursorToolType: '${meta.cursor}',`);
    lines.push(`    execArgsType: ${meta.exec ? `'${meta.exec}'` : 'null'},`);
    lines.push(`    llmToolByProvider: {`);
    if (aDef) lines.push(`        anthropic: ANTHROPIC,`);
    if (oDef) lines.push(`        openai: OPENAI,`);
    if (gDef) lines.push(`        gemini: GEMINI,`);
    lines.push(`    },`);
    lines.push(`    // TODO: 从旧文件迁入 buildStartedArgs / buildExecArgs`);
    lines.push(`};`);
    lines.push(``);

    return lines.join('\n');
}

// ── 为 OpenAI 没有的工具（StrReplace, Write）生成 OpenAI 变体 ──
// 这些工具在 OpenAI JSON 中不存在（官方用 ApplyPatch），我们为 BYOK 提供同名工具
for (const name of ['StrReplace', 'Write']) {
    const aDef = anthropic.find(t => t.name === name);
    if (aDef && !openai.find(t => t.name === name)) {
        openai.push({ name, description: aDef.description, input_schema: aDef.input_schema });
    }
}

// ── 主流程 ──
const toolNames = Object.keys(TOOL_META);
console.log(`Generating ${toolNames.length} tool definition files...\n`);

for (const name of toolNames) {
    const content = generateToolFile(name);
    const filePath = join(OUT_DIR, `${name}.ts`);
    writeFileSync(filePath, content, 'utf8');
    console.log(`  ✓ ${name}.ts`);
}

console.log(`\nDone. Files written to ${OUT_DIR}`);
console.log(`\nNext steps:`);
console.log(`  1. Migrate buildStartedArgs/buildExecArgs from old files`);
console.log(`  2. Update registry.ts to import individual tool files`);
console.log(`  3. Delete old fileTools.ts, searchTools.ts, etc.`);
