/**
 * LLM SDK 的 HTTP 代理支持
 *
 * 用 undici 包自己的 fetch + ProxyAgent 配对, 返回自定义 fetch 函数,
 * 传给 Anthropic / OpenAI SDK 的 opts.fetch 参数。
 *
 * TLS: 加载 Node.js 内置根证书 + 系统证书 (macOS 钥匙串 / Windows Crypt32 / Linux CA bundle),
 * 确保抓包软件 (Charles/mitmproxy) 的自签名 CA 被信任。
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import tls from 'node:tls'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { logger } from '../../logger'

// ── 系统证书读取 (内联自 @vscode/proxy-agent) ──

const LINUX_CA_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/ssl/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
]

function splitPemBundle(pem: string): string[] {
  return pem.split(/(?=-----BEGIN CERTIFICATE-----)/g).filter(c => c.trim().length > 0)
}

function readSystemCerts(): string[] {
  try {
    if (process.platform === 'darwin') {
      const stdout = execSync('/usr/bin/security find-certificate -a -p', { encoding: 'utf-8', timeout: 10_000 })
      return splitPemBundle(stdout)
    }
    if (process.platform === 'linux') {
      for (const p of LINUX_CA_PATHS) {
        try {
          return splitPemBundle(readFileSync(p, 'utf-8'))
        }
        catch {}
      }
    }
    // Windows: tls.rootCertificates 在 Node 20+ 已包含系统证书
  }
  catch (e) {
    logger.debug({ error: (e as Error).message }, '[PROXY] failed to read system certificates')
  }
  return []
}

let caCertsCache: string[] | null = null

function getCaCerts(): string[] {
  if (caCertsCache)
    return caCertsCache
  const nodeCerts = [...(tls.rootCertificates || [])]
  const sysCerts = readSystemCerts()
  const merged = [...new Set([...nodeCerts, ...sysCerts])]
  caCertsCache = merged
  logger.info({ node: nodeCerts.length, system: sysCerts.length, merged: merged.length }, '[PROXY] loaded CA certificates')
  return merged
}

// ── Proxy Fetch ──

/**
 * 若 proxyUrl 非空, 返回代理化的 fetch 函数供 SDK opts.fetch 使用。
 * 否则返回 undefined (不走代理, SDK 用默认 globalThis.fetch)。
 */
export function createProxiedFetch(proxyUrl: string | undefined): typeof globalThis.fetch | undefined {
  if (!proxyUrl)
    return undefined

  const ca = getCaCerts()
  const dispatcher = new ProxyAgent({
    uri: proxyUrl,
    requestTls: { ca },
  })
  logger.info({ proxyUrl, caCount: ca.length }, '[PROXY] creating proxied fetch for LLM SDK')

  return ((input: any, init?: any) =>
    undiciFetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch
}
