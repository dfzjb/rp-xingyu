/**
 * 战局状态（HallGameState）：当前区域 + 随身道具 + 关键记忆。
 * KP 在回复末尾用 <state> 标记自动维护（解析见 kp.ts），房主也可在侧栏手动增删；
 * 状态存房主战役文档、随快照/实时事件同步全员，并注入 KP 提示词——长团不丢记忆与道具。
 */
import { newEventId } from './protocol'

export interface HallItem {
  id: string
  name: string
  note: string // 数量/持有者/状态等备注
}

export interface HallMemory {
  id: string
  text: string
  at: number
}

export interface HallGameState {
  area: string // 玩家当前所在区域/场景
  items: HallItem[]
  memories: HallMemory[]
  updatedAt: number
}

/** 容量上限：防 KP 长团刷屏把状态撑爆，超限丢最旧 */
export const MAX_ITEMS = 30
export const MAX_MEMORIES = 20

export function emptyGameState(): HallGameState {
  return { area: '', items: [], memories: [], updatedAt: 0 }
}

export function isEmptyGameState(s: HallGameState | null | undefined): boolean {
  if (!s) return true
  return !s.area.trim() && s.items.length === 0 && s.memories.length === 0
}

/** KP 一次 <state> 上报的内容（字段均可缺省） */
export interface StateUpdate {
  area?: string
  add?: { name: string; note: string }[]
  remove?: string[]
  mem?: string[]
}

const clip = (v: unknown, n: number): string => String(v ?? '').trim().slice(0, n)

/** 宽容归一化任意来源（KP JSON / 同步快照 / 旧存档）的状态：非法字段丢弃、长度截断、补 id */
export function normalizeGameState(raw: unknown): HallGameState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const items = (Array.isArray(o.items) ? o.items : [])
    .map((it) => {
      const x = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
      return { id: clip(x.id, 40) || newEventId(), name: clip(x.name, 40), note: clip(x.note, 80) }
    })
    .filter((it) => it.name)
    .slice(0, MAX_ITEMS)
  const memories = (Array.isArray(o.memories) ? o.memories : [])
    .map((m) => {
      const x = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
      return { id: clip(x.id, 40) || newEventId(), text: clip(x.text, 160), at: Number(x.at) || 0 }
    })
    .filter((m) => m.text)
    .slice(0, MAX_MEMORIES)
  return { area: clip(o.area, 60), items, memories, updatedAt: Number(o.updatedAt) || 0 }
}

/**
 * 把一次状态变更合并进当前状态（返回新对象，不改入参）：
 * 地点取新值；道具按名去重（重名只更新备注）；记忆按文本去重；超限丢最旧。
 */
export function mergeStateUpdate(base: HallGameState | null | undefined, upd: StateUpdate): HallGameState {
  const cur = base ? normalizeGameState(base) : emptyGameState()
  const next: HallGameState = {
    area: upd.area !== undefined ? clip(upd.area, 60) : cur.area,
    items: cur.items.map((x) => ({ ...x })),
    memories: cur.memories.map((x) => ({ ...x })),
    updatedAt: Date.now(),
  }
  for (const it of upd.add || []) {
    const name = clip(it?.name, 40)
    if (!name) continue
    const note = clip(it?.note, 80)
    const exist = next.items.find((x) => x.name === name)
    if (exist) {
      if (note) exist.note = note
      continue
    }
    next.items.push({ id: newEventId(), name, note })
  }
  const removes = new Set((upd.remove || []).map((r) => clip(r, 40)).filter(Boolean))
  if (removes.size) next.items = next.items.filter((x) => !removes.has(x.name))
  for (const m of upd.mem || []) {
    const text = clip(m, 160)
    if (!text || next.memories.some((x) => x.text === text)) continue
    next.memories.push({ id: newEventId(), text, at: Date.now() })
  }
  if (next.items.length > MAX_ITEMS) next.items = next.items.slice(next.items.length - MAX_ITEMS)
  if (next.memories.length > MAX_MEMORIES) next.memories = next.memories.slice(next.memories.length - MAX_MEMORIES)
  return next
}

/** 忽略 updatedAt 的实质相等：无变化就不落库不广播 */
export function sameGameState(a: HallGameState | null | undefined, b: HallGameState | null | undefined): boolean {
  const sa = normalizeGameState(a)
  const sb = normalizeGameState(b)
  sa.updatedAt = sb.updatedAt = 0
  return JSON.stringify(sa) === JSON.stringify(sb)
}
