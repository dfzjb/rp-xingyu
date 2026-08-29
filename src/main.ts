import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles.css'
import { installErrorHandlers, pushGlobalError } from './lib/errors'

installErrorHandlers()
const app = createApp(App)
// 组件渲染/生命周期错误默认走 console，不触发 window error —— 在这里接住并可见化
app.config.errorHandler = (err, _inst, info) => {
  const e = err as Error
  pushGlobalError(`${e?.message ?? String(err)}\n${e?.stack ?? ''}\n[info: ${info}]`)
}
app.use(createPinia()).mount('#app')
