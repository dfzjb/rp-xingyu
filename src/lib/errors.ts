import { ref } from 'vue'

/** 全局错误收集：未捕获异常与 Promise 拒绝，供界面横幅显示（可观测性）。 */
export const globalErrors = ref<string[]>([])

let installed = false

export function installErrorHandlers() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (e) => {
    push(String((e as ErrorEvent).error?.stack || e.message || e))
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason
    push(String(r instanceof Error ? r.stack : r))
  })
}

export function pushGlobalError(text: string) {
  push(text)
}

function push(text: string) {
  const t = text.slice(0, 500)
  console.error('[rp-site]', t)
  if (!globalErrors.value.includes(t)) {
    globalErrors.value.push(t)
    // 只保留最近 5 条
    while (globalErrors.value.length > 5) globalErrors.value.shift()
  }
}
