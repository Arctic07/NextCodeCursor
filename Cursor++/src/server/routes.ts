/**
 * 兼容垫片 — 历史代码引用 ./routes 取 routes.json 路径或加载内容。
 *
 * 实际实现已迁移到:
 *   - config/paths.ts —— 路径常量
 *   - config/routesStore.ts —— 单项原子读写
 *   - data/defaults.ts —— 默认值
 */
export { getRoutesFilePath } from './config/paths'
export { loadRoutes } from './config/routesStore'
export type { RoutesConfig } from './data/defaults'
