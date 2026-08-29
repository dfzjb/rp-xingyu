import { defineConfig } from 'vitest/config'

// 测试跑在 node 环境 + fake-indexeddb：覆盖 lib 引擎层与 db 持久化，不启动浏览器
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
