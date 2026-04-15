/**
 * Hub URL 配置
 *
 * 开发时 → http://127.0.0.1:19960
 * 生产构建 → https://ccursor.cometix.dev (esbuild --production 时 define 注入)
 *
 * 不走 vscode settings,字符串在 js-confuser 的 StringConcealing 下不可见。
 */
// 由 esbuild define 在 build 时替换
declare const __HUB_URL__: string | undefined

export const HUB_URL: string = typeof __HUB_URL__ !== 'undefined'
  ? __HUB_URL__
  : 'http://127.0.0.1:19960'

export const SECRETS_JWT_KEY = 'cursor2plus.hub.jwt'
