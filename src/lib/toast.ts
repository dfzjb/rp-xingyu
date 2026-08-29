import { ref } from 'vue'

export interface ToastItem {
  id: number
  type: 'info' | 'success' | 'warning' | 'error'
  text: string
}

const toasts = ref<ToastItem[]>([])
let seq = 0

function push(type: ToastItem['type'], text: string, ttl = 3200) {
  const id = ++seq
  toasts.value.push({ id, type, text })
  setTimeout(() => dismiss(id), ttl)
}

function dismiss(id: number) {
  const i = toasts.value.findIndex((t) => t.id === id)
  if (i >= 0) toasts.value.splice(i, 1)
}

export function useToasts() {
  return { toasts, dismiss }
}

export const toast = {
  info: (t: string) => push('info', t),
  success: (t: string) => push('success', t),
  warning: (t: string) => push('warning', t),
  error: (t: string) => push('error', t),
}
