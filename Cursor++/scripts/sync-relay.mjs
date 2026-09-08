/**
 * sync-relay.mjs — 把根目录 relay.config.json 同步到各构建产物
 *
 * 用法: node scripts/sync-relay.mjs
 *       node scripts/sync-relay.mjs --check   (CI 校验是否同步)
 *
 * 同步目标:
 *   - Cursor++/src/server/relay/branding.ts   (HUB_URL / API_BASE_URL / MODEL_REGISTRY_URL 真源)
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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isHttpUrl(value) {
  if (!isNonEmptyString(value)) return false
  try {
    const parsed = new URL(value.trim())
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isNonEmptyString(parsed.hostname)
  } catch {
    return false
  }
}

function requireHttpUrl(value, location) {
  if (!isHttpUrl(value))
    configError(`${location} must be a valid http/https URL`)
  return value.trim()
}
// Keep this in sync with src/server/relay/modelIdentity.ts without importing TypeScript.
function normalizeRelayModelId(raw) {
  if (typeof raw !== 'string') return ''
  const segments = raw.trim().split('/')
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index].trim()
    if (segment) return segment.toLowerCase()
  }
  return ''
}

function configError(message) {
  throw new Error(`[sync-relay] ${message}`)
}

if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg))
  configError('config must be an object')

const rawBranding = cfg.branding
if (rawBranding !== undefined && (rawBranding === null || typeof rawBranding !== 'object' || Array.isArray(rawBranding)))
  configError('branding must be an object')
const branding = rawBranding === undefined ? {} : rawBranding
const hubUrl = requireHttpUrl(branding.hubUrl === undefined ? 'https://ccursor.cometix.dev' : branding.hubUrl, 'branding.hubUrl')
const apiBaseUrl = requireHttpUrl(branding.apiBaseUrl === undefined ? `${hubUrl.replace(/\/+$/, '')}/v1` : branding.apiBaseUrl, 'branding.apiBaseUrl')
const modelRegistryUrl = requireHttpUrl(branding.modelRegistryUrl, 'branding.modelRegistryUrl')

const rawProviders = cfg.providers === undefined ? [] : cfg.providers
if (!Array.isArray(rawProviders))
  configError('providers must be an array')

const providerTypes = new Set(['anthropic', 'openai-chat', 'openai-responses', 'gemini'])
const authKinds = new Set(['apiKey', 'token'])
const providerIds = new Map()
const modelIds = new Map()
const apiModelIds = new Map()
const enabledProviders = []

for (const [providerIndex, provider] of rawProviders.entries()) {
  if (provider === null || typeof provider !== 'object' || provider._enabled !== true)
    continue
  if (Array.isArray(provider))
    configError(`enabled provider at providers[${providerIndex}] must be an object`)

  const providerLocation = `providers[${providerIndex}]`
  if (!isNonEmptyString(provider.id))
    configError(`enabled provider ${providerLocation}.id must be a non-empty string`)

  const previousProvider = providerIds.get(provider.id)
  if (previousProvider) {
    configError(`duplicate provider.id ${JSON.stringify(provider.id)} at ${providerLocation}.id; already used at ${previousProvider}.id`)
  }
  providerIds.set(provider.id, providerLocation)

  if (!providerTypes.has(provider.type))
    configError(`enabled provider ${providerLocation}.type must be one of anthropic, openai-chat, openai-responses, gemini`)

  const normalizedBaseUrl = requireHttpUrl(provider.baseUrl, `${providerLocation}.baseUrl`)

  if (provider.auth === null || typeof provider.auth !== 'object' || Array.isArray(provider.auth))
    configError(`enabled provider ${providerLocation}.auth must be an object`)
  if (!authKinds.has(provider.auth.kind))
    configError(`enabled provider ${providerLocation}.auth.kind must be apiKey or token`)
  if (typeof provider.auth.value !== 'string')
    configError(`enabled provider ${providerLocation}.auth.value must be a string`)

  if (!Array.isArray(provider.models))
    configError(`enabled provider ${providerLocation}.models must be an array`)

  for (const [modelIndex, model] of provider.models.entries()) {
    const modelLocation = `${providerLocation}.models[${modelIndex}]`
    if (model === null || typeof model !== 'object' || Array.isArray(model))
      configError(`enabled provider ${providerLocation} model ${modelLocation} must be an object`)

    for (const field of ['id', 'apiModel', 'displayName']) {
      if (!isNonEmptyString(model[field]))
        configError(`enabled provider ${providerLocation} model ${modelLocation}.${field} must be a non-empty string`)
    }

    const previousModel = modelIds.get(model.id)
    if (previousModel) {
      configError(`duplicate model.id ${JSON.stringify(model.id)} at ${modelLocation}.id (provider ${JSON.stringify(provider.id)}); already used at ${previousModel.location}.id (provider ${JSON.stringify(previousModel.providerId)})`)
    }
    modelIds.set(model.id, { location: modelLocation, providerId: provider.id })

    const normalizedApiModel = normalizeRelayModelId(model.apiModel)
    if (!normalizedApiModel)
      configError(`enabled provider ${providerLocation} model ${modelLocation}.apiModel ${JSON.stringify(model.apiModel)} normalizes to an empty value`)
    const previousApiModel = apiModelIds.get(normalizedApiModel)
    if (previousApiModel) {
      configError(`duplicate normalized apiModel ${JSON.stringify(normalizedApiModel)} at ${modelLocation}.apiModel (provider ${JSON.stringify(provider.id)}, value ${JSON.stringify(model.apiModel)}); already used at ${previousApiModel.location}.apiModel (provider ${JSON.stringify(previousApiModel.providerId)}, value ${JSON.stringify(previousApiModel.value)})`)
    }
    apiModelIds.set(normalizedApiModel, {
      location: modelLocation,
      providerId: provider.id,
      value: model.apiModel,
    })
  }

  const { _comment, _enabled, ...rest } = provider
  enabledProviders.push({ ...rest, baseUrl: normalizedBaseUrl })
}
const rawExtraRedirect = cfg.extraRedirect === undefined ? [] : cfg.extraRedirect
if (!Array.isArray(rawExtraRedirect))
  configError('extraRedirect must be an array')
const extraRedirect = []
const extraRedirectSeen = new Set()
for (const [redirectIndex, redirect] of rawExtraRedirect.entries()) {
  if (!isNonEmptyString(redirect))
    configError(`extraRedirect[${redirectIndex}] must be a non-empty string`)
  const normalizedRedirect = redirect.trim()
  if (extraRedirectSeen.has(normalizedRedirect)) continue
  extraRedirectSeen.add(normalizedRedirect)
  extraRedirect.push(normalizedRedirect)
}

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
  hubUrl: ${JSON.stringify(hubUrl)},
  apiBaseUrl: ${JSON.stringify(apiBaseUrl)},
  modelRegistryUrl: ${JSON.stringify(modelRegistryUrl)},
  npmPackage: ${JSON.stringify(branding.npmPackage ?? '@cometix/ccursor')},
  updateCommand: ${JSON.stringify(branding.updateCommand ?? 'npx @cometix/ccursor update')},
} as const

/** VS Code 扩展完整 id (publisher.name)，供 installer allowlist 注入等消费 */
export const EXTENSION_ID = ${JSON.stringify((branding.publisher ?? 'cometix-space') + '.' + (branding.name ?? 'cursor2plus'))}

export const HUB_URL = RELAY_BRANDING.hubUrl
export const MODEL_REGISTRY_URL = RELAY_BRANDING.modelRegistryUrl
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
export const HUB_URL = ${JSON.stringify(hubUrl)};
export const API_BASE_URL = ${JSON.stringify(apiBaseUrl)};
export const MODEL_REGISTRY_URL = ${JSON.stringify(modelRegistryUrl)};
export const NPM_PACKAGE = ${JSON.stringify(branding.npmPackage ?? '@cometix/ccursor')};
export const UPDATE_COMMAND = ${JSON.stringify(branding.updateCommand ?? 'npx @cometix/ccursor update')};
/** VS Code 扩展完整 id (publisher.name)，供 installer allowlist 注入等消费 */
export const EXTENSION_ID = ${JSON.stringify((branding.publisher ?? 'cometix-space') + '.' + (branding.name ?? 'cursor2plus'))};
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

// ── 6. installer/package.json (@nextcode/ccursor，与 branding.npmPackage 对齐) ──
// bin 名保持 ccursor 不变，避免破坏已发布的 npx 命令习惯。
const installerPkgPath = join(ROOT, 'installer', 'package.json')
const installerPkg = readJson(installerPkgPath)
const installerPkgNext = {
  ...installerPkg,
  name: branding.npmPackage ?? installerPkg.name,
  description: (branding.description ?? installerPkg.description).replace(/Cursor\+\+/g, branding.displayName ?? 'Cursor++'),
}

function writeOrCheck(path, next) {
  const prev = existsSync(path) ? readFileSync(path, 'utf-8') : null
  const normalizedPrev = prev?.replace(/\r\n/g, '\n')
  const normalizedNext = next.replace(/\r\n/g, '\n')
  if (checkOnly) {
    if (normalizedPrev !== normalizedNext) {
      console.error(`[sync-relay] OUT OF DATE: ${path} — run: node Cursor++/scripts/sync-relay.mjs`)
      process.exitCode = 1
    }
    return false
  }
  if (normalizedPrev === normalizedNext) return false
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
changed = writeOrCheck(installerPkgPath, JSON.stringify(installerPkgNext, null, 2) + '\n') || changed
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
