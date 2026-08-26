/**
 * Workbench Delete Fix — AST-based (两处注入)
 *
 * 注入 1: deleteComposer canonical storage 移除
 *   在 archiveDeletedDraftHeaderInCanonicalStorage 调用与
 *   unlistComposer 之间注入, 对非 draft 会话直接从 canonical
 *   storage 移除 header, 防止 saveComposers() UNION 合并复活。
 *
 * 注入 2: _q_ 初始化自愈过滤
 *   在 v.allComposers = kDt(h, v.allComposers) 之后,
 *   过滤 selectedComposerIds 中不存在于 allComposers 的幽灵 ID。
 *   即使 selectedComposerIds (workspace scope) 残留了已删除的 ID,
 *   启动时也会被自动清理, 防止幽灵 tab 显示。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';

const PATCH_MARKER = '/*BYOK-DELETE-FIX*/';
const HEAL_MARKER = '/*BYOK-GHOST-HEAL*/';
const ARCHIVE_FN = 'archiveDeletedDraftHeaderInCanonicalStorage';

export function patchDeleteFix(paths, log) {
  log?.('[delete-fix] Patching...');

  if (!existsSync(paths.workbenchJs)) throw new Error(`Not found: ${paths.workbenchJs}`);

  let wbCode = readFileSync(paths.workbenchJs, 'utf-8');
  if (wbCode.includes(PATCH_MARKER) && wbCode.includes(HEAL_MARKER)) {
    log?.('  delete-fix already applied');
    log?.('[delete-fix] Done');
    return;
  }

  // ── Step 1: 定位 archiveDeletedDraftHeaderInCanonicalStorage 函数体 ──
  const fnStart = wbCode.indexOf(ARCHIVE_FN + '(e){');
  if (fnStart === -1) throw new Error(`Cannot find ${ARCHIVE_FN} in workbench`);

  let braceDepth = 0, bodyStart = -1, bodyEnd = -1;
  for (let i = wbCode.indexOf('{', fnStart); i < wbCode.length; i++) {
    if (wbCode[i] === '{') { if (braceDepth === 0) bodyStart = i; braceDepth++; }
    if (wbCode[i] === '}') { braceDepth--; if (braceDepth === 0) { bodyEnd = i + 1; break; } }
  }
  if (bodyEnd === -1) throw new Error(`Cannot extract ${ARCHIVE_FN} body (unbalanced braces)`);

  const fnBody = wbCode.slice(bodyStart, bodyEnd);
  log?.(`  Found ${ARCHIVE_FN} (${fnBody.length} chars)`);

  // ── Step 2: AST 解析提取压缩后的变量名 ──
  const ast = acorn.parse(`(function(e)${fnBody})`, { ecmaVersion: 'latest', sourceType: 'script' });

  let fnParseHeaders = null, varHeadersKey = null, fnSerialize = null;

  walk.simple(ast, {
    CallExpression(node) {
      const c = node.callee;
      // this._storageService.store(KEY, SERIALIZE(...), -1, 1)
      if (c.type === 'MemberExpression'
          && c.property?.name === 'store'
          && c.object?.type === 'MemberExpression'
          && c.object.property?.name === '_storageService') {
        if (node.arguments.length >= 2 && node.arguments[0].type === 'Identifier')
          varHeadersKey = varHeadersKey || node.arguments[0].name;
        if (node.arguments.length >= 2 && node.arguments[1].type === 'CallExpression' && node.arguments[1].callee.type === 'Identifier')
          fnSerialize = fnSerialize || node.arguments[1].callee.name;
      }
      // <fn>(this._storageService.get(KEY, -1))
      if (c.type === 'Identifier' && node.arguments.length === 1 && node.arguments[0].type === 'CallExpression') {
        const inner = node.arguments[0];
        if (inner.callee?.type === 'MemberExpression'
            && inner.callee.property?.name === 'get'
            && inner.callee.object?.type === 'MemberExpression'
            && inner.callee.object.property?.name === '_storageService') {
          fnParseHeaders = fnParseHeaders || c.name;
          if (inner.arguments.length >= 1 && inner.arguments[0].type === 'Identifier')
            varHeadersKey = varHeadersKey || inner.arguments[0].name;
        }
      }
    },
  });

  if (!fnParseHeaders || !varHeadersKey || !fnSerialize) {
    throw new Error(`AST extraction incomplete: parseHeaders=${fnParseHeaders}, headersKey=${varHeadersKey}, serialize=${fnSerialize}`);
  }
  log?.(`  AST symbols: parseHeaders=${fnParseHeaders}, headersKey=${varHeadersKey}, serialize=${fnSerialize}`);

  // ── Step 3: 定位注入锚点 ──
  const deleteAnchor = `${ARCHIVE_FN}(a),this.unlistComposer_DO_NOT_CALL_UNLESS_YOU_KNOW_WHAT_YOURE_DOING(e)`;
  if (!wbCode.includes(deleteAnchor)) throw new Error('Delete anchor pattern not found in workbench');

  // ── Step 4: 构建注入表达式 (必须是 expression，不能是 statement) ──
  const injectedCode = [
    PATCH_MARKER,
    `(a&&a.isDraft!==!0&&!this._environmentService.isGlass&&`,
      `((_h=>`,
        `this._storageService.store(${varHeadersKey},${fnSerialize}(_h.filter(_x=>_x.composerId!==e)),-1,1)`,
      `)`,
      `(${fnParseHeaders}(this._storageService.get(${varHeadersKey},-1)))))`,
  ].join('');

  // AST 验证注入代码是合法表达式
  try {
    acorn.parse(`(${injectedCode})`, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (e) {
    throw new Error(`Injected code is not a valid expression: ${e.message}`);
  }
  log?.(`  Injection validated (${injectedCode.length} chars)`);

  // ── Step 5: 注入 1 — deleteComposer canonical 移除 ──
  if (!wbCode.includes(PATCH_MARKER)) {
    createBackup(paths.workbenchJs, 'delete-fix', log);
    wbCode = wbCode.replace(
      deleteAnchor,
      `${ARCHIVE_FN}(a),${injectedCode},this.unlistComposer_DO_NOT_CALL_UNLESS_YOU_KNOW_WHAT_YOURE_DOING(e)`,
    );
    log?.('  Injected: deleteComposer canonical removal');
  }

  // ── Step 6: 注入 2 — _q_ 初始化自愈, 过滤 selectedComposerIds 中的幽灵 ──
  //
  // 锚点: v.allComposers=kDt(h,v.allComposers),v.selectedComposerIds.length===0
  // kDt 是 AST Step 2 无法直接获取的 (在不同函数中), 但我们可以通过
  // 字符串模式定位: 紧跟在 ".allComposers=" 赋值之后的 ",v.selectedComposerIds"
  //
  // 注入: 在 kDt 赋值和 selectedComposerIds 检查之间插入过滤表达式
  if (!wbCode.includes(HEAL_MARKER)) {
    const healAnchor = findHealAnchor(wbCode);
    if (healAnchor) {
      const vn = healAnchor.varName;
      // _q_(n, e, t, ...) — n 是 storageService
      // 自愈逻辑:
      //   1. 过滤 selectedComposerIds / lastFocusedComposerIds 中不在 allComposers 的幽灵 ID
      //   2. 如果过滤掉了幽灵, 删除 embeddedAuxBarEditor.state (VS Code 会从 selectedComposerIds 重建)
      //      — 覆盖 Layer 4 (VS Code 编辑器布局序列化中的幽灵引用)
      const healExpr = [
        `${HEAL_MARKER}(()=>{`,
          `const _ids=new Set(${vn}.allComposers.map(_c=>_c.composerId));`,
          `const _b=${vn}.selectedComposerIds.length;`,
          `${vn}.selectedComposerIds=${vn}.selectedComposerIds.filter(_id=>_ids.has(_id));`,
          `${vn}.lastFocusedComposerIds=(${vn}.lastFocusedComposerIds||[]).filter(_id=>_ids.has(_id));`,
          `if(${vn}.selectedComposerIds.length<_b){`,
            `try{n.remove("workbench.parts.embeddedAuxBarEditor.state",1)}catch(_e){}`,
          `}`,
        `})()`,
      ].join('');

      try {
        acorn.parse(`(${healExpr})`, { ecmaVersion: 'latest', sourceType: 'script' });
      } catch (e) {
        throw new Error(`Ghost-heal code is not valid: ${e.message}`);
      }

      // 在逗号后插入 healExpr + 逗号
      wbCode = wbCode.slice(0, healAnchor.insertPos) + healExpr + ',' + wbCode.slice(healAnchor.insertPos);
      log?.(`  Injected: _q_ ghost-heal filter (var=${vn}, ${healExpr.length} chars)`);
    } else {
      log?.('  WARNING: _q_ heal anchor not found, skipping ghost-heal');
    }
  }

  writeFileSync(paths.workbenchJs, wbCode);
  updateChecksums(paths, [paths.workbenchJs], 'delete-fix', log);

  log?.('[delete-fix] Done');
}

/**
 * AST 精确定位 _q_ 初始化函数中的注入点。
 *
 * 扫描整个 AST 查找 SequenceExpression 中的相邻模式:
 *   [0] AssignmentExpression: ?.allComposers = <merge>(?, ?.allComposers)
 *   [1] LogicalExpression: ?.selectedComposerIds.length === 0 && ...
 *
 * 返回 [0] 的结束位置和 [1] 的开始位置，用于在逗号处插入代码。
 */
/**
 * AST 精确定位 _q_ 初始化函数中的自愈注入点。
 *
 * 在 workbench 中搜索:
 *   VAR.allComposers = MERGE(h, VAR.allComposers), VAR.selectedComposerIds.length === 0
 *
 * 解析逗号前的赋值表达式验证 AST 结构, 提取压缩后的变量名。
 */
function findHealAnchor(source) {
  const needle = '.selectedComposerIds.length===0';
  let searchFrom = 0;

  while (true) {
    const idx = source.indexOf(needle, searchFrom);
    if (idx === -1) return null;
    searchFrom = idx + 1;

    // needle 前面应该是 "VAR" — 提取变量名
    let varEnd = idx;
    let varStart = varEnd - 1;
    while (varStart >= 0 && /[a-zA-Z0-9_$]/.test(source[varStart])) varStart--;
    varStart++;
    const varAfterComma = source.slice(varStart, varEnd);
    if (!varAfterComma) continue;

    // varAfterComma 前面应该是逗号
    const commaPos = varStart - 1;
    if (commaPos < 0 || source[commaPos] !== ',') continue;

    // 逗号前面应该包含 ".allComposers)" — 确认是 kDt 赋值的结尾
    const lookback = source.slice(Math.max(0, commaPos - 200), commaPos + 1);
    if (!lookback.includes('.allComposers)')) continue;

    // 向前找 "VAR.allComposers=" 确认赋值目标
    const assignNeedle = varAfterComma + '.allComposers=';
    const assignIdx = source.lastIndexOf(assignNeedle, commaPos);
    if (assignIdx === -1 || commaPos - assignIdx > 200) continue;

    // AST 验证: 提取赋值表达式片段
    const snippet = source.slice(assignIdx, commaPos);
    let validated = false;
    try {
      const ast = acorn.parse(`(${snippet})`, { ecmaVersion: 'latest', sourceType: 'script' });
      const expr = ast.body[0]?.expression;
      if (expr?.type === 'AssignmentExpression'
          && expr.left?.property?.name === 'allComposers'
          && expr.right?.type === 'CallExpression') {
        validated = true;
      }
    } catch { /* not parseable */ }

    if (!validated) continue;

    return {
      insertPos: commaPos + 1,
      varName: varAfterComma,
    };
  }
}

export function isDeleteFixApplied(paths) {
  if (!existsSync(paths.workbenchJs)) return false;
  const code = readFileSync(paths.workbenchJs, 'utf-8');
  return code.includes(PATCH_MARKER) && code.includes(HEAL_MARKER);
}
