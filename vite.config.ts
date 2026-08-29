import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base:'./' + 不用 history 路由：产物可部署在任意子路径（rp.dfzjb.site/new/）或离线文件打开
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 第三方库按生态分组缓存：业务代码迭代时 vendor 块哈希稳定，浏览器命中缓存
        manualChunks: {
          'vendor-vue': ['vue', 'pinia'],
          'vendor-ui': ['naive-ui'],
          'vendor-md': ['markdown-it', 'dompurify', 'highlight.js'],
          'vendor-db': ['dexie'],
          'vendor-icons': ['lucide-vue-next'],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
  },
})
