/**
 * KaTeX CSS link injection for Cursor 3.6–3.8 only
 *
 * 3.6 构建回归: KaTeX CSS 从 workbench.desktop.main.css 中脱落,
 * 导致公式渲染的 .katex-mathml 层可见(MathML 纯文本暴露)、字体/布局缺失。
 * 3.8 引入 glass CSS 后同样缺失。3.9.16+ 官方已把完整 KaTeX 规则重新打进
 * desktop/glass CSS,字体落到 out/media/,不再需要此补丁。
 *
 * 版本范围 (本地实测):
 *   < 3.6     — workbench CSS 已含 KaTeX, skip
 *   3.6–3.8.x — CSS 脱落, 需要 patch
 *   ≥ 3.9     — 官方修回, skip
 *
 * 修补: 在 workbench.html 追加一条 <link> 引用 extensions/markdown-math 里已有的 katex.min.css。
 * CSS 文件的 url(fonts/...) 相对路径天然指向同目录下的 fonts/,字体无需额外拷贝。
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';

const KATEX_LINK = '<link rel="stylesheet" href="../../../../../extensions/markdown-math/notebook-out/katex.min.css">';
const MARKER = 'katex.min.css';

function parseSemver(v) {
  const [major = 0, minor = 0, patch = 0] = String(v || '0.0.0').split('.').map(n => Number(n) || 0);
  return { major, minor, patch };
}

/**
 * 仅 3.6.0 ≤ version < 3.9.0 需要 KaTeX CSS link 补丁。
 */
export function needsKatexPatch(paths) {
  const v = parseSemver(paths?.cursorVersion);
  if (v.major !== 3) return false;
  return v.minor >= 6 && v.minor < 9;
}

export function patchKatex(paths, log) {
  if (!needsKatexPatch(paths)) {
    const v = paths?.cursorVersion || '?';
    log?.(`[katex] Cursor ${v} outside 3.6–3.8 range, skipping (official KaTeX CSS present or not yet regressed)`);
    return false;
  }

  const htmlPath = `${paths.appRoot}/out/vs/code/electron-sandbox/workbench/workbench.html`;
  if (!existsSync(htmlPath)) {
    log?.('[katex] WARNING: workbench.html not found, skipping');
    return false;
  }
  const katexCssPath = `${paths.appRoot}/extensions/markdown-math/notebook-out/katex.min.css`;
  if (!existsSync(katexCssPath)) {
    log?.('[katex] WARNING: katex.min.css not found, skipping');
    return false;
  }

  let html = readFileSync(htmlPath, 'utf-8');
  if (html.includes(MARKER)) {
    log?.('[katex] already linked');
    return false;
  }

  // 1. Backup
  createBackup(htmlPath, 'katex', log);

  // 2. 注入 <link> — 紧跟在 workbench CSS link 之后
  const needle = 'workbench.desktop.main.css">';
  const idx = html.indexOf(needle);
  if (idx === -1) {
    log?.('[katex] WARNING: workbench CSS link not found in HTML, appending to <head>');
    html = html.replace('</head>', `\t\t${KATEX_LINK}\n\t</head>`);
  } else {
    html = html.slice(0, idx + needle.length) + '\n\t\t' + KATEX_LINK + html.slice(idx + needle.length);
  }
  writeFileSync(htmlPath, html, 'utf-8');
  log?.('[katex] linked katex.min.css in workbench.html');

  // 3. Checksum
  updateChecksums(paths, [htmlPath], 'katex', log);

  log?.('[katex] Done');
  return true;
}
