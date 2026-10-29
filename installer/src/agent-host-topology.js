/**
 * Agent Host 拓扑守卫 (Cursor 3.13+, renderer: desktop + glass).
 *
 * Cursor 在窗口启动时决定一次 agent 拓扑 (CursorAgentHostEnablementService):
 *   this._agentHostEnabled = (cursor_agent_host gate || 私有推理 || 本地 token) && 远端工作区策略
 *   - true  → extension-host 实现: 由 cursor-agent-host 扩展执行 turn
 *   - false → legacy 实现: 经本地 cursor-always-local 发出 RunSSE (Cursor++ 可拦截)
 * 开关与 cursor-agent-host 扩展同在 3.13.25 引入; gate 内置默认 false, 由服务端 Statsig 灰度开启 (3.23 前后)。
 *
 * 远端工作区 (Remote-SSH / WSL / Dev Container) 的问题 (PR #33):
 *   cursor-agent-host 未声明 extensionKind → 默认 workspace → 在远端扩展宿主运行。
 *   installer 只能修补本地 app, 远端 ~/.cursor-server 里的 agent host 不经任何 BYOK 路由,
 *   且远端的 127.0.0.1 也不是本机 BYOK server —— BYOK 模型名被直发官方, 返回
 *   ERROR_BAD_MODEL_NAME。拓扑为 false 时 Cursor 直接不启动 cursor-agent-host 扩展
 *   (扩展过滤器 cursorAgentHostEnabled), turn 回到本地 legacy 链路。
 *
 * 改写: 把赋值右侧交给 hook payload 的 __byokAgentHostTopology 决定 (见 patch-inject.js),
 * 仅「远端窗口 + BYOK 开」时返回 false; 本地窗口与 BYOK 关闭时原值不变。
 *
 *   this._agentHostEnabled=RHS
 *   ⇒ this._agentHostEnabled=(globalThis.__byokAgentHostTopology?globalThis.__byokAgentHostTopology(RHS):RHS)
 *
 * Cursor 紧随其后的日志 "effective agent-host topology is …" 读取的是改写后的最终值,
 * renderer.log 如实反映守卫的决定。
 *
 * 定位手法来自 PR #33 (rainoffallingstar): 唯一赋值点 + acorn.parseExpressionAt 精确框出 RHS
 * (`this.X=RHS,t.info(...)` 会被解析为 SequenceExpression, 取首项才不会吞掉后续日志调用)。
 * 不做整文件 parse (workbench 40MB+, 单次 10s 以上), 改写后对替换区域局部重新解析校验。
 */
import * as acorn from 'acorn';

export const TOPOLOGY_MARKER = '__byokAgentHostTopology';
const ASSIGN_NEEDLE = 'this._agentHostEnabled=';

function parseExpressionAt(source, offset, label, preserveParens = false) {
  try {
    let node = acorn.parseExpressionAt(source, offset, { ecmaVersion: 'latest', sourceType: 'module', preserveParens });
    if (node.type === 'SequenceExpression') node = node.expressions[0];
    return node;
  }
  catch (error) {
    throw new Error(`${label}: agent host topology RHS parse failed at ${offset}: ${error.message}`);
  }
}

/** 该 bundle 是否带拓扑开关 (pre-3.13 无) */
export function hasAgentHostTopology(source) {
  return source.includes(ASSIGN_NEEDLE);
}

export function isAgentHostTopologyGuarded(source) {
  return source.includes(`${ASSIGN_NEEDLE}(/*${TOPOLOGY_MARKER}*/`);
}

/**
 * 定位唯一赋值点的 RHS。多处赋值 / RHS 形态异常 → 抛错 (fail closed: 版本改写了判定, 需要更新 installer)。
 * @returns {{ start: number, end: number, rhs: string }}
 */
export function locateTopologyRhs(source, label) {
  const at = source.indexOf(ASSIGN_NEEDLE);
  if (at === -1) throw new Error(`${label}: agent host topology assignment not found`);
  if (source.indexOf(ASSIGN_NEEDLE, at + ASSIGN_NEEDLE.length) !== -1) {
    throw new Error(`${label}: multiple agent host topology assignments (shape changed; installer needs update)`);
  }
  const start = at + ASSIGN_NEEDLE.length;
  const node = parseExpressionAt(source, start, label);
  const rhs = source.slice(start, node.end);
  // 压缩产物里 RHS 是几个局部变量的布尔组合; 过长或跨行说明定位偏了, 宁可不改
  if (!rhs || rhs.length > 200 || rhs.includes('\n')) {
    throw new Error(`${label}: agent host topology RHS looks wrong ("${rhs.slice(0, 60)}")`);
  }
  return { start, end: node.end, rhs };
}

/**
 * @returns {{ source: string, changed: boolean, rhs?: string }}
 */
export function guardAgentHostTopology(source, label) {
  if (!hasAgentHostTopology(source) || isAgentHostTopologyGuarded(source)) return { source, changed: false };
  const { start, end, rhs } = locateTopologyRhs(source, label);
  const wrapped = `(/*${TOPOLOGY_MARKER}*/globalThis.${TOPOLOGY_MARKER}?globalThis.${TOPOLOGY_MARKER}(${rhs}):${rhs})`;
  const out = source.slice(0, start) + wrapped + source.slice(end);
  // 局部校验: 同一位置重新解析应恰好覆盖 wrapped, 后续代码 (日志调用) 原样保留
  const verify = parseExpressionAt(out, start, `${label} (topology guarded)`, true);
  if (verify.end !== start + wrapped.length || verify.expression?.type !== 'ConditionalExpression') {
    throw new Error(`${label}: agent host topology guard verification failed`);
  }
  return { source: out, changed: true, rhs };
}
