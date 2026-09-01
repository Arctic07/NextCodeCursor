/**
 * exe 单文件入口 — NextCode 中转站一键安装器
 *
 * 用法:
 *   ccursor.exe                        → 在 exe 同目录找唯一 *.vsix 安装
 *   把 xxx.vsix 拖到 exe 图标上          → Windows 把 vsix 路径作为 argv[1] 传入
 *   ccursor.exe check|uninstall|status → 透传原版命令
 *
 * 实现原理:
 *   原版 install 从 <pkgRoot>/vsix/*.vsix 找插件包、从 <dist>/models-catalog.json 复制资产。
 *   单文件 exe 里无法依赖目录结构 → 通过环境变量 CCURSOR_VSIX_PATH / CCURSOR_ASSET_DIR
 *   (extension-embed.js / release-defaults.js 已支持) 直接指向用户提供的文件。
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const args = process.argv.slice(2)
const KNOWN = ['install', 'uninstall', 'update', 'status', 'check', 'local-mode', 'local-mode-off', 'help']

// 原命令透传: bun compile 下 argv = [bun, exe, ...args], cli.js 读 argv[2] → 需重排
if (args.length > 0 && KNOWN.includes(args[0])) {
  process.argv = [process.argv0, 'ccursor', ...args]
  await import('./cli.js')
  process.exit(0)
}

// 找 vsix: 参数指定 > exe 同目录唯一 vsix
const exeDir = dirname(process.execPath)
const drag = args.find(a => a.toLowerCase().endsWith('.vsix') && existsSync(a))
let vsixPath = drag
if (!vsixPath) {
  const candidates = existsSync(exeDir) ? readdirSync(exeDir).filter(f => f.toLowerCase().endsWith('.vsix')) : []
  if (candidates.length === 1)
    vsixPath = join(exeDir, candidates[0])
  else if (candidates.length > 1) {
    console.error(`[!] exe 目录有多个 .vsix, 请把要装的那个拖到 exe 图标上: ${candidates.join(', ')}`)
    process.exit(1)
  }
}
if (!vsixPath || !existsSync(vsixPath)) {
  console.error('[!] 未找到 .vsix 插件包。用法: 把 nextcode-cursor-x.x.x.vsix 拖到 ccursor.exe 图标上')
  process.exit(1)
}
console.log(`[i] 插件包: ${vsixPath}`)

// 环境变量直通 patch 流程
process.env.CCURSOR_VSIX_PATH = vsixPath
// 资产 (models-catalog.json): exe 同目录或其 assets/ 子目录
const assetCandidates = [join(exeDir, 'models-catalog.json'), join(exeDir, 'assets', 'models-catalog.json')]
const asset = assetCandidates.find(p => existsSync(p))
if (asset)
  process.env.CCURSOR_ASSET_DIR = dirname(asset)

// ── 双击运行防闪退 ──
// 结束后等回车, 错误完整显示; 未捕获异常/unhandledRejection 一并接管
function pause() {
  console.log('')
  process.stdout.write('按回车键关闭窗口...')
  return new Promise((resolve) => {
    process.stdin.once('data', () => resolve())
    process.stdin.resume()
  })
}

function showErr(err) {
  console.error('')
  console.error('[X] 安装出错:', err?.message || err)
  if (err?.stack)
    console.error(err.stack.split('\n').slice(0, 5).join('\n'))
  process.exitCode = 1
}

process.on('uncaughtException', showErr)
process.on('unhandledRejection', showErr)

const { install } = await import('./install.js')
try {
  await install()
}
catch (err) {
  showErr(err)
}
finally {
  await pause().catch(() => {})
}
