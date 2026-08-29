import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base:'./' + 不用 history 路由：产物可部署在任意子路径（rp.dfzjb.site/new/）或离线文件打开
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
  },
})
