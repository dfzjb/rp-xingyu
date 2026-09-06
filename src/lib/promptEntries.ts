/**
 * 提示词条目通用工具：人称视角互斥。
 * 「第二人称」「第三人称」两条视角条目同时启用会自相矛盾，启用其一时自动关闭另一条。
 */
type EntryLike = { enabled?: boolean; name?: string }

function perspectiveOpposite(name: string | undefined): string | null {
  if (name === '第二人称') return '第三人称'
  if (name === '第三人称') return '第二人称'
  return null
}

/**
 * 强制人称互斥：列表中启用第二/第三人称其一时，自动关闭另一条（存量双开数据同样自愈）。
 * 在 settings.patch 写入 promptEntries 的路径上调用。
 */
export function enforcePerspectiveMutex<T extends EntryLike>(list: T[]): T[] {
  const onName = list.find((e) => e.enabled && perspectiveOpposite(e.name))?.name
  if (!onName) return list
  const opposite = perspectiveOpposite(onName)
  if (!opposite || !list.some((e) => e.name === opposite && e.enabled)) return list
  return list.map((e) => (e.name === opposite ? { ...e, enabled: false } : e))
}

/**
 * 更新单条预设条目并执行人称互斥：本次开启第二/第三人称其一时，自动关闭另一条。
 * 供预设面板开关走精确方向；列表写入后 settings.patch 里的 enforcePerspectiveMutex 兜底存量双开。
 */
export function applyPromptEntryPatch<T extends EntryLike>(list: T[], index: number, patch: Partial<T>): T[] {
  const next = [...list]
  next[index] = { ...next[index], ...patch }
  const target = next[index]
  const opposite = target.enabled ? perspectiveOpposite(target.name) : null
  if (!opposite) return next
  return next.map((e, i) => (i !== index && e.name === opposite ? { ...e, enabled: false } : e))
}
