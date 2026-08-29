/** 深拷贝为纯对象：剥掉 Vue 响应式 Proxy（IndexedDB 结构化克隆不认 Proxy） */
export function deepPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}
