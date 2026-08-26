import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/server/tests/**/*.test.ts'],
    exclude: ['src/test/**', 'dist/**', 'node_modules/**'],
    // 全局 setup: 注入合成 providers,让所有测试里出现的 modelId
    // 都能命中 providersStore 反向索引 (不再走静默 anthropic fallback)。
    setupFiles: ['src/server/tests/setup.ts'],
  },
})
