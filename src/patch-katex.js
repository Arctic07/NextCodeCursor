/**
 * KaTeX CSS Link Patch — workbench.html
 *
 * 3.6+ 构建回归: KaTeX CSS (390 条规则) 从 workbench.desktop.main.css 中脱落,
 * 导致公式渲染的 .katex-mathml 层可见(MathML 纯文本暴露)、字体/布局缺失。
 *
 * 修补: 在 workbench.html 追加一条 <link> 引用 extensions/markdown-math 里已有的 katex.min.css。
 * CSS 文件的 url(fonts/...) 相对路径天然指向同目录下的 fonts/,字体无需额外拷贝。
 *
 * 跨版本:
 *   3.5: workbench CSS 已含 KaTeX CSS,多一条 link 引用只是冗余覆盖,无副作用。
 *   3.6+: workbench CSS 缺失,link 引用补回完整规则。
 *
 * 这也替代了旧版 copyKatexFonts (拷贝字体到 out/vs/workbench/fonts/):
 *   旧方案需要拷贝是因为 CSS 在 workbench.desktop.main.css 里,url(fonts/) 解析到 out/vs/workbench/fonts/;
 *   新方案 CSS 在 extensions/.../notebook-out/,url(fonts/) 自动解析到同目录的 fonts/,天然匹配。
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';

const KATEX_LINK = '<link rel="stylesheet" href="../../../../../extensions/markdown-math/notebook-out/katex.min.css">';
const MARKER = 'katex.min.css';

export function patchKatex(paths, log) {
  const htmlPath = `${paths.appRoot}/out/vs/code/electron-sandbox/workbench/workbench.html`;
  if (!existsSync(htmlPath)) {
    log?.('[katex] WARNING: workbench.html not found, skipping');
    return;
  }
  const katexCssPath = `${paths.appRoot}/extensions/markdown-math/notebook-out/katex.min.css`;
  if (!existsSync(katexCssPath)) {
    log?.('[katex] WARNING: katex.min.css not found, skipping');
    return;
  }

  let html = readFileSync(htmlPath, 'utf-8');
  if (html.includes(MARKER)) {
    log?.('[katex] already linked');
    return;
  }

  // 1. Backup
  createBackup(htmlPath, 'katex', log);

  // 2. 注入 <link> — 紧跟在 workbench CSS link 之后
  const needle = '<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">';
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
}
