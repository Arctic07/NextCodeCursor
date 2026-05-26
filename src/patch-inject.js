/**
 * Renderer Hook Injection — AST-based
 *
 * 从 patcher/src/inject.js 移植，与原版逻辑完全一致。
 */
import { readFileSync, writeFileSync } from 'fs';
import * as acorn from 'acorn';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';
import { loadRoutes } from './routes.js';
import { BASE_REDIRECT } from './defaults.js';
import { DEFAULT_REDIRECT } from './defaults.js';

const HOOK_MARKER = '__byokWrapTransport';
const ANCHORS = [
  'bufbuild/connect/callback-client',
  'bufbuild/connect/promise-client',
];
const SCAN_WINDOW = 2000;

// ---- string scanning (与原版一致) ----

function skipString(source, i) {
  const quote = source[i];
  i++;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '"' || c === "'" || c === '`') { i = skipString(source, i); continue; }
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

function extractFunction(source, startOffset) {
  let i = startOffset;
  const len = source.length;
  while (i < len && source[i] !== '(') i++;
  if (i >= len) return null;
  let parenDepth = 0;
  while (i < len) {
    const ch = source[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
    else if (ch === '"' || ch === "'" || ch === '`') { i = skipString(source, i); continue; }
    i++;
  }
  while (i < len && source[i] !== '{') i++;
  if (i >= len) return null;
  let braceDepth = 0;
  while (i < len) {
    const ch = source[i];
    if (ch === '{') braceDepth++;
    else if (ch === '}') { braceDepth--; if (braceDepth === 0) return { start: startOffset, end: i + 1 }; }
    else if (ch === '"' || ch === "'" || ch === '`') { i = skipString(source, i); continue; }
    else if (ch === '/' && i + 1 < len) {
      if (source[i + 1] === '/') { while (i < len && source[i] !== '\n') i++; continue; }
      if (source[i + 1] === '*') { i += 2; while (i + 1 < len && !(source[i] === '*' && source[i + 1] === '/')) i++; i += 2; continue; }
    }
    i++;
  }
  return null;
}

function findFunctionStarts(source, from, windowSize) {
  const results = [];
  const end = Math.min(from + windowSize, source.length);
  let i = from;
  while (i < end) {
    const idx = source.indexOf('function ', i);
    if (idx === -1 || idx >= end) break;
    if (idx > 0 && /[\w$]/.test(source[idx - 1])) { i = idx + 9; continue; }
    results.push(idx);
    i = idx + 9;
  }
  return results;
}

// ---- hook payload ----
//
// 注入到 workbench renderer 的 IIFE,职责:
//   1. wrap ConnectRPC transport (__byokWrapTransport) — 观察 + 发往 collector
//   2. REST 端点重定向到本地 BYOK server
//   3. __byokRefreshModels —— 主动触发模型列表刷新 (借用 captureAiServiceRef
//      在 workbench.js 里泄漏到 globalThis 的 aiService 引用)
//   4. setInterval 轮询本地 server /byok/refresh-signal,counter 变化时调
//      __byokRefreshModels(),实现 toggle BYOK Mode 后自动刷新模型选择器

function buildHookPayload() {
  const routes = loadRoutes();
  const BYOK_HOST = routes.server.host;
  const BYOK_PORT = routes.server.port;
  const COLLECTOR_HOST = routes.collector.host;
  const COLLECTOR_PORT = routes.collector.port;
  // REST redirect 初始列表仅含 BASE_REDIRECT (stripe profile stub),
  // 保证 Cursor 启动时 /auth/poll 等登录关键端点不被拦截。
  // 完整 BYOK 列表由 server 就绪后通过 SSE event:routes 推送。
  const restRedirects = BASE_REDIRECT.filter(r => r.startsWith('REST:')).map(r => r.slice(5));
  const restListJson = JSON.stringify(restRedirects);

  // 主体: collector observation + transport wrap + REST 重定向
  // unary/stream 包装中, 在调原始 transport 之前向 headers 注入 x-client-wid,
  // 后续 server 端直接从请求头读取, 无需 clientKey 映射。
  const main = `(function(){if(globalThis.__byokReady)return;globalThis.__byokReady=true;var _q=globalThis.__byokQueue=[];var _collectorUrl="http://${COLLECTOR_HOST}:${COLLECTOR_PORT}";var _byokUrl="http://${BYOK_HOST}:${BYOK_PORT}";var _sending=false;var _down=false;var _restPaths=${restListJson};var _restSet=new Set(_restPaths);function __byokLog(e){if(_down)return;e._t=Date.now();_q.push(e);if(!_sending)_flush()}function _flush(){if(_down||!_q.length){_sending=false;return}_sending=true;var batch=_q.splice(0,50);fetch(_collectorUrl+"/hook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(batch)}).then(function(){}).catch(function(){_down=true;_q.length=0;console.warn("[BYOK] Collector not reachable at "+_collectorUrl+", logging disabled for this session")}).finally(function(){if(!_down)setTimeout(_flush,100);else _sending=false})}function __byokMsgToJson(e){if(!e)return null;try{if(typeof e.toJson==="function")return e.toJson()}catch(x){}try{if(typeof e.toJsonString==="function")return JSON.parse(e.toJsonString())}catch(x){}return e}function __byokHeadersToObj(e){if(!e)return{};try{if(e instanceof Headers)return Object.fromEntries(e)}catch(x){}return typeof e==="object"?e:{}}function __byokCloneBody(r){if(!r.body)return Promise.resolve(null);try{return r.clone().text()}catch(e){return Promise.resolve(null)}}function __byokInjectWid(hdrs){var wid=typeof window!=="undefined"&&window.vscodeWindowId;if(typeof wid!=="number")return hdrs;var widStr=String(wid);try{if(hdrs&&typeof hdrs.set==="function"){hdrs.set("x-client-wid",widStr);return hdrs}if(hdrs&&typeof hdrs==="object"&&!Array.isArray(hdrs)){hdrs["x-client-wid"]=widStr;return hdrs}if(Array.isArray(hdrs)){hdrs.push(["x-client-wid",widStr]);return hdrs}}catch(e){}var h=new Headers();h.set("x-client-wid",widStr);return h}globalThis.__byokWrapTransport=function(t,n){return{unary:async function(e,r,i,o,s,a,c){s=__byokInjectWid(s);var u=Math.random().toString(36).slice(2,10),l=Date.now();__byokLog({type:"unary_req",id:u,svc:e.typeName,mtd:r.name,hdr:__byokHeadersToObj(s),msg:__byokMsgToJson(a)});try{var d=await t.unary(e,r,i,o,s,a,c);__byokLog({type:"unary_res",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,msg:__byokMsgToJson(d.message)});return d}catch(d){__byokLog({type:"unary_err",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,err:d?.message||String(d),code:d?.code});throw d}},stream:async function(e,r,i,o,s,a,c){s=__byokInjectWid(s);var u=Math.random().toString(36).slice(2,10),l=Date.now();__byokLog({type:"stream_req",id:u,svc:e.typeName,mtd:r.name,hdr:__byokHeadersToObj(s)});var f=(async function*(){var t=0;for await(var n of a){__byokLog({type:"stream_in",id:u,svc:e.typeName,mtd:r.name,idx:t++,msg:__byokMsgToJson(n)});yield n}})();try{var d=await t.stream(e,r,i,o,s,f,c),h=d.message;d.message=(async function*(){var t=0;for await(var n of h){__byokLog({type:"stream_out",id:u,svc:e.typeName,mtd:r.name,idx:t++,msg:__byokMsgToJson(n)});yield n}__byokLog({type:"stream_end",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,chunks:t})})();return d}catch(d){__byokLog({type:"stream_err",id:u,dur:Date.now()-l,svc:e.typeName,mtd:r.name,err:d?.message||String(d),code:d?.code});throw d}}}};if(_restPaths.length>0){var _origFetch=globalThis.fetch;globalThis.fetch=function(){var args=Array.prototype.slice.call(arguments);var urlArg=args[0];var u=typeof urlArg==="string"?urlArg:(urlArg instanceof Request?urlArg.url:"");var init=args[1]||{};for(var i=0;i<_restPaths.length;i++){if(u.indexOf(_restPaths[i])!==-1){var id=Math.random().toString(36).slice(2,10);var ts=Date.now();var reqMethod=init.method||(urlArg instanceof Request?urlArg.method:"GET")||"GET";var reqHeaders=__byokHeadersToObj(urlArg instanceof Request?urlArg.headers:init.headers);var reqBody=urlArg instanceof Request&&urlArg.body?urlArg.body:(init.body||null);var path=_restPaths[i];var newUrl=_byokUrl+(u.match(/^https?:\\/\\/[^/]*/)?u.replace(/^https?:\\/\\/[^/]*/,""):"/");__byokLog({type:"rest_redirect",id:id,path:path,originalUrl:u,redirectUrl:newUrl,method:reqMethod,reqHeaders:reqHeaders,reqBody:reqBody});var newInit=Object.assign({},init);newInit.headers=__byokInjectWid(newInit.headers);var newArgs=[newUrl,newInit];for(var j=2;j<args.length;j++)newArgs.push(args[j]);return _origFetch.apply(globalThis,newArgs).then(function(resp){var r=resp.clone();__byokLog({type:"rest_response",id:id,path:path,status:r.status,resHeaders:__byokHeadersToObj(r.headers)});__byokCloneBody(r).then(function(text){if(text){__byokLog({type:"rest_body",id:id,path:path,body:text})}}).catch(function(){});return resp}).catch(function(err){__byokLog({type:"rest_error",id:id,path:path,error:err?.message||String(err)});throw err})}}if(u.indexOf(_byokUrl)===0){var nInit=Object.assign({},init);nInit.headers=__byokInjectWid(nInit.headers);var nArgs=[urlArg,nInit];for(var k=2;k<args.length;k++)nArgs.push(args[k]);return _origFetch.apply(globalThis,nArgs)}return _origFetch.apply(globalThis,arguments)}}`;

  // 模型列表刷新机制
  // __byokAiSvc 由 captureAiServiceRef 在 workbench.js 字符串重写时泄漏到 globalThis,
  // 启动期 chat panel 挂载/登录监听首次执行 refreshDefaultModels 时即赋值。
  // 兜底: aiService 引用未捕获时尝试 DOM 点击 [title="Refresh model list"] 按钮。
  //
  // 通知通道: EventSource 订阅 /byok/events, server 在 bumpRefreshSignal 时推送 "event: refresh",
  // 替代了早期的 3s 轮询 /byok/refresh-signal 方案。EventSource 会自动重连。
  // Model Picker "Refresh Models" 按钮注入
  //
  // 监听 .ui-model-picker__menu 出现 → 在 "Add Models" 同级位置注入 "Refresh Models" 选项。
  // 使用 ui-model-picker__user-action-item 类复用原生样式。
  // 点击触发 __byokRefreshModels() 刷新模型列表。
  // Editor Window / Agent Window 均生效。
  // 在模型选择器搜索框右侧注入 Refresh 按钮。
  // 搜索框结构: div.ui-palette-input-wrapper[cmdk-input-wrapper] > icon + input
  // 在 wrapper 末尾追加 button，flex 布局自动排右。
  // 使用 __icon-button 原生样式 (16px, transparent bg, cursor:pointer)。
  const pickerRefresh = `(function(){if(!document.body)return;var _prObs=new MutationObserver(function(){var inp=document.querySelector('input[placeholder="Search models"]');if(!inp)return;var wrap=inp.closest(".ui-input-group");if(!wrap||wrap.querySelector("#byok-refresh-btn"))return;var btn=document.createElement("button");btn.type="button";btn.id="byok-refresh-btn";btn.className="ui-icon-button";btn.dataset.variant="default";btn.dataset.size="sm";btn.setAttribute("aria-label","Refresh Models");btn.style.cssText="margin-right:4px;font-size:15px;flex-shrink:0;";btn.textContent="\\u21BB";btn.addEventListener("click",function(ev){ev.stopPropagation();globalThis.__byokRefreshModels&&globalThis.__byokRefreshModels();console.log("[BYOK] manual refresh from picker")});wrap.appendChild(btn)});_prObs.observe(document.body,{childList:true,subtree:true})})();`;

  // Glass sidebar BYOK 状态指示器
  //
  // Agent Window (glass mode) 没有 VS Code 状态栏。
  // 在左侧边栏底部 account bar 中注入 BYOK 状态指示器:
  //   glass-sidebar-footer-bar
  //     ├─ account trigger (头像+名字)
  //     ├─ #byok-glass-status          ← 注入点
  //     └─ glass-sidebar-footer-actions-right (filter+settings)
  //
  // 通过 MutationObserver 等待 glass sidebar footer 渲染后注入。
  // 指示器颜色跟随 EventSource 连接状态:
  //   connected → 绿点   disconnected → 灰点
  const glassStatus = `(function(){var _bEl=null,_bTip=null,_bSrv=false,_bMode=false;function _bCreate(){var e=document.createElement("button");e.type="button";e.className="ui-icon-button";e.dataset.variant="default";e.dataset.size="lg";e.id="byok-glass-status";e.style.cssText="font-size:11px;gap:3px;width:auto;white-space:nowrap;";e.addEventListener("click",function(){fetch(_byokUrl+"/byok/toggle",{method:"POST"}).then(function(r){return r.json()}).then(function(d){console.log("[BYOK] toggle \\u2192",d.byokMode?"ON":"OFF")}).catch(function(e){console.warn("[BYOK] toggle failed:",e&&e.message||e)})});e.addEventListener("mouseenter",function(){_bShowTip()});e.addEventListener("mouseleave",function(){_bHideTip()});return e}function _bShowTip(){if(_bTip||!_bEl)return;var t=document.createElement("div");t.className="ui-tooltip";t.setAttribute("role","tooltip");t.style.cssText="position:fixed;z-index:99999;pointer-events:none;";var c=document.createElement("div");c.className="ui-tooltip-content";var b=document.createElement("div");b.className="ui-tooltip-body";var tr=document.createElement("div");tr.className="ui-tooltip-title-row";tr.textContent=(_bSrv?"Server online":"Server offline")+" \\u00B7 "+(_bMode?"BYOK ON":"BYOK OFF");b.appendChild(tr);c.appendChild(b);t.appendChild(c);document.body.appendChild(t);var r=_bEl.getBoundingClientRect();var tw=t.offsetWidth,th=t.offsetHeight;t.style.left=Math.round(r.left+r.width/2-tw/2)+"px";t.style.top=Math.round(r.top-th-6)+"px";_bTip=t}function _bHideTip(){if(_bTip){_bTip.remove();_bTip=null}}function _bRender(){if(!_bEl)return;var icon=_bSrv?"\\u2713":"\\u2717";var glyph=_bMode?"\\u25C9":"\\u25CB";_bEl.textContent=icon+" BYOK "+glyph}function _bInject(){if(_bEl&&document.contains(_bEl))return;var act=document.querySelector(".glass-sidebar-footer-actions-right");if(!act)return;_bEl=_bCreate();_bRender();act.insertBefore(_bEl,act.firstChild)}if(document.body){var _bObs=new MutationObserver(function(){_bInject()});_bObs.observe(document.body,{childList:true,subtree:true});_bInject()}globalThis.__byokGlassStatus=function(srv,mode){if(srv!==void 0)_bSrv=srv;if(mode!==void 0)_bMode=mode;_bRender()}})();`;

  const refreshLogic = `globalThis.__byokRefreshModels=function(){if(globalThis.__byokAiSvc&&typeof globalThis.__byokAiSvc.refreshDefaultModels==="function"){try{var p=globalThis.__byokAiSvc.refreshDefaultModels();console.log("[BYOK] refreshDefaultModels() invoked via captured aiService ref");if(p&&typeof p.then==="function")p.catch(function(e){console.warn("[BYOK] refreshDefaultModels failed:",e&&e.message||e)});return"service"}catch(e){console.warn("[BYOK] refreshDefaultModels threw:",e&&e.message||e)}}var btn=document.querySelector('[title="Refresh model list"]');if(btn&&typeof btn.click==="function"){btn.click();console.log("[BYOK] refresh triggered via DOM click fallback");return"click"}console.warn("[BYOK] no refresh mechanism available (aiService not captured, picker not visible)");return"none"};try{var _byokEs=new EventSource(_byokUrl+"/byok/events");_byokEs.addEventListener("open",function(){globalThis.__byokGlassStatus&&globalThis.__byokGlassStatus(true,_restPaths.length>2)});_byokEs.addEventListener("refresh",function(){console.log("[BYOK] refresh event received");globalThis.__byokRefreshModels&&globalThis.__byokRefreshModels()});_byokEs.addEventListener("routes",function(ev){try{var newPaths=JSON.parse(ev.data);_restPaths=newPaths;_restSet=new Set(newPaths);console.log("[BYOK] REST redirects hot-reloaded: "+newPaths.length+" paths");globalThis.__byokGlassStatus&&globalThis.__byokGlassStatus(void 0,newPaths.length>2)}catch(e){console.warn("[BYOK] routes event parse failed:",e&&e.message||e)}});_byokEs.addEventListener("error",function(){globalThis.__byokGlassStatus&&globalThis.__byokGlassStatus(false,void 0)})}catch(e){console.warn("[BYOK] EventSource init failed:",e&&e.message||e)}`;

  return main + refreshLogic + pickerRefresh + glassStatus + `console.log("[BYOK] Hook loaded, collector="+_collectorUrl+", byok="+_byokUrl+", REST redirects="+_restPaths.length)})()`;
}

// ---- AST fingerprinting + patch ----

function findTarget(code, log) {
  let anchorOffset = -1;
  for (const anchor of ANCHORS) {
    const idx = code.indexOf(anchor);
    if (idx !== -1) { anchorOffset = idx; log?.(`  Anchor: "${anchor}" at ${idx}`); break; }
  }
  if (anchorOffset === -1) throw new Error('ConnectRPC client module anchor not found');

  const funcStarts = findFunctionStarts(code, anchorOffset, SCAN_WINDOW);
  let dispatcherName = null, dispatcherBounds = null;

  for (const fStart of funcStarts) {
    const bounds = extractFunction(code, fStart);
    if (!bounds) continue;
    const body = code.slice(bounds.start, bounds.end);
    if (body.includes('.Unary') && body.includes('.ServerStreaming') && body.includes('.BiDiStreaming')) {
      let ast;
      try { ast = acorn.parse(body, { ecmaVersion: 2022, sourceType: 'script' }); } catch { continue; }
      const decl = ast.body[0];
      if (decl?.type === 'FunctionDeclaration' && decl.id?.name) {
        dispatcherName = decl.id.name;
        dispatcherBounds = bounds;
        log?.(`  Dispatcher: ${dispatcherName}`);
        break;
      }
    }
  }
  if (!dispatcherName) throw new Error('Dispatcher function not found');

  const postStarts = findFunctionStarts(code, dispatcherBounds.end, SCAN_WINDOW);
  for (const fStart of postStarts) {
    const bounds = extractFunction(code, fStart);
    if (!bounds) continue;
    const body = code.slice(bounds.start, bounds.end);
    if (!body.includes(dispatcherName)) continue;
    let ast;
    try { ast = acorn.parse(body, { ecmaVersion: 2022, sourceType: 'script' }); } catch { continue; }
    const decl = ast.body[0];
    if (!decl || decl.type !== 'FunctionDeclaration') continue;
    if (decl.params?.length !== 2) continue;
    if (decl.params.some(p => p.type !== 'Identifier')) continue;
    const p0 = decl.params[0].name, p1 = decl.params[1].name;
    const stmts = decl.body?.body;
    if (!stmts || stmts.length !== 1 || stmts[0].type !== 'ReturnStatement') continue;
    const ret = stmts[0].argument;
    if (!ret || ret.type !== 'CallExpression') continue;
    if (ret.callee?.type !== 'Identifier' || ret.callee.name !== dispatcherName) continue;
    if (ret.arguments?.length !== 2) continue;
    if (ret.arguments[0].name !== p0 || ret.arguments[1].name !== p1) continue;

    return { name: decl.id.name, bounds, source: body, paramService: p0, paramTransport: p1, innerFn: dispatcherName };
  }
  throw new Error(`No delegate wrapper found for "${dispatcherName}"`);
}

/**
 * 通过 AST 校验 + 字符串替换, 把所有 `X.aiService.refreshDefaultModels(` 调用点
 * 改写为 `(globalThis.__byokAiSvc=X.aiService).refreshDefaultModels(`
 *
 * 目的: Cursor 启动后 (chat panel 挂载、登录监听器触发等) 任意一次该方法被调用时,
 *       aiService 实例引用就被泄漏到 globalThis.__byokAiSvc 上。之后扩展端
 *       通过信号机制让 renderer hook 直接 globalThis.__byokAiSvc.refreshDefaultModels()
 *       即可主动刷新模型列表, 无需 DOM 点击 / 无需用户操作。
 *
 * 跨版本稳定性:
 *   - 不依赖任何混淆变量名
 *   - 仅依赖 protobuf 属性名 `aiService` 和 `refreshDefaultModels` (与 .proto 同步, 极稳定)
 *   - 每个候选位置用 acorn parseExpressionAt 单独验证 AST 形态
 *   - 接受形态: `Identifier.aiService.refreshDefaultModels(...)` 或 `this.aiService.refreshDefaultModels(...)`
 *   - 拒绝形态: 嵌套 MemberExpression (e.g. `obj.foo.aiService.refreshDefaultModels()`) 或位于 string/comment 中的字面文本
 */
function captureAiServiceRef(code, log) {
  const NEEDLE = '.aiService.refreshDefaultModels(';
  const replacements = [];
  let scanFrom = 0;
  let candidateCount = 0;

  while (true) {
    const dotIdx = code.indexOf(NEEDLE, scanFrom);
    if (dotIdx === -1) break;
    candidateCount++;
    scanFrom = dotIdx + NEEDLE.length;

    // 向前提取 X identifier 或 'this' 起点
    let i = dotIdx - 1;
    while (i >= 0 && /[a-zA-Z0-9_$]/.test(code[i])) i--;
    const xStart = i + 1;
    if (xStart === dotIdx) continue;

    // acorn 从 xStart parseExpressionAt 验证 AST 形态
    let ast;
    try {
      ast = acorn.parseExpressionAt(code, xStart, { ecmaVersion: 2022, sourceType: 'module' });
    } catch {
      continue;
    }
    // 多个调用经常以 SequenceExpression 串联 (如 `e.aiService.refreshDefaultModels(),e.aiService.performDefaultModelRequest()`)
    if (ast.type === 'SequenceExpression') ast = ast.expressions[0];

    if (ast?.type !== 'CallExpression') continue;
    const c = ast.callee;
    if (c?.type !== 'MemberExpression') continue;
    if (c.property?.type !== 'Identifier' || c.property.name !== 'refreshDefaultModels') continue;
    if (c.object?.type !== 'MemberExpression') continue;
    if (c.object.property?.type !== 'Identifier' || c.object.property.name !== 'aiService') continue;
    const inner = c.object.object;
    if (inner.type !== 'Identifier' && inner.type !== 'ThisExpression') continue;

    // 替换 X.aiService 为 (globalThis.__byokAiSvc=X.aiService)
    const xText = code.slice(inner.start, inner.end);
    replacements.push({
      start: inner.start,
      end: c.object.end,
      text: `(globalThis.__byokAiSvc=${xText}.aiService)`,
    });
  }

  // 倒序应用避免偏移失效
  replacements.sort((a, b) => b.start - a.start);
  let result = code;
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end);
  }
  log?.(`  aiService ref capture: ${replacements.length}/${candidateCount} call sites (AST validated)`);
  return result;
}

/**
 * MAX Mode toggle 数据驱动隐藏 (AST 精确匹配)。
 *
 * 目标: MaxModeToggle 组件 (名为 Kec 等, 混淆后不固定)。
 * 识别方式: function 体内包含 `setMaxMode` + `"MAX Mode"` + 从 PY() 解构 state。
 *
 * 补丁: 在函数体开头注入 models 检查 guard —
 *   const{models:_ms}=PY();if(!_ms.some(_m=>_m._supportsMaxMode))return null;
 *
 * PY() 是 React context hook, 多次调用无副作用。
 * _supportsMaxMode 是 picker 内部 model 对象的属性 (从 proto supportsMaxMode 派生)。
 *
 * 效果: BYOK ON (所有模型 supportsMaxMode=false) → 组件返回 null → toggle 隐藏
 *        BYOK OFF (官方模型, 部分 supportsMaxMode=true) → 正常渲染
 */
function patchMaxModeToggle(code, log) {
  const BODY_ANCHOR = '"MAX Mode"';
  const anchorIdx = code.indexOf(BODY_ANCHOR);
  if (anchorIdx === -1) {
    log?.('  [max-mode-toggle] anchor "MAX Mode" not found — skipping');
    return code;
  }

  // 向前找到包含 "MAX Mode" 和 setMaxMode 的函数
  const funcStarts = findFunctionStarts(code, Math.max(0, anchorIdx - 3000), 3000);
  let targetFn = null;
  for (const fStart of funcStarts) {
    const bounds = extractFunction(code, fStart);
    if (!bounds || bounds.end < anchorIdx) continue;
    if (bounds.start > anchorIdx) break;
    const body = code.slice(bounds.start, bounds.end);
    if (body.includes(BODY_ANCHOR) && body.includes('setMaxMode')) {
      targetFn = bounds;
      break;
    }
  }
  if (!targetFn) {
    log?.('  [max-mode-toggle] MaxModeToggle function not found — skipping');
    return code;
  }

  // AST 验证: 确认是 FunctionDeclaration, 参数为 0 个, 体内包含 PY() 调用
  const fnSource = code.slice(targetFn.start, targetFn.end);
  let ast;
  try { ast = acorn.parse(fnSource, { ecmaVersion: 2022, sourceType: 'script' }); } catch (e) {
    log?.(`  [max-mode-toggle] AST parse failed: ${e.message} — skipping`);
    return code;
  }
  const fnDecl = ast.body[0];
  if (!fnDecl || fnDecl.type !== 'FunctionDeclaration' || !fnDecl.id?.name) {
    log?.('  [max-mode-toggle] unexpected AST shape — skipping');
    return code;
  }
  // 从 AST 提取 context hook 调用名 — 查找 { setMaxMode: ... } = <callee>()
  // callee 是混淆变量名 (如 PY), 每版本不同, 必须动态提取
  let contextHookName = null;
  function walkForContextHook(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && node.init?.type === 'CallExpression') {
      const hasSetMaxMode = node.id.properties?.some(p => p.key?.name === 'setMaxMode');
      if (hasSetMaxMode && node.init.callee?.type === 'Identifier') {
        contextHookName = node.init.callee.name;
      }
    }
    for (const key of Object.keys(node)) {
      if (contextHookName) return;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(c => { if (c && c.type) walkForContextHook(c); });
      else if (child && child.type) walkForContextHook(child);
    }
  }
  walkForContextHook(fnDecl);
  if (!contextHookName) {
    log?.('  [max-mode-toggle] context hook (setMaxMode destructor) not found via AST — skipping');
    return code;
  }

  // 找到函数体 '{' 的位置, 在其后注入 guard
  const bodyStart = targetFn.start + fnDecl.body.start + 1; // +1 跳过 '{'
  const guard = `const{models:_ms}=${contextHookName}();if(!_ms.some(_m=>_m.name!=="default"&&_m.supportsMaxMode))return null;`;
  const result = code.slice(0, bodyStart) + guard + code.slice(bodyStart);
  log?.(`  [max-mode-toggle] injected guard into ${fnDecl.id.name}() via ${contextHookName}(): return null when no model supports Max Mode`);
  return result;
}

const EXTENSION_ID = 'cometix-space.cursor2plus';

function patchGlassExtensionAllowlist(code, log) {
  // Agent Window 扩展白名单由 Jes (hD) 和 Ges (fD) 两个数组控制。
  // 6 处引用: 定义、Vn1 函数返回、2 个 .filter() 、1 个 .includes() 、组合数组。
  // 最可靠的方式: 直接修改数组定义,所有引用点自动生效。
  //
  // 定位策略: Jes 数组末尾紧跟 "],Ges=["，用这个跨数组边界的唯一指纹定位。
  // Ges 数组末尾紧跟 "],t$h=[" 或类似模式。
  const entry = `,"${EXTENSION_ID}"`;
  let result = code;
  let patched = 0;

  // Jes = [...baseList, ..., "vscode.github-authentication"]  ← 追加到此处
  const jesEnd = '"vscode.github-authentication"]';
  if (result.includes(jesEnd)) {
    result = result.replace(jesEnd, `"vscode.github-authentication"${entry}]`);
    patched++;
  }

  // Ges = [...baseList, ..., "anysphere.remote-wsl"]  ← 追加到此处
  const gesEnd = '"anysphere.remote-wsl"]';
  if (result.includes(gesEnd)) {
    result = result.replace(gesEnd, `"anysphere.remote-wsl"${entry}]`);
    patched++;
  }

  if (patched === 0) {
    log?.('  [glass-allowlist] WARNING: allowlist arrays not found, skipping');
  } else {
    log?.(`  [glass-allowlist] injected ${EXTENSION_ID} into ${patched} allowlist array(s)`);
  }
  return result;
}

export function patchInject(paths, log) {
  log?.('[inject] Patching workbench.js...');
  const code = readFileSync(paths.workbenchJs, 'utf-8');

  if (code.includes(HOOK_MARKER)) {
    log?.('[inject] Already patched');
    return;
  }

  const target = findTarget(code, log);
  log?.(`  Target: function ${target.name}(${target.paramService}, ${target.paramTransport})`);

  const { name: fnName, paramService: ps, paramTransport: pt, innerFn } = target;
  const replacement = `function ${fnName}(${ps},${pt}){return ${innerFn}(${ps},(typeof globalThis.${HOOK_MARKER}==="function"?globalThis.${HOOK_MARKER}(${pt},${ps}.typeName):${pt}))}`;

  // 1. 替换 dispatcher 包装
  let patched = code.slice(0, target.bounds.start) + replacement + code.slice(target.bounds.end);
  // 2. AST 验证 + 字符串替换, 在所有 X.aiService.refreshDefaultModels( 调用点泄漏 aiService 引用到 globalThis
  patched = captureAiServiceRef(patched, log);
  // 3. 注入 hook payload (放最前面优先执行)
  const payload = buildHookPayload();
  patched = `/* CURSOR-BYOK-HOOK-START */${payload}/* CURSOR-BYOK-HOOK-END */;${patched}`;
  // 4. MAX Mode toggle: 数据驱动隐藏
  //    原始: S = !i   (i = hideMaxToggle prop, 始终 false → toggle 始终显示)
  //    补丁: S = !i && o.some(...)  (o = models 数组, 无 supportsMaxMode 时隐藏)
  //    锚定: 同一行包含 '"max mode".includes(d)' 的唯一行
  patched = patchMaxModeToggle(patched, log);
  // 5. Glass Window (Agent Window) 扩展白名单放行
  patched = patchGlassExtensionAllowlist(patched, log);

  if (!patched.includes(HOOK_MARKER)) throw new Error('Verification failed');

  createBackup(paths.workbenchJs, 'inject', log);
  writeFileSync(paths.workbenchJs, patched);
  updateChecksums(paths, [paths.workbenchJs], 'inject', log);
  log?.('[inject] Done');
}
