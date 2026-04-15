/**
 * LLM SDK 的 HTTP 代理支持
 *
 * 用 undici 包自己的 fetch + ProxyAgent 配对, 返回自定义 fetch 函数,
 * 传给 Anthropic / OpenAI SDK 的 opts.fetch 参数。
 *
 * 不使用 fetchOptions.dispatcher 路径, 因为 VS Code extension host 内置的
 * Node.js undici 版本 (v6) 与 npm 安装的版本可能不同, globalThis.fetch 对
 * 外部包的 ProxyAgent 做 instanceof Dispatcher 检查会失败, dispatcher 被静默忽略。
 *
 * 自定义 fetch 方案用同一个 undici 包里的 fetch + ProxyAgent, 不存在版本隔离问题。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { logger } from '../../logger'

/**
 * 若 proxyUrl 非空, 返回代理化的 fetch 函数供 SDK opts.fetch 使用。
 * 否则返回 undefined (不走代理, SDK 用默认 globalThis.fetch)。
 */
export function createProxiedFetch(proxyUrl: string | undefined): typeof globalThis.fetch | undefined {
  if (!proxyUrl)
    return undefined

  const dispatcher = new ProxyAgent({ uri: proxyUrl })
  logger.info({ proxyUrl }, '[PROXY] creating proxied fetch for LLM SDK')

  return ((input: any, init?: any) =>
    undiciFetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch
}
