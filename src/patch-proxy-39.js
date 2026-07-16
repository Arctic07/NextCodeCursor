/**
 * Cursor 3.9+ Always-Local Singleton BYOK Fix
 *
 * Cursor 3.8 introduced alwaysLocalSingletonMain.js, but 3.9 moved the active
 * AiService HTTP/1.1 transport into that singleton utility process and inlined
 * @connectrpc/connect-node's transport code with ESM namespace imports:
 *   import * as X from "http" / "https"; X.request(...)
 *
 * The legacy BYOK router lives in extensions/cursor-always-local/dist/main.js,
 * which is a different extension-host process. Therefore 3.9 AvailableModels
 * can bypass BYOK entirely unless we install the whitelist router inside the
 * singleton process too.
 *
 * This patch does two things after VSCode's proxy-agent patch is installed:
 *   1. install a BYOK http/https.request whitelist router in singleton process;
 *   2. (< 3.11.25 only) call module.syncBuiltinESMExports() so ESM namespace
 *      imports used by the inlined HTTP/1.1 transport see the patched request
 *      functions. 3.11.25+ calls syncBuiltinESMExports natively.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';
import { CCURSOR_DIR_NAME, DEFAULT_HOST, DEFAULT_PORT, ROUTES_FILE_NAME } from './defaults.js';

const TAG = 'proxy-39';
const SYNC_MARKER = '__byokSyncBuiltinESMExports';
const SYNC_CALL_MARKER = '/*BYOK-PROXY39*/';
const ROUTER_MARKER = '__byokSingletonUrlRewrite';
const ROUTER_CALL_MARKER = '/*BYOK-SINGLETON-ROUTER*/';
const TARGET_REL = 'out/vs/code/electron-utility/alwaysLocalSingleton/alwaysLocalSingletonMain.js';

function parseSemver(v) {
  const [major = 0, minor = 0, patch = 0] = String(v || '0.0.0').split('.').map(n => Number(n) || 0);
  return { major, minor, patch };
}

function is39OrNewer(version) {
  const v = parseSemver(version);
  return v.major > 3 || (v.major === 3 && v.minor >= 9);
}

function is1125OrNewer(version) {
  const v = parseSemver(version);
  if (v.major > 3) return true;
  if (v.major < 3) return false;
  if (v.minor > 11) return true;
  if (v.minor < 11) return false;
  return v.patch >= 25;
}

export function getProxy39Target(paths) {
  return paths.alwaysLocalSingletonJs || join(paths.appRoot, TARGET_REL);
}

export function needsProxy39Patch(paths) {
  return is39OrNewer(paths.cursorVersion) && existsSync(getProxy39Target(paths));
}

function hasSyncPatch(code) {
  return code.includes(SYNC_CALL_MARKER);
}

function hasRouterPatch(code) {
  return code.includes(ROUTER_MARKER);
}

export function isProxy39Patched(paths) {
  const target = getProxy39Target(paths);
  if (!existsSync(target)) return false;
  const code = readFileSync(target, 'utf-8');
  const syncOk = hasSyncPatch(code) || is1125OrNewer(paths.cursorVersion);
  return hasRouterPatch(code) && syncOk;
}

// ── createRequire 定位 ──

function findCreateRequireAlias(source) {
  const re = /import\s*\{([^}]*)\}\s*from\s*(["'])node:module\2;?/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const spec = match[1].trim();
    const alias = spec.match(/\bcreateRequire\s+as\s+([$A-Z_a-z][$\w]*)\b/)?.[1];
    if (alias) return alias;
    if (/\bcreateRequire\b/.test(spec)) return 'createRequire';
  }
  return null;
}

// ── syncBuiltinESMExports 注入 (< 3.11.25 only) ──

function ensureSyncImport(source) {
  const re = /import\s*\{([^}]*)\}\s*from\s*(["'])node:module\2;?/g;
  let match;
  let targetMatch = null;
  let createRequireName = null;

  while ((match = re.exec(source)) !== null) {
    const spec = match[1].trim();
    const alias = spec.match(/\bcreateRequire\s+as\s+([$A-Z_a-z][$\w]*)\b/)?.[1];
    if (alias) createRequireName = alias;
    else if (/\bcreateRequire\b/.test(spec)) createRequireName = 'createRequire';

    const syncAlias = spec.match(/\bsyncBuiltinESMExports\s+as\s+([$A-Z_a-z][$\w]*)\b/)?.[1];
    if (syncAlias) return { source, fnName: syncAlias, createRequireName };
    if (/\bsyncBuiltinESMExports\b/.test(spec)) return { source, fnName: 'syncBuiltinESMExports', createRequireName };

    if (!targetMatch && createRequireName) targetMatch = match;
  }

  if (!createRequireName) {
    throw new Error('node:module createRequire import not found in alwaysLocalSingletonMain.js');
  }

  if (!targetMatch) {
    throw new Error('node:module import for createRequire not found');
  }

  const spec = targetMatch[1].trim();
  const replacement = `import{${spec},syncBuiltinESMExports as ${SYNC_MARKER}}from${targetMatch[2]}node:module${targetMatch[2]};`;
  return { source: source.replace(targetMatch[0], replacement), fnName: SYNC_MARKER, createRequireName };
}

function buildSingletonRouterCall(createRequireName) {
  const fallbackHost = JSON.stringify(DEFAULT_HOST);
  const fallbackPort = String(DEFAULT_PORT);
  const ccursorDir = JSON.stringify(CCURSOR_DIR_NAME);
  const routesFile = JSON.stringify(ROUTES_FILE_NAME);

  return `${ROUTER_CALL_MARKER}(function(__byokCreateRequire){if(globalThis.${ROUTER_MARKER})return;globalThis.${ROUTER_MARKER}=true;var _require=__byokCreateRequire(import.meta.url);var _http=_require("http");var _https=_require("https");var _fs=_require("fs");var _path=_require("path");var _os=_require("os");var _proxyHttp=_http.request;var _proxyHttps=_https.request;var _directHttp=(_http.__vscodeOriginal&&_http.__vscodeOriginal.request)||_proxyHttp;var ROUTES_PATH=_path.join(_os.homedir(),${ccursorDir},${routesFile});var FALLBACK_HOST=${fallbackHost};var FALLBACK_PORT=${fallbackPort};var state={host:FALLBACK_HOST,port:FALLBACK_PORT,base:"http://"+FALLBACK_HOST+":"+FALLBACK_PORT,svcSet:new Set(),methodSet:new Set(),restSet:new Set(),ruleCount:0,restCount:0};function loadConfig(){try{var raw=_fs.readFileSync(ROUTES_PATH,"utf-8");var cfg=JSON.parse(raw);var host=(cfg&&cfg.server&&cfg.server.host)||FALLBACK_HOST;var port=(cfg&&cfg.server&&cfg.server.port)||FALLBACK_PORT;var rules=(cfg&&Array.isArray(cfg.redirect))?cfg.redirect:[];var svcSet=new Set(),methodSet=new Set(),restSet=new Set(),ruleCount=0,restCount=0;for(var i=0;i<rules.length;i++){var r=rules[i];if(typeof r!=="string")continue;if(r.indexOf("REST:")===0){restSet.add(r.slice(5));restCount++}else if(r.indexOf("/")!==-1){methodSet.add(r);ruleCount++}else{svcSet.add(r);ruleCount++}}return{host:host,port:port,base:"http://"+host+":"+port,svcSet:svcSet,methodSet:methodSet,restSet:restSet,ruleCount:ruleCount,restCount:restCount}}catch(e){return{host:FALLBACK_HOST,port:FALLBACK_PORT,base:"http://"+FALLBACK_HOST+":"+FALLBACK_PORT,svcSet:new Set(),methodSet:new Set(),restSet:new Set(),ruleCount:0,restCount:0}}}function applyState(label){state=loadConfig();console.log("[BYOK] singleton "+label+" -> "+state.base+" (ConnectRPC="+state.ruleCount+", REST="+state.restCount+")")}applyState("routes loaded");try{_fs.watchFile(ROUTES_PATH,{interval:2000,persistent:false},function(){applyState("routes reloaded")})}catch(e){console.warn("[BYOK] singleton watchFile failed: "+e.message)}function isApiHost(h){h=String(h||"").toLowerCase();return /(^|\\.)api[234]\\.cursor\\.sh$|(^|\\.)api5\\.cursor\\.sh$|(^|\\.)gcpp\\.cursor\\.sh$/.test(h)}function normalizePath(p){p=String(p||"");var q=p.indexOf("?");return q===-1?p:p.slice(0,q)}function shouldRedirect(pathname){pathname=normalizePath(pathname);if(!pathname||pathname.length<2)return false;if(state.restSet.has(pathname))return true;var p=pathname.charAt(0)==="/"?pathname.slice(1):pathname;var slash=p.indexOf("/");if(slash===-1)return false;if(state.methodSet.has(p))return true;var svc=p.slice(0,slash);return state.svcSet.has(svc)}function parseUrl(u){try{if(typeof u==="string"){var s=new URL(u);return{hostname:s.hostname,path:s.pathname+s.search,raw:u,kind:"string"}}if(u instanceof URL)return{hostname:u.hostname,path:u.pathname+u.search,raw:u,kind:"url"};if(u&&typeof u==="object"){var host=u.hostname||(u.host?String(u.host).replace(/:\\d+$/,""):"");var path=u.path||((u.pathname||"/")+(u.search||""));return{hostname:host,path:path,raw:u,kind:"object"}}}catch(e){}return null}function rewriteToString(p){return state.base+(p.path&&p.path.charAt(0)==="/"?p.path:"/"+(p.path||""))}function rewriteOpts(u){var o=Object.assign({},u);o.protocol="http:";o.hostname=state.host;o.host=state.host+":"+state.port;o.port=state.port;return o}function intercept(isHttps){return function(u,o,cb){var parsed=parseUrl(u);if(parsed&&isApiHost(parsed.hostname)&&shouldRedirect(parsed.path)){if(parsed.kind==="object")return _directHttp.call(_http,rewriteOpts(parsed.raw),o,cb);return _directHttp.call(_http,rewriteToString(parsed),o,cb)}return(isHttps?_proxyHttps:_proxyHttp).call(isHttps?_https:_http,u,o,cb)}}_http.request=intercept(false);_https.request=intercept(true);console.log("[BYOK] singleton whitelist router active (config: "+ROUTES_PATH+")")})(${createRequireName})`;
}

// ── 插入逻辑 ──

function insertBeforeSyncCall(source, routerCall, fnName) {
  const exact = `${SYNC_CALL_MARKER}${fnName}()`;
  const idx = source.indexOf(exact);
  if (idx !== -1) {
    return source.slice(0, idx) + `${routerCall},` + source.slice(idx);
  }

  const call = `${fnName}()`;
  const phrase = '[AlwaysLocalSingleton] proxy-agent patches installed';
  const anchor = source.indexOf(phrase);
  if (anchor === -1) throw new Error('proxy-agent installed log anchor not found in alwaysLocalSingletonMain.js');
  const callIdx = source.lastIndexOf(call, anchor);
  if (callIdx === -1) throw new Error('syncBuiltinESMExports call not found before proxy-agent log anchor');
  return source.slice(0, callIdx) + `${routerCall},${SYNC_CALL_MARKER}` + source.slice(callIdx);
}

function insertRouterOnly(source, routerCall) {
  const phrase = '[AlwaysLocalSingleton] proxy-agent patches installed';
  const idx = source.indexOf(phrase);
  if (idx === -1) throw new Error('proxy-agent installed log anchor not found in alwaysLocalSingletonMain.js');

  // 3.11.25+: pattern is `installFn(arg),syncFn(),logger.info("...")`
  // Find the `)` right before the `,logger.info(...)` — insert router after the proxy-agent install call
  const start = Math.max(0, idx - 600);
  const window = source.slice(start, idx);
  const commaIdx = window.lastIndexOf('),');
  if (commaIdx === -1) throw new Error('proxy-agent install call not found before log anchor');

  const insertAt = start + commaIdx + 1;
  return source.slice(0, insertAt) + `,${routerCall}` + source.slice(insertAt);
}

function insertPatches(source, fnName, createRequireName, nativeSync) {
  const hasRouter = hasRouterPatch(source);
  const hasSync = hasSyncPatch(source) || nativeSync;
  if (hasRouter && hasSync) return source;

  const routerCall = buildSingletonRouterCall(createRequireName);

  // 3.11.25+: sync is native, only need router
  if (nativeSync) {
    if (hasRouter) return source;
    return insertRouterOnly(source, routerCall);
  }

  // Upgrade path for installations that already have the first proxy-39 sync-only patch.
  if (hasSync && !hasRouter) {
    return insertBeforeSyncCall(source, routerCall, fnName);
  }

  // Fast path for the minified production bundle (< 3.11.25):
  //   CLa(m),e.info("[AlwaysLocalSingleton] proxy-agent patches installed")
  const directRe = /([$_A-Z_a-z][$\w]*)\(([^(){};]{1,160})\),\s*([$_A-Z_a-z][$\w]*)\.info\((["'])\[AlwaysLocalSingleton\] proxy-agent patches installed\4\)/;
  if (directRe.test(source)) {
    return source.replace(directRe, (_m, installFn, arg, logger, quote) => {
      const syncCall = hasSync ? '' : `,${SYNC_CALL_MARKER}${fnName}()`;
      const router = hasRouter ? '' : `,${routerCall}`;
      return `${installFn}(${arg})${router}${syncCall},${logger}.info(${quote}[AlwaysLocalSingleton] proxy-agent patches installed${quote})`;
    });
  }

  // Fallback: anchor on the log string and insert after the immediately preceding call.
  const phrase = '[AlwaysLocalSingleton] proxy-agent patches installed';
  const anchorIdx = source.indexOf(phrase);
  if (anchorIdx === -1) {
    throw new Error('proxy-agent installed log anchor not found in alwaysLocalSingletonMain.js');
  }

  const start = Math.max(0, anchorIdx - 400);
  const window = source.slice(start, anchorIdx);
  const commaIdx = window.lastIndexOf('),');
  if (commaIdx === -1) {
    throw new Error('proxy-agent install call not found before log anchor');
  }

  const insertAt = start + commaIdx + 1;
  const patchCalls = `${hasRouter ? '' : `,${routerCall}`}${hasSync ? '' : `,${SYNC_CALL_MARKER}${fnName}()`}`;
  return source.slice(0, insertAt) + patchCalls + source.slice(insertAt);
}

// ── Public API ──

export function patchProxy39(paths, log) {
  if (!is39OrNewer(paths.cursorVersion)) {
    log?.('[proxy-39] Cursor < 3.9, skipping');
    return false;
  }

  const target = getProxy39Target(paths);
  if (!existsSync(target)) {
    log?.('[proxy-39] alwaysLocalSingletonMain.js not found, skipping');
    return false;
  }

  let code = readFileSync(target, 'utf-8');
  if (isProxy39Patched(paths)) {
    log?.('[proxy-39] Singleton BYOK router/proxy sync already applied');
    return false;
  }

  // Only force this on the 3.9+ inline HTTP/1.1 transport shape.
  if (!/from\s*["']https["']/.test(code) || !/from\s*["']http["']/.test(code) || !code.includes('proxy-agent patches installed')) {
    log?.('[proxy-39] 3.9 inline HTTP/1.1 transport signature not found, skipping');
    return false;
  }

  const nativeSync = is1125OrNewer(paths.cursorVersion);

  if (nativeSync) {
    // 3.11.25+: only need the BYOK router, sync is native
    log?.('[proxy-39] 3.11.25+ detected: native syncBuiltinESMExports, injecting router only...');
    const createRequireName = findCreateRequireAlias(code);
    if (!createRequireName) {
      throw new Error('node:module createRequire import not found in alwaysLocalSingletonMain.js');
    }
    code = insertPatches(code, null, createRequireName, true);
  } else {
    log?.('[proxy-39] Patching singleton BYOK router + proxy sync...');
    const imported = ensureSyncImport(code);
    code = insertPatches(imported.source, imported.fnName, imported.createRequireName, false);
  }

  if (!hasRouterPatch(code)) {
    throw new Error('proxy-39 patch insertion failed verification (router)');
  }
  if (!nativeSync && !hasSyncPatch(code)) {
    throw new Error('proxy-39 patch insertion failed verification (sync)');
  }

  createBackup(target, TAG, log);
  writeFileSync(target, code);
  updateChecksums(paths, [target], TAG, log);
  log?.('[proxy-39] Done');
  return true;
}

export function checkProxy39Patch(paths, log) {
  if (!is39OrNewer(paths.cursorVersion)) {
    log?.('  Cursor < 3.9, not required');
    return true;
  }

  const target = getProxy39Target(paths);
  if (!existsSync(target)) {
    log?.('  alwaysLocalSingletonMain.js not found');
    return false;
  }

  const code = readFileSync(target, 'utf-8');
  const nativeSync = is1125OrNewer(paths.cursorVersion);

  if (hasRouterPatch(code) && (hasSyncPatch(code) || nativeSync)) {
    log?.('  Already patched');
    return true;
  }

  try {
    if (nativeSync) {
      const createRequireName = findCreateRequireAlias(code);
      if (!createRequireName) throw new Error('createRequire alias not found');
      const patched = insertPatches(code, null, createRequireName, true);
      if (!hasRouterPatch(patched)) throw new Error('dry-run did not produce router marker');
      log?.('  [OK] 3.11.25+ singleton BYOK router insertion point found (native sync)');
    } else {
      const imported = ensureSyncImport(code);
      const patched = insertPatches(imported.source, imported.fnName, imported.createRequireName, false);
      if (!hasRouterPatch(patched) || !hasSyncPatch(patched)) {
        throw new Error('dry-run insertion did not produce both router and sync markers');
      }
      log?.('  [OK] singleton BYOK router/proxy sync insertion point found');
    }
    return true;
  } catch (e) {
    log?.(`  [FAIL] ${e.message}`);
    return false;
  }
}
