/**
 * Legacy Always-Local Patch — shared HTTP/1.1 router + readiness wait + signature bypass.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as acorn from 'acorn';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';
import { CCURSOR_DIR_NAME, ROUTES_FILE_NAME, DEFAULT_HOST, DEFAULT_PORT } from './defaults.js';
import { buildNodeHttp11RouterPayload, isNodeHttp11RouterPatched } from './node-http11-router.js';
import { disableAgentWebSocket, hasAgentWebSocketStack, isAgentWebSocketDisabled } from './agent-websocket-guard.js';

export const ALWAYS_LOCAL_ROUTER_MARKER = '__byokUrlRewrite';
export const WAIT_MARKER = '__byokWaitServer';
const SIG_PATTERN = /if\(!\w\.valid\)/;

/** Shared router payload for the legacy Agent process. */
function buildPayload() {
  return buildNodeHttp11RouterPayload({
    guardMarker: ALWAYS_LOCAL_ROUTER_MARKER,
    processLabel: 'always-local',
  });
}

export function patchAlwaysLocal(paths, log) {
  log?.('[always-local] Patching...');

  if (!existsSync(paths.alwaysLocalMain)) throw new Error(`Not found: ${paths.alwaysLocalMain}`);
  if (!existsSync(paths.extensionHostJs)) throw new Error(`Not found: ${paths.extensionHostJs}`);

  const modified = [];
  const original = readFileSync(paths.alwaysLocalMain, 'utf-8');
  let patched = original;

  // 1. Shared process-local router. Prepending V2 also safely upgrades older
  //    installations: it sets the historical guard before the old payload runs.
  if (!isNodeHttp11RouterPatched(patched, ALWAYS_LOCAL_ROUTER_MARKER)) {
    patched = buildPayload() + patched;
    log?.('  HTTP/1.1 whitelist router injected');
  }
  else {
    log?.('  HTTP/1.1 whitelist router already active');
  }

  // 2. Cursor 3.16+ embeds the same Agent WebSocket selector in the legacy
  //    bundle. It must be disabled too or false/auto topology can bypass HTTP.
  const websocket = disableAgentWebSocket(patched, 'cursor-always-local main.js');
  patched = websocket.source;
  if (websocket.required) {
    log?.('  Legacy Agent WebSocket bypass disabled');
  }

  // 3. Wait for the Cursor++ server before the legacy Agent transport starts.
  const waited = injectActivateWait(patched, 'always-local', log);
  if (!waited.ok) throw new Error('cursor-always-local activate function not found');
  patched = waited.source;

  if (patched !== original) {
    createBackup(paths.alwaysLocalMain, 'always-local', log);
    writeFileSync(paths.alwaysLocalMain, patched);
    modified.push(paths.alwaysLocalMain);
  }

  // 4. Built-in extension signature bypass.
  const ehCode = readFileSync(paths.extensionHostJs, 'utf-8');
  const ehPatched = ehCode.includes('if(!1)') && !SIG_PATTERN.test(ehCode);
  if (ehPatched) {
    log?.('  extensionHostProcess sig bypass already applied');
  }
  else {
    const match = ehCode.match(SIG_PATTERN);
    if (!match) throw new Error('Signature validation pattern not found');
    createBackup(paths.extensionHostJs, 'always-local', log);
    writeFileSync(paths.extensionHostJs, ehCode.replace(SIG_PATTERN, 'if(!1)'));
    modified.push(paths.extensionHostJs);
    log?.(`  Sig bypass: ${match[0]} → if(!1)`);
  }

  if (modified.length > 0) updateChecksums(paths, modified, 'always-local', log);
  log?.('[always-local] Done');
}

export function inspectAlwaysLocalPatch(paths) {
  if (!existsSync(paths.alwaysLocalMain)) {
    return { present: false, router: false, wait: false, fullyPatched: false };
  }
  const source = readFileSync(paths.alwaysLocalMain, 'utf-8');
  const router = isNodeHttp11RouterPatched(source, ALWAYS_LOCAL_ROUTER_MARKER);
  const wait = hasActivateWait(source);
  const websocketRequired = hasAgentWebSocketStack(source);
  const websocketDisabled = isAgentWebSocketDisabled(source, 'cursor-always-local main.js');
  return {
    present: true,
    router,
    wait,
    websocketRequired,
    websocketDisabled,
    fullyPatched: router && wait && websocketDisabled,
  };
}

export function checkAlwaysLocalPatch(paths, log) {
  log?.('[check] Verifying cursor-always-local HTTP/1.1 route target...');
  if (!existsSync(paths.alwaysLocalMain)) {
    log?.('  cursor-always-local main.js not found');
    return false;
  }

  try {
    let candidate = readFileSync(paths.alwaysLocalMain, 'utf-8');
    if (!isNodeHttp11RouterPatched(candidate, ALWAYS_LOCAL_ROUTER_MARKER)) candidate = buildPayload() + candidate;
    candidate = disableAgentWebSocket(candidate, 'cursor-always-local main.js').source;
    const waited = injectActivateWait(candidate, 'always-local', log);
    if (!waited.ok) throw new Error('activate function not found');
    candidate = waited.source;

    if (!isNodeHttp11RouterPatched(candidate, ALWAYS_LOCAL_ROUTER_MARKER)) throw new Error('router call-site verification failed');
    if (!hasActivateWait(candidate)) throw new Error('activate wait verification failed');
    if (!isAgentWebSocketDisabled(candidate, 'cursor-always-local main.js')) throw new Error('legacy WebSocket disable verification failed');
    log?.('  [OK] HTTP/1.1 router + activate wait + legacy WebSocket guard');
    return true;
  }
  catch (error) {
    log?.(`  [FAIL] ${error.message}`);
    return false;
  }
}

// ---- AST: 定位 activate 函数体插入点 ----

/**
 * 构建等待 BYOK server 就绪的代码片段。
 *
 * 注入到 cursor-always-local 的 activate 函数体开头。
 * 将 activate 从同步改为 async，轮询 /health 直到 server 响应。
 *
 * host/port 在 Cursor 进程内运行时从 ~/.ccursor/routes.json 读取，
 * 不存在或损坏时回退到 DEFAULT_HOST/PORT。整段代码无 npm 依赖。
 */
function buildWaitSnippet(processLabel) {
  const fallbackHost = JSON.stringify(DEFAULT_HOST);
  const fallbackPort = String(DEFAULT_PORT);
  const ccursorDir = JSON.stringify(CCURSOR_DIR_NAME);
  const routesFile = JSON.stringify(ROUTES_FILE_NAME);
  const label = JSON.stringify(processLabel);
  return `await(async()=>{if(globalThis.${WAIT_MARKER})return;globalThis.${WAIT_MARKER}=true;` +
    `const _label=${label};const _h=require("http");const _fs=require("fs");const _p=require("path");const _o=require("os");` +
    `let _host=${fallbackHost},_port=${fallbackPort};` +
    `try{const _c=JSON.parse(_fs.readFileSync(_p.join(_o.homedir(),${ccursorDir},${routesFile}),"utf-8"));` +
    `if(_c&&_c.server){_host=_c.server.host||_host;_port=_c.server.port||_port;}}catch{}` +
    `const _deadline=Date.now()+30000;while(Date.now()<_deadline){` +
    `try{await new Promise((ok,no)=>{` +
    `const r=_h.get("http://"+_host+":"+_port+"/health",res=>{res.resume();res.statusCode===200?ok():no()});` +
    `r.on("error",no);r.setTimeout(500,()=>{r.destroy();no()})});` +
    `console.log("[BYOK] Server ready, proceeding with "+_label+" activate");return}catch{}` +
    `await new Promise(r=>setTimeout(r,500))}` +
    `console.warn("[BYOK] Server not ready after 30s; "+_label+" will continue but routed requests remain local")})();`;
}

export function hasActivateWait(source) {
  return source.includes(`await(async()=>{if(globalThis.${WAIT_MARKER})`);
}

/** Inject the shared readiness wait into a sync or already-async activate. */
export function injectActivateWait(source, processLabel, log) {
  if (hasActivateWait(source)) {
    log?.('  activate wait-for-server already injected');
    return { source, changed: false, ok: true };
  }

  const position = findActivateInsertPosition(source, log);
  if (!position) return { source, changed: false, ok: false };

  const asyncPrefix = position.isAsync ? '' : 'async ';
  let patched = source.slice(0, position.funcKeyword) + asyncPrefix + source.slice(position.funcKeyword);
  const bodyStart = position.bodyStart + asyncPrefix.length;
  patched = patched.slice(0, bodyStart) + buildWaitSnippet(processLabel) + patched.slice(bodyStart);
  if (!position.isAsync) log?.('  activate: function → async function');
  log?.('  activate: wait-for-server injected');
  return { source: patched, changed: true, ok: true };
}

/**
 * AST 定位 cursor-always-local 的 activate 函数体开头。
 *
 * 匹配 AST 指纹（跨版本兼容，不依赖变量名或空格格式）：
 *   AssignmentExpression
 *     left: MemberExpression(object: Identifier, property: "activate")
 *     right: FunctionExpression
 *       body: BlockStatement ← 函数体 { 之后就是插入点
 *
 * 验证条件：
 *   1. 赋值右侧是 FunctionExpression（非箭头函数）
 *   2. 同一源码区域内存在 .deactivate= 赋值（确认是扩展主模块）
 *
 * 返回 { bodyStart, funcKeyword, isAsync } 或 null。
 */
function findActivateInsertPosition(source, log) {
  // 模式 A (3.1.17): .activate = function(n) { ... }
  const resultA = findActivateAssignment(source, log);
  if (resultA) return resultA;

  // 模式 B (3.2.11+): n.d(r, {activate: ()=>lkt}) + function lkt(n) { ... }
  const resultB = findActivateExportedFunction(source, log);
  if (resultB) return resultB;

  return null;
}

function findActivateAssignment(source, log) {
  const NEEDLE = 'activate';
  const LOOKBACK = 10;
  let searchFrom = 0;

  while (true) {
    const idx = source.indexOf(NEEDLE, searchFrom);
    if (idx < 0) break;
    searchFrom = idx + NEEDLE.length;

    if (idx > 0 && /[a-zA-Z_$]/.test(source[idx - 1])) continue;
    if (idx + NEEDLE.length < source.length && /[a-zA-Z0-9_$]/.test(source[idx + NEEDLE.length])) continue;

    const before = source.substring(Math.max(0, idx - LOOKBACK), idx).trimEnd();
    if (!before.endsWith('.')) continue;

    const dotPos = idx - 1 - (before.length - before.trimEnd().length);
    let lhsStart = dotPos;
    while (lhsStart > 0 && /[a-zA-Z0-9_$]/.test(source[lhsStart - 1])) lhsStart--;

    let i = idx + NEEDLE.length;
    while (i < source.length && /[\s=]/.test(source[i])) i++;

    const funcKeyword = i;
    const ahead = source.substring(i, i + 20);
    if (!ahead.startsWith('function') && !ahead.startsWith('async')) continue;

    while (i < source.length && source[i] !== '(') i++;
    if (i >= source.length) continue;

    let parenDepth = 0;
    for (; i < source.length; i++) {
      if (source[i] === '(') parenDepth++;
      if (source[i] === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
    }

    while (i < source.length && source[i] !== '{') i++;
    if (i >= source.length) continue;

    const bodyStart = i + 1;

    const snippet = source.substring(lhsStart, bodyStart) + '}';
    let ast;
    try {
      ast = acorn.parse(snippet, { ecmaVersion: 2022 });
    } catch {
      continue;
    }

    const stmt = ast.body[0];
    if (!stmt || stmt.type !== 'ExpressionStatement') continue;
    const expr = stmt.expression;
    if (!expr || expr.type !== 'AssignmentExpression') continue;
    if (!expr.left || expr.left.type !== 'MemberExpression') continue;
    const prop = expr.left.property;
    if (!prop || (prop.type === 'Identifier' && prop.name !== 'activate')) continue;
    if (!expr.right || expr.right.type !== 'FunctionExpression') continue;

    const VERIFY_RANGE = 5000;
    const nearbyRange = source.substring(Math.max(0, lhsStart - VERIFY_RANGE), Math.min(source.length, bodyStart + VERIFY_RANGE));
    if (!nearbyRange.includes('.deactivate') && !nearbyRange.includes('deactivate')) continue;

    log?.(`  AST match: .activate = FunctionExpression at ${lhsStart}, body at ${bodyStart}`);
    return { bodyStart, funcKeyword, isAsync: expr.right.async === true };
  }

  return null;
}

function findActivateExportedFunction(source, log) {
  // 3.2.11+ webpack exports 模式:
  //   n.d(r, {activate: ()=>lkt, deactivate: ()=>ukt})
  // 需要 AST 精确匹配: 找 ObjectExpression 中 activate 属性的 ArrowFunction 返回的标识符

  // 1. 扫描 "activate" 出现位置，提取包含它的对象字面量片段
  const NEEDLE = 'activate';
  let searchFrom = 0;
  let activateFuncName = null;
  let activateExportEnd = 0;

  while (true) {
    const idx = source.indexOf(NEEDLE, searchFrom);
    if (idx < 0) break;
    searchFrom = idx + NEEDLE.length;

    // 排除 deactivate 等
    if (idx > 0 && /[a-zA-Z_$]/.test(source[idx - 1])) continue;
    if (idx + NEEDLE.length < source.length && /[a-zA-Z0-9_$]/.test(source[idx + NEEDLE.length])) continue;

    // 向前找 { 起始
    let objStart = idx;
    while (objStart > 0 && source[objStart] !== '{') objStart--;
    if (source[objStart] !== '{') continue;

    // 向后找 } 结束
    let objEnd = idx;
    let braceDepth = 0;
    for (let k = objStart; k < source.length && k < objStart + 500; k++) {
      if (source[k] === '{') braceDepth++;
      if (source[k] === '}') { braceDepth--; if (braceDepth === 0) { objEnd = k + 1; break; } }
    }
    if (braceDepth !== 0) continue;

    // 用 acorn 解析对象字面量
    const objSnippet = '(' + source.substring(objStart, objEnd) + ')';
    let ast;
    try {
      ast = acorn.parse(objSnippet, { ecmaVersion: 2022 });
    } catch {
      continue;
    }

    const exprStmt = ast.body[0];
    if (!exprStmt || exprStmt.type !== 'ExpressionStatement') continue;
    const obj = exprStmt.expression;
    if (!obj || obj.type !== 'ObjectExpression') continue;

    // 找 activate 属性 + deactivate 属性（验证是扩展 exports）
    let activateProp = null;
    let hasDeactivate = false;
    for (const prop of obj.properties) {
      if (prop.type !== 'Property') continue;
      const key = prop.key;
      const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : null;
      if (name === 'activate') activateProp = prop;
      if (name === 'deactivate') hasDeactivate = true;
    }
    if (!activateProp || !hasDeactivate) continue;

    // activate 的值必须是 ArrowFunctionExpression，body 是 Identifier
    const arrow = activateProp.value;
    if (!arrow || arrow.type !== 'ArrowFunctionExpression') continue;
    if (!arrow.body || arrow.body.type !== 'Identifier') continue;

    activateFuncName = arrow.body.name;
    activateExportEnd = objEnd;
    log?.(`  Export object found: activate => ${activateFuncName}`);
    break;
  }

  if (!activateFuncName) return null;

  // 2. 找到 function <activateFuncName>( 的定义位置，用 AST 验证
  const funcNeedle = 'function ' + activateFuncName;
  // Webpack emits the export table at the start of a module and the exported
  // declaration later in that same module. Starting at the export object avoids
  // same-name helpers from earlier modules (common in the large Agent Host bundle).
  let fIdx = source.indexOf(funcNeedle, activateExportEnd);
  if (fIdx < 0) fIdx = source.lastIndexOf(funcNeedle, activateExportEnd);
  while (fIdx >= 0) {
    // 提取 function name(params){} 最小片段
    let i = fIdx + funcNeedle.length;
    while (i < source.length && source[i] !== '(') i++;
    if (i >= source.length) { fIdx = source.indexOf(funcNeedle, fIdx + 1); continue; }

    let parenDepth = 0;
    for (; i < source.length; i++) {
      if (source[i] === '(') parenDepth++;
      if (source[i] === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
    }
    while (i < source.length && source[i] !== '{') i++;
    if (i >= source.length) { fIdx = source.indexOf(funcNeedle, fIdx + 1); continue; }

    const bodyStart = i + 1;
    const beforeFunction = source.slice(Math.max(0, fIdx - 16), fIdx);
    const asyncMatch = beforeFunction.match(/async\s+$/);
    const funcKeyword = asyncMatch ? fIdx - asyncMatch[0].length : fIdx;
    const snippet = source.substring(funcKeyword, bodyStart) + '}';
    let ast;
    try {
      ast = acorn.parse(snippet, { ecmaVersion: 2022 });
    } catch {
      fIdx = source.indexOf(funcNeedle, fIdx + 1);
      continue;
    }

    const decl = ast.body[0];
    if (!decl || decl.type !== 'FunctionDeclaration') { fIdx = source.indexOf(funcNeedle, fIdx + 1); continue; }
    if (decl.id?.name !== activateFuncName) { fIdx = source.indexOf(funcNeedle, fIdx + 1); continue; }

    log?.(`  AST match (exported): ${decl.async ? 'async ' : ''}function ${activateFuncName} at ${funcKeyword}, body at ${bodyStart}`);
    return { bodyStart, funcKeyword, isAsync: decl.async === true };
  }

  log?.(`  Export found activate => ${activateFuncName}, but function definition not found`);
  return null;
}
