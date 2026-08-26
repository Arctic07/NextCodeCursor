/** Webview 入口 — Alpine.js 初始化 */
import type { Alpine as AlpineType } from 'alpinejs'
import Alpine from 'alpinejs'
import { initApp } from './app'

initApp(Alpine as unknown as AlpineType)
Alpine.start()
