/**
 * Workbench Delete Fix — AST-based
 *
 * 修复 deleteComposer 不更新 canonical storage 导致非 draft 会话
 * 删除后 reload window 复活的客户端 bug。
 *
 * 原因: deleteComposer_DO_NOT_CALL 仅对 isDraft===true 的会话调用
 * archiveDeletedDraftHeaderInCanonicalStorage 写入 canonical storage。
 * 非 draft 会话只做 unlistComposer (内存移除), canonical storage
 * (composer.composerHeaders in state.vscdb) 未更新。
 * saveComposers() 的 UNION 合并将已删除条目从 canonical 重新引入。
 *
 * 修复: 在 archiveDeletedDraftHeaderInCanonicalStorage 调用与
 * unlistComposer 之间注入表达式, 对非 draft 会话直接从 canonical
 * storage 移除 header。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';

const PATCH_MARKER = '/*BYOK-DELETE-FIX*/';
const ARCHIVE_FN = 'archiveDeletedDraftHeaderInCanonicalStorage';

export function patchDeleteFix(paths, log) {
  log?.('[delete-fix] Patching...');

  if (!existsSync(paths.workbenchJs)) throw new Error(`Not found: ${paths.workbenchJs}`);

  const wbCode = readFileSync(paths.workbenchJs, 'utf-8');
  if (wbCode.includes(PATCH_MARKER)) {
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

  // ── Step 5: 备份 + 写入 + checksum ──
  createBackup(paths.workbenchJs, 'delete-fix', log);
  const patched = wbCode.replace(
    deleteAnchor,
    `${ARCHIVE_FN}(a),${injectedCode},this.unlistComposer_DO_NOT_CALL_UNLESS_YOU_KNOW_WHAT_YOURE_DOING(e)`,
  );
  writeFileSync(paths.workbenchJs, patched);
  updateChecksums(paths, [paths.workbenchJs], 'delete-fix', log);

  log?.('[delete-fix] Done');
}

export function isDeleteFixApplied(paths) {
  if (!existsSync(paths.workbenchJs)) return false;
  return readFileSync(paths.workbenchJs, 'utf-8').includes(PATCH_MARKER);
}
