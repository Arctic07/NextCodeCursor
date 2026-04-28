/**
 * Always-Local Patch — http/https.request 拦截 + 签名绕过
 *
 * 从 patcher/src/always-local-patch.js 移植，与原版逻辑完全一致。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as acorn from 'acorn';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';
import { CCURSOR_DIR_NAME, ROUTES_FILE_NAME, DEFAULT_HOST, DEFAULT_PORT } from './defaults.js';

const MARKER = '__byokUrlRewrite';
const SIG_PATTERN = /if\(!\w\.valid\)/;

/**
 * 注入到 Cursor 进程的代码 — 完全无硬编码:
 *   - host/port/redirect 全部从 ~/.ccursor/routes.json 运行时读取
 *   - 文件不存在或损坏时使用内置 fallback (DEFAULT_HOST/PORT, 空白名单 → 不重定向)
 *   - fs.watchFile 2s 轮询热重载,改 routes.json 不需要重启 Cursor
 *
 * 注意此代码运行在 Cursor 的 always-local extension host 中,
 * 是裸 Node 环境(无 npm 依赖,只能用内置模块)。
 */
function buildPayload() {
  const FALLBACK_HOST = JSON.stringify(DEFAULT_HOST);
  const FALLBACK_PORT = String(DEFAULT_PORT);
  const CCURSOR_DIR = JSON.stringify(CCURSOR_DIR_NAME);
  const ROUTES_FILE = JSON.stringify(ROUTES_FILE_NAME);

  return `
/* BYOK-ALWAYS-LOCAL-START */
(function(){
  if(globalThis.${MARKER})return;
  globalThis.${MARKER}=true;
  var _http=require("http");
  var _https=require("https");
  var _url=require("url");
  var _fs=require("fs");
  var _path=require("path");
  var _os=require("os");
  var _origHttp=_http.request;
  var _origHttps=_https.request;

  var ROUTES_PATH=_path.join(_os.homedir(),${CCURSOR_DIR},${ROUTES_FILE});
  var FALLBACK_HOST=${FALLBACK_HOST};
  var FALLBACK_PORT=${FALLBACK_PORT};

  // 当前生效的路由配置(reload 时整体替换引用,避免半状态)
  var state={host:FALLBACK_HOST,port:FALLBACK_PORT,base:"http://"+FALLBACK_HOST+":"+FALLBACK_PORT,
    svcSet:new Set(),methodSet:new Set(),restSet:new Set(),ruleCount:0,restCount:0};

  function loadConfig(){
    try{
      var raw=_fs.readFileSync(ROUTES_PATH,"utf-8");
      var cfg=JSON.parse(raw);
      var host=(cfg&&cfg.server&&cfg.server.host)||FALLBACK_HOST;
      var port=(cfg&&cfg.server&&cfg.server.port)||FALLBACK_PORT;
      var rules=(cfg&&Array.isArray(cfg.redirect))?cfg.redirect:[];
      var svcSet=new Set();
      var methodSet=new Set();
      var restSet=new Set();
      var ruleCount=0,restCount=0;
      for(var i=0;i<rules.length;i++){
        var r=rules[i];
        if(typeof r!=="string")continue;
        if(r.indexOf("REST:")===0){restSet.add(r.slice(5));restCount++;}
        else if(r.indexOf("/")!==-1){methodSet.add(r);ruleCount++;}
        else{svcSet.add(r);ruleCount++;}
      }
      return{host:host,port:port,base:"http://"+host+":"+port,
        svcSet:svcSet,methodSet:methodSet,restSet:restSet,ruleCount:ruleCount,restCount:restCount};
    }catch(e){
      // 文件缺失或损坏 → 空白名单 fallback,所有 api2/api5 请求直通官方
      return{host:FALLBACK_HOST,port:FALLBACK_PORT,base:"http://"+FALLBACK_HOST+":"+FALLBACK_PORT,
        svcSet:new Set(),methodSet:new Set(),restSet:new Set(),ruleCount:0,restCount:0};
    }
  }

  function applyState(label){
    state=loadConfig();
    console.log("[BYOK] "+label+" → "+state.base+
      " (ConnectRPC="+state.ruleCount+", REST="+state.restCount+")");
  }

  applyState("routes loaded");

  // 监听 routes.json 变化,2s 轮询,对 tmp+rename 原子写入无感
  try{
    _fs.watchFile(ROUTES_PATH,{interval:2000,persistent:false},function(){
      applyState("routes reloaded");
    });
  }catch(e){console.warn("[BYOK] watchFile failed: "+e.message);}

  function isApiHost(h){
    return /api2\\.cursor\\.sh|[\\w.]*\\.?api5\\.cursor\\.sh/.test(h);
  }

  function shouldRedirect(pathname){
    if(!pathname||pathname.length<2)return false;
    var p=pathname.charAt(0)==="/"?pathname.slice(1):pathname;
    if(state.restSet.has(pathname))return true;
    var slash=p.indexOf("/");
    if(slash===-1)return false;
    if(state.methodSet.has(p))return true;
    var svc=p.slice(0,slash);
    if(state.svcSet.has(svc))return true;
    return false;
  }

  function parseUrl(u){
    if(typeof u==="string"){try{var o=new _url.URL(u);return{hostname:o.hostname,pathname:o.pathname,raw:u,isStr:true}}catch(e){return null}}
    if(u&&typeof u==="object")return{hostname:u.hostname||"",pathname:u.path||u.pathname||"",raw:u,isStr:false};
    return null;
  }

  function rewriteStr(u){
    return u.replace(/https?:\\/\\/[^/]+/,state.base);
  }

  function rewriteOpts(u){
    return Object.assign({},u,{hostname:state.host,port:state.port,protocol:"http:"});
  }

  function intercept(origHttp,origHttps,isHttps){
    return function(u,o,cb){
      var parsed=parseUrl(u);
      if(parsed&&isApiHost(parsed.hostname)){
        if(shouldRedirect(parsed.pathname)){
          if(parsed.isStr) return _origHttp.call(_http,rewriteStr(parsed.raw),o,cb);
          return _origHttp.call(_http,rewriteOpts(parsed.raw),o,cb);
        }
      }
      if(isHttps) return origHttps.call(_https,u,o,cb);
      return origHttp.call(_http,u,o,cb);
    };
  }

  _http.request=intercept(_origHttp,_origHttps,false);
  _https.request=intercept(_origHttp,_origHttps,true);

  console.log("[BYOK] Whitelist router active (config: "+ROUTES_PATH+")");
})();
/* BYOK-ALWAYS-LOCAL-END */
`.trim() + '\n';
}

export function patchAlwaysLocal(paths, log) {
  log?.('[always-local] Patching...');

  if (!existsSync(paths.alwaysLocalMain)) throw new Error(`Not found: ${paths.alwaysLocalMain}`);
  if (!existsSync(paths.extensionHostJs)) throw new Error(`Not found: ${paths.extensionHostJs}`);

  // 1. cursor-always-local/dist/main.js
  const alCode = readFileSync(paths.alwaysLocalMain, 'utf-8');
  if (alCode.includes(MARKER)) {
    log?.('  cursor-always-local already patched');
  } else {
    createBackup(paths.alwaysLocalMain, 'always-local', log);
    writeFileSync(paths.alwaysLocalMain, buildPayload() + alCode);
    log?.('  cursor-always-local patched');
  }

  // 2. extensionHostProcess.js — 签名绕过
  const ehCode = readFileSync(paths.extensionHostJs, 'utf-8');
  const ehPatched = ehCode.includes('if(!1)') && !SIG_PATTERN.test(ehCode);

  if (ehPatched) {
    log?.('  extensionHostProcess sig bypass already applied');
  } else {
    const match = ehCode.match(SIG_PATTERN);
    if (!match) throw new Error('Signature validation pattern not found');
    createBackup(paths.extensionHostJs, 'always-local', log);
    writeFileSync(paths.extensionHostJs, ehCode.replace(SIG_PATTERN, 'if(!1)'));
    log?.(`  Sig bypass: ${match[0]} → if(!1)`);
  }

  // 3. cursor-always-local/dist/main.js — 在 activate 函数体开头注入 BYOK server 就绪等待
  //    cursor2plus 和 cursor-always-local 在不同 extension host 中运行，
  //    无法用 extensionDependencies 做跨 host 依赖排序。
  //    改为在 activate 函数启动前轮询 BYOK server /health 端点，
  //    确保 server 就绪后再执行原始逻辑。
  const currentCode = readFileSync(paths.alwaysLocalMain, 'utf-8');
  const WAIT_MARKER = '__byokWaitServer';
  if (currentCode.includes(WAIT_MARKER)) {
    log?.('  activate wait-for-server already injected');
  } else {
    const insertPos = findActivateInsertPosition(currentCode, log);
    if (insertPos !== null) {
      const waitSnippet = buildWaitSnippet();
      // 1. function → async function
      let patched = currentCode.slice(0, insertPos.funcKeyword) + 'async ' + currentCode.slice(insertPos.funcKeyword);
      // 2. 重新计算 bodyStart（async 前缀增加了 6 个字符）
      const adjustedBodyStart = insertPos.bodyStart + 6;
      patched = patched.slice(0, adjustedBodyStart) + waitSnippet + patched.slice(adjustedBodyStart);
      writeFileSync(paths.alwaysLocalMain, patched);
      log?.('  activate: function → async function');
      log?.('  activate: wait-for-server injected');
    } else {
      log?.('  WARNING: activate function not found, skipping wait injection');
    }
  }

  // 4. Checksums
  const modified = [];
  if (!alCode.includes(MARKER)) modified.push(paths.alwaysLocalMain);
  modified.push(paths.extensionHostJs);
  // activate wait 也修改了 alwaysLocalMain，但 backup 已在步骤 1 创建
  if (modified.length > 0) {
    updateChecksums(paths, modified, 'always-local', log);
  }

  log?.('[always-local] Done');
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
function buildWaitSnippet() {
  const fallbackHost = JSON.stringify(DEFAULT_HOST);
  const fallbackPort = String(DEFAULT_PORT);
  const ccursorDir = JSON.stringify(CCURSOR_DIR_NAME);
  const routesFile = JSON.stringify(ROUTES_FILE_NAME);
  return `await(async()=>{if(globalThis.__byokWaitServer)return;globalThis.__byokWaitServer=true;` +
    `const _h=require("http");const _fs=require("fs");const _p=require("path");const _o=require("os");` +
    `let _host=${fallbackHost},_port=${fallbackPort};` +
    `try{const _c=JSON.parse(_fs.readFileSync(_p.join(_o.homedir(),${ccursorDir},${routesFile}),"utf-8"));` +
    `if(_c&&_c.server){_host=_c.server.host||_host;_port=_c.server.port||_port;}}catch{}` +
    `for(let _i=0;_i<60;_i++){` +
    `try{await new Promise((ok,no)=>{` +
    `const r=_h.get("http://"+_host+":"+_port+"/health",res=>{res.statusCode===200?ok():no()});` +
    `r.on("error",no);r.setTimeout(500,()=>{r.destroy();no()})});` +
    `console.log("[BYOK] Server ready, proceeding with always-local activate");return}catch{}` +
    `await new Promise(r=>setTimeout(r,500))}` +
    `console.warn("[BYOK] Server not ready after 30s, proceeding anyway")})();`;
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
 * 返回 { bodyStart, funcKeyword } 或 null。
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
    return { bodyStart, funcKeyword };
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
    log?.(`  Export object found: activate => ${activateFuncName}`);
    break;
  }

  if (!activateFuncName) return null;

  // 2. 找到 function <activateFuncName>( 的定义位置，用 AST 验证
  const funcNeedle = 'function ' + activateFuncName;
  let fIdx = source.indexOf(funcNeedle);
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
    const snippet = source.substring(fIdx, bodyStart) + '}';
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

    log?.(`  AST match (exported): function ${activateFuncName} at ${fIdx}, body at ${bodyStart}`);
    return { bodyStart, funcKeyword: fIdx };
  }

  log?.(`  Export found activate => ${activateFuncName}, but function definition not found`);
  return null;
}

/**
 * 干跑检测 — 验证 activate 注入是否能在当前 main.js 中定位
 */
export function checkActivateInjection(paths, log) {
  log?.('[check] Verifying activate injection target...');

  if (!existsSync(paths.alwaysLocalMain)) {
    log?.('  cursor-always-local main.js not found');
    return false;
  }

  const source = readFileSync(paths.alwaysLocalMain, 'utf-8');
  const WAIT_MARKER = '__byokWaitServer';

  if (source.includes(WAIT_MARKER)) {
    log?.('  Already injected');
    return true;
  }

  const pos = findActivateInsertPosition(source, log);
  if (pos !== null) {
    const context = source.substring(Math.max(0, pos.funcKeyword - 10), pos.bodyStart + 40);
    log?.(`  Context: ...${context}...`);
    log?.('  [OK] activate injection target found');
    return true;
  }

  log?.('  [FAIL] activate function not found');
  return false;
}
