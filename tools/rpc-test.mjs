#!/usr/bin/env node
/**
 * ConnectRPC 请求测试器
 *
 * 直接向 Cursor 官方 API (或任意 ConnectRPC server) 发请求,获取 JSON 响应。
 * 用于调研官方端点返回什么结构 (如 AvailableDocs / ServerTime / GetUsableModels 等)。
 *
 * 用法:
 *   node tools/rpc-test.mjs <method> [options]
 *
 * 示例:
 *   node tools/rpc-test.mjs aiserver.v1.AiService/AvailableDocs --body '{"getAll":true}'
 *   node tools/rpc-test.mjs aiserver.v1.AiService/ServerTime
 *   node tools/rpc-test.mjs agent.v1.AgentService/GetUsableModels
 *   node tools/rpc-test.mjs aiserver.v1.AiService/AvailableModels --host http://127.0.0.1:9960
 *
 * Options:
 *   --host <url>       目标 host (默认 https://api2.cursor.sh)
 *   --body <json>      请求体 JSON (默认 {})
 *   --headers <json>   额外 headers (JSON object)
 *   --verbose          打印请求详情
 *   --save <file>      保存响应到文件
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Auth (与 server/src/extract-agent-tools.ts 同源) ──

// TOKEN: 环境变量 CURSOR_AUTH_TOKEN 或直接粘贴 (格式: "Bearer eyJ...")
const TOKEN = process.env.CURSOR_AUTH_TOKEN || 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJnb29nbGUtb2F1dGgyfHVzZXJfMDFKVE02QTVCOEdHU0ZKS0o2MDUzVE44RDUiLCJ0aW1lIjoiMTc3NTg4NDgzNiIsInJhbmRvbW5lc3MiOiI4NmFjOWI5Zi1lN2EwLTRiOTMiLCJleHAiOjE3ODEwNjg4MzYsImlzcyI6Imh0dHBzOi8vYXV0aGVudGljYXRpb24uY3Vyc29yLnNoIiwic2NvcGUiOiJvcGVuaWQgcHJvZmlsZSBlbWFpbCBvZmZsaW5lX2FjY2VzcyIsImF1ZCI6Imh0dHBzOi8vY3Vyc29yLmNvbSIsInR5cGUiOiJzZXNzaW9uIn0.XQDevxFfHuNGrbQhchMDy8YogHSjNql71RGvVxmB59M';

function getMachineId() {
  const dbPath = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  try {
    return execSync(`sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key='storage.serviceMachineId'"`, { encoding: 'utf-8' }).trim();
  } catch { return null; }
}

function getChecksum() {
  const machineId = process.env.CURSOR_MACHINE_ID || getMachineId();
  if (!machineId) return undefined;
  const mid = createHash('sha256').update(machineId).digest('hex');
  const ts = Math.floor(Date.now() / 1e6);
  const ba = new Uint8Array([(ts >> 40) & 255, (ts >> 32) & 255, (ts >> 24) & 255, (ts >> 16) & 255, (ts >> 8) & 255, ts & 255]);
  let t = 165;
  for (let i = 0; i < ba.length; i++) { ba[i] = ((ba[i] ^ t) + (i % 256)) & 255; t = ba[i]; }
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let e = '';
  for (let i = 0; i < ba.length; i += 3) {
    const x = ba[i], y = i + 1 < ba.length ? ba[i + 1] : 0, z = i + 2 < ba.length ? ba[i + 2] : 0;
    e += a[x >> 2]; e += a[((x & 3) << 4) | (y >> 4)];
    if (i + 1 < ba.length) e += a[((y & 15) << 2) | (z >> 6)];
    if (i + 2 < ba.length) e += a[z & 63];
  }
  return e + mid;
}

// ── Config ──

const DEFAULT_HOST = 'https://api2.cursor.sh';

function parseArgs(argv) {
  const args = { method: null, host: DEFAULT_HOST, body: '{}', headers: {}, verbose: false, save: null };
  let i = 2;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--host') { args.host = argv[++i]; }
    else if (a === '--body') { args.body = argv[++i]; }
    else if (a === '--headers') { args.headers = JSON.parse(argv[++i]); }
    else if (a === '--verbose') { args.verbose = true; }
    else if (a === '--save') { args.save = argv[++i]; }
    else if (!a.startsWith('--') && !args.method) { args.method = a; }
    else { console.error(`Unknown option: ${a}`); process.exit(1); }
    i++;
  }
  return args;
}

function buildHeaders(host) {
  const h = {
    'Connect-Protocol-Version': '1',
    'Content-Type': 'application/json',
    'User-Agent': 'connect-es/2.0.0-rc.3',
    'x-cursor-client-version': '3.0.16',
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  // 打官方 API 时附带 auth + checksum;打本地 server 跳过
  if (host.includes('cursor.sh') || host.includes('cursor.com')) {
    if (!TOKEN.includes('<PASTE')) h['Authorization'] = TOKEN;
    const cs = getChecksum();
    if (cs) h['x-cursor-checksum'] = cs;
  }
  return h;
}

// ── RPC Call ──

async function callRpc(method, host, body, extraHeaders, verbose) {
  const url = `${host.replace(/\/$/, '')}/${method}`;
  const parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
  const headers = { ...buildHeaders(host), ...extraHeaders };

  if (verbose) {
    console.error('\x1b[36m── Request ──\x1b[0m');
    console.error(`  POST ${url}`);
    console.error(`  Headers: ${JSON.stringify(headers, null, 2)}`);
    console.error(`  Body: ${JSON.stringify(parsedBody, null, 2)}`);
    console.error('');
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(parsedBody) });
  const contentType = res.headers.get('content-type') ?? '';
  const status = res.status;

  if (verbose) {
    console.error('\x1b[36m── Response ──\x1b[0m');
    console.error(`  Status: ${status}`);
    console.error(`  Content-Type: ${contentType}`);
    const rh = {}; res.headers.forEach((v, k) => { rh[k] = v; });
    console.error(`  Headers: ${JSON.stringify(rh, null, 2)}`);
    console.error('');
  }

  if (contentType.includes('json')) {
    return { status, json: await res.json(), raw: null };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  try { return { status, json: JSON.parse(buf.toString('utf-8')), raw: null }; }
  catch { return { status, json: null, raw: buf }; }
}

function printResult({ status, json, raw }, save) {
  const c = status >= 200 && status < 300 ? '\x1b[32m' : '\x1b[31m';
  console.error(`${c}HTTP ${status}\x1b[0m`);

  if (json) {
    const fmt = JSON.stringify(json, null, 2);
    console.log(fmt);
    if (save) { writeFileSync(save, fmt + '\n'); console.error(`\x1b[33m→ Saved to ${save}\x1b[0m`); }
  } else if (raw) {
    console.error(`\x1b[33mBinary: ${raw.length} bytes\x1b[0m`);
    console.error(`  Hex: ${raw.subarray(0, 200).toString('hex')}`);
    if (save) { writeFileSync(save, raw); console.error(`\x1b[33m→ Saved to ${save}\x1b[0m`); }
  }
}

function printUsage() {
  console.log(`
\x1b[1mConnectRPC 请求测试器\x1b[0m

用法:
  node tools/rpc-test.mjs <package.Service/Method> [options]

常用端点:
  \x1b[36maiserver.v1.AiService/AvailableDocs\x1b[0m       --body '{"getAll":true}'
  \x1b[36maiserver.v1.AiService/ServerTime\x1b[0m           (无参数)
  \x1b[36maiserver.v1.AiService/AvailableModels\x1b[0m      (无参数)
  \x1b[36maiserver.v1.AiService/CppConfig\x1b[0m            (无参数)
  \x1b[36maiserver.v1.AiService/GetDefaultModel\x1b[0m      (无参数)
  \x1b[36magent.v1.AgentService/GetUsableModels\x1b[0m      (无参数)
  \x1b[36maiserver.v1.DashboardService/GetPlanInfo\x1b[0m   (无参数)

Options:
  --host <url>       目标 (默认 ${DEFAULT_HOST})
  --body <json>      请求体 (默认 {})
  --headers <json>   额外 headers
  --verbose          打印完整请求/响应
  --save <file>      保存到文件

Auth:
  TOKEN      → 编辑文件顶部 TOKEN 常量,或设 CURSOR_AUTH_TOKEN env
  MACHINE_ID → 自动从 state.vscdb 读取 (macOS),或设 CURSOR_MACHINE_ID env
`);
}

// ── Main ──

async function main() {
  const args = parseArgs(process.argv);

  if (!args.method) { printUsage(); process.exit(0); }

  if (args.host.includes('cursor.sh') && TOKEN.includes('<PASTE')) {
    console.error('\x1b[31m✗ 打官方 API 需要 token。编辑 rpc-test.mjs 顶部的 TOKEN 常量。\x1b[0m');
    process.exit(1);
  }

  try {
    const result = await callRpc(args.method, args.host, args.body, args.headers, args.verbose);
    printResult(result, args.save);
    process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
  } catch (err) {
    console.error(`\x1b[31m✗ ${err.message}\x1b[0m`);
    if (args.verbose) console.error(err.stack);
    process.exit(1);
  }
}

main();
