/**
 * sync-relay.mjs — 把根目录 relay.config.json 同步到各构建产物
 *
 * 用法: node scripts/sync-relay.mjs
 *       node scripts/sync-relay.mjs --check   (CI 校验是否同步)
 *
 * 同步目标:
 *   - Cursor++/src/server/relay/branding.ts   (HUB_URL / NPM_PACKAGE 真源)
 *   - Cursor++/src/server/relay/preset.ts     (RELAY_PROVIDERS / RELAY_EXTRA_REDIRECT)
 *   - Cursor++/package.json                   (publisher/name/displayName/description)
 *   - installer/src/relay/branding.js         (INSTALLER hub/npm)
 *   - installer/src/relay/preset.js           (INSTALLER 预设 providers/redirect)
 *
 * 设计: 本脚本只做文本同步，不改 reducer/运行时逻辑。sync 后需自行 verify:
 *   pnpm -C Cursor++ check-types && node Cursor++/esbuild.js
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const checkOnly = process.argv.includes('--check')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

const configPath = join(ROOT, 'relay.config.json')
if (!existsSync(configPath)) {
  console.error(`[sync-relay] relay.config.json not found at ${configPath}`)
  process.exit(1)
}
const cfg = readJson(configPath)
const branding = cfg.branding ?? {}
const rawProviders = cfg.providers ?? []
const enabledProviders = rawProviders
  .filter(p => p && typeof p === 'object' && p._enabled === true)
  .map(({ _comment, _enabled, ...rest }) => rest)
const extraRedirect = cfg.extraRedirect ?? []

// ── 1. branding.ts ──
const brandingTsPath = join(__dirname, '..', 'src', 'server', 'relay', 'branding.ts')
const brandingTs = `/**
 * Relay Branding — 中转站品牌单一真源
 *
 * 由 relay.config.json + scripts/sync-relay.mjs 自动生成。请勿手改，改 relay.config.json。
 * 同步: node Cursor++/scripts/sync-relay.mjs
 */

export const RELAY_BRANDING = {
  publisher: ${JSON.stringify(branding.publisher ?? 'cometix-space')},
  name: ${JSON.stringify(branding.name ?? 'cursor2plus')},
  displayName: ${JSON.stringify(branding.displayName ?? 'Cursor++')},
  description: ${JSON.stringify(branding.description ?? 'Cursor++ BYOK Extension — Bring Your Own Key for Cursor IDE')},
  hubUrl: ${JSON.stringify(branding.hubUrl ?? 'https://ccursor.cometix.dev')},
  npmPackage: ${JSON.stringify(branding.npmPackage ?? '@cometix/ccursor')},
  updateCommand: ${JSON.stringify(branding.updateCommand ?? 'npx @cometix/ccursor update')},
} as const

export const HUB_URL = RELAY_BRANDING.hubUrl
export const NPM_PACKAGE = RELAY_BRANDING.npmPackage
export const UPDATE_COMMAND = RELAY_BRANDING.updateCommand
`

// ── 2. preset.ts ──
const presetTsPath = join(__dirname, '..', 'src', 'server', 'relay', 'preset.ts')
const providersLiteral = JSON.stringify(enabledProviders, null, 2)
const presetTs = `/**
 * Relay Preset — 中转站预设 Provider / Route 配置
 *
 * 由 relay.config.json + scripts/sync-relay.mjs 自动生成。请勿手改，改 relay.config.json。
 * 同步: node Cursor++/scripts/sync-relay.mjs
 */

import type { ProviderEntry } from '../data/defaults'

export const RELAY_PROVIDERS: ProviderEntry[] = ${providersLiteral}

export const RELAY_EXTRA_REDIRECT: readonly string[] = ${JSON.stringify(extraRedirect, null, 2)}
`

// ── 3. Cursor++/package.json (publisher/name/displayName/description + 品牌标题) ──
// 命令/配置/活动栏视图标题统一使用 branding.displayName, 防止品牌残留 (如 Cursor++)
const extPkgPath = join(__dirname, '..', 'package.json')
const extPkg = readJson(extPkgPath)
const displayBrand = branding.displayName ?? extPkg.displayName ?? 'Cursor++'
const retitleContributes = (pkg) => {
  const next = { ...pkg }
  if (next.contributes) {
    const c = { ...next.contributes }
    if (Array.isArray(c.commands))
      c.commands = c.commands.map(cmd => ({ ...cmd, ...(typeof cmd.title === 'string' ? { title: cmd.title.replace(/Cursor\+\+/g, displayBrand) } : {}) }))
    if (c.configuration && typeof c.configuration.title === 'string')
      c.configuration = { ...c.configuration, title: c.configuration.title.replace(/Cursor\+\+/g, displayBrand) }
    if (c.viewsContainers) {
      c.viewsContainers = Object.fromEntries(Object.entries(c.viewsContainers).map(([k, arr]) => [k, arr.map(v => (typeof v.title === 'string' ? { ...v, title: v.title.replace(/Cursor\+\+/g, displayBrand) } : v))]))
    }
    next.contributes = c
  }
  return next
}
const extPkgNext = retitleContributes({
  ...extPkg,
  publisher: branding.publisher ?? extPkg.publisher,
  name: branding.name ?? extPkg.name,
  displayName: branding.displayName ?? extPkg.displayName,
  description: branding.description ?? extPkg.description,
})

// ── 4. installer/src/relay/branding.js ──
const installerBrandingPath = join(ROOT, 'installer', 'src', 'relay', 'branding.js')
const installerBrandingJs = `/**
 * Relay Branding (installer) — 由 relay.config.json + scripts/sync-relay.mjs 自动生成
 * 请勿手改，改 relay.config.json
 */
export const HUB_URL = ${JSON.stringify(branding.hubUrl ?? 'https://ccursor.cometix.dev')};
export const NPM_PACKAGE = ${JSON.stringify(branding.npmPackage ?? '@cometix/ccursor')};
export const UPDATE_COMMAND = ${JSON.stringify(branding.updateCommand ?? 'npx @cometix/ccursor update')};
`

// ── 5. installer/src/relay/preset.js ──
const installerPresetPath = join(ROOT, 'installer', 'src', 'relay', 'preset.js')
const installerPresetJs = `/**
 * Relay Preset (installer) — 由 relay.config.json + scripts/sync-relay.mjs 自动生成
 * 请勿手改，改 relay.config.json
 */
export const RELAY_PROVIDERS = ${JSON.stringify(enabledProviders, null, 2)};

export const RELAY_EXTRA_REDIRECT = ${JSON.stringify(extraRedirect, null, 2)};
`

function writeOrCheck(path, next) {
  const prev = existsSync(path) ? readFileSync(path, 'utf-8') : null
  if (checkOnly) {
    if (prev !== next) {
      console.error(`[sync-relay] OUT OF DATE: ${path} — run: node Cursor++/scripts/sync-relay.mjs`)
      process.exitCode = 1
    }
    return false
  }
  if (prev === next) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, next, 'utf-8')
  console.log(`[sync-relay] wrote ${path}`)
  return true
}

let changed = false
changed = writeOrCheck(brandingTsPath, brandingTs) || changed
changed = writeOrCheck(presetTsPath, presetTs) || changed

// package.json 需保留格式化（2空格）并比较 JSON 语义
{
  const prev = JSON.stringify(extPkg)
  const next = JSON.stringify(extPkgNext)
  if (prev !== next) {
    if (checkOnly) {
      console.error(`[sync-relay] OUT OF DATE: ${extPkgPath}`)
      process.exitCode = 1
    } else {
      writeFileSync(extPkgPath, JSON.stringify(extPkgNext, null, 2) + '\n', 'utf-8')
      console.log(`[sync-relay] wrote ${extPkgPath}`)
      changed = true
    }
  }
}

changed = writeOrCheck(installerBrandingPath, installerBrandingJs) || changed
changed = writeOrCheck(installerPresetPath, installerPresetJs) || changed

if (checkOnly) {
  if (process.exitCode === 1) {
    console.error('[sync-relay] check failed — relay.config.json 与生成文件不一致')
  } else {
    console.log('[sync-relay] check ok — all generated files up to date')
  }
} else if (!changed) {
  console.log('[sync-relay] no changes')
} else {
  console.log('[sync-relay] done — 请检查改动后提交')
}
