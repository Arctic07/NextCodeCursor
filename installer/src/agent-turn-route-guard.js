/**
 * Agent Host turn 路由守卫 (Cursor 3.16.29+).
 *
 * Agent Host 在每个 turn 前选择运行时:
 *   - connect       → agent.v1.AgentService/RunSSE           (BYOK server 已实现)
 *   - managed-local → aiserver.v1.InferenceService/RunInferenceSSE (BYOK 未实现, 直发官方)
 * 判定链 (gate agent_host_local_loop 开启 + 模型无 apiKey 凭据 …) 最终落到
 * `{runtime:"managed-local",reason:"eligible"}`。BYOK 模型来自 AvailableModels, 不带凭据,
 * 于是被送往 managed-local → 官方 → "Taking longer than expected" / Unknown model ID (Issue #34)。
 *
 * 改写: 仅当 BYOK 接管 RunSSE 时 (同进程路由 payload 暴露的 __byokRpcRouted, 随 routes.json 热更新)
 * 才改为 Cursor 自己给「带凭据模型」用的 connect 分支; BYOK OFF 时原分支不变, 官方 local-loop 照常。
 *
 *   {runtime:"managed-local",reason:"eligible"}
 *   ⇒ (globalThis.__byokRpcRouted&&globalThis.__byokRpcRouted("/agent.v1.AgentService/RunSSE")
 *        ? {runtime:"connect",reason:"byok-connect-routed",disposition:"fallback"}
 *        : {runtime:"managed-local",reason:"eligible"})
 *
 * 版本边界: 3.16.29–3.18.25 位于懒加载 chunk, 3.19.19+ 在 dist/main.js; 守卫按内容扫描全部 dist 文件。
 * 定位用 AST (对象字面量恰好两个属性且值为字面量), 不用正则; 有路由指纹却找不到目标 → 抛错 (fail closed)。
 */
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

export const TURN_ROUTE_MARKER = '__byokTurnRouteGuard';
const ROUTED_PATH = '/agent.v1.AgentService/RunSSE';
// 路由模块指纹: 3.19.19+ logger 名 local-loop-turn-router; 3.16.29–3.18.25 为 turn-routing
const ROUTER_FINGERPRINTS = ['local-loop-turn-router', 'agent-host:turn-routing'];
const CONNECT_ROUTE = '{runtime:"connect",reason:"byok-connect-routed",disposition:"fallback"}';

function parseBundle(source, label) {
  try {
    return acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  }
  catch (error) {
    throw new Error(`${label} JavaScript parse failed: ${error.message}`);
  }
}

const keyName = p => (p.key?.type === 'Identifier' ? p.key.name : (p.key?.type === 'Literal' ? p.key.value : null));

/** 目标: 恰好 {runtime:"managed-local", reason:"eligible"} 两个属性, 值为字符串字面量 */
function isEligibleRoute(node) {
  if (node.type !== 'ObjectExpression' || node.properties.length !== 2) return false;
  const props = {};
  for (const p of node.properties) {
    if (p.type !== 'Property' || p.computed || p.value.type !== 'Literal') return false;
    props[keyName(p)] = p.value.value;
  }
  return props.runtime === 'managed-local' && props.reason === 'eligible';
}

/** 是否已被本守卫包住: 父节点为三元表达式且 test 引用 __byokRpcRouted */
function isGuarded(ancestors, source) {
  const parent = ancestors[ancestors.length - 2];
  return parent?.type === 'ConditionalExpression'
    && parent.alternate === ancestors[ancestors.length - 1]
    && source.slice(parent.test.start, parent.test.end).includes('__byokRpcRouted');
}

function scanTurnRoutes(source, label) {
  const ast = parseBundle(source, label);
  const unguarded = [];
  let guarded = 0;
  walk.ancestor(ast, {
    ObjectExpression(node, _state, ancestors) {
      if (!isEligibleRoute(node)) return;
      if (isGuarded(ancestors, source)) guarded++;
      else unguarded.push(node);
    },
  });
  return { unguarded, guarded };
}

/** 文件是否包含 turn 路由代码 (内容指纹 + 目标字面量) */
export function hasTurnRouter(source) {
  return ROUTER_FINGERPRINTS.some(f => source.includes(f)) && source.includes('"managed-local"');
}

/** 可能承载 eligible 分支的文件 (chunk 里不一定带 logger 名, 以字面量预筛) */
export function mayContainTurnRoute(source) {
  return source.includes('"managed-local"') && source.includes('"eligible"');
}

export function isTurnRouteGuarded(source, label = 'Agent Host bundle') {
  if (!mayContainTurnRoute(source)) return true;
  return scanTurnRoutes(source, label).unguarded.length === 0;
}

/**
 * @returns {{ source: string, changed: number, guarded: number }}
 */
export function guardTurnRoute(source, label = 'Agent Host bundle') {
  if (!mayContainTurnRoute(source)) return { source, changed: 0, guarded: 0 };
  const { unguarded, guarded } = scanTurnRoutes(source, label);
  if (unguarded.length === 0) return { source, changed: 0, guarded };

  let out = source;
  for (const node of [...unguarded].sort((a, b) => b.start - a.start)) {
    const original = source.slice(node.start, node.end);
    const replacement = `(/*${TURN_ROUTE_MARKER}*/globalThis.__byokRpcRouted&&globalThis.__byokRpcRouted(${JSON.stringify(ROUTED_PATH)})?${CONNECT_ROUTE}:${original})`;
    out = out.slice(0, node.start) + replacement + out.slice(node.end);
  }
  parseBundle(out, `${label} (turn route guarded)`);
  const verify = scanTurnRoutes(out, label);
  if (verify.unguarded.length !== 0) throw new Error(`${label}: turn route guard verification failed (${verify.unguarded.length} unguarded)`);
  return { source: out, changed: unguarded.length, guarded: verify.guarded };
}

/**
 * 跨文件校验: 带路由指纹的文件集合中至少要有一个 eligible 目标 (已守卫或可守卫)。
 * 指纹在而目标为零 = 版本改写了判定形态, 不能当作「无需补丁」静默跳过。
 * @param {Array<{ file: string, source: string }>} files
 */
export function assertTurnRouteShape(files) {
  const withFingerprint = files.filter(f => hasTurnRouter(f.source));
  if (withFingerprint.length === 0) return { required: false };
  const total = files
    .filter(f => mayContainTurnRoute(f.source))
    .reduce((n, f) => {
      const r = scanTurnRoutes(f.source, f.file);
      return n + r.unguarded.length + r.guarded;
    }, 0);
  if (total === 0) throw new Error('Agent Host turn router present but managed-local eligible route not found (shape changed; installer needs update)');
  return { required: true };
}
