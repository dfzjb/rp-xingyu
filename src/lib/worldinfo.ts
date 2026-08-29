/**
 * 世界书引擎（SillyTavern 语义兼容）：
 * 常驻/关键词/次要过滤词+逻辑/概率/扫描深度/@深度注入/递归激活。
 */
export interface WorldInfoEntry {
  comment?: string
  content?: string
  enabled?: boolean
  keys?: string[]
  key?: string | string[]
  secondaryKeys?: string[]
  selectiveLogic?: 'AND_ANY' | 'AND_ALL' | 'NOT_ANY' | 'NOT_ALL'
  useRegex?: boolean
  caseSensitive?: boolean
  matchWholeWords?: boolean
  constant?: boolean
  position?: string | number
  depth?: number
  depthRole?: 'system' | 'user' | 'assistant'
  order?: number
  scanDepth?: number
  probability?: number
  useProbability?: boolean
  [k: string]: unknown
}

export type WILogic = NonNullable<WorldInfoEntry['selectiveLogic']>

export interface ActivatedEntry {
  content: string
  comment: string
  order: number
  placement: 'before_char' | 'after_char' | 'depth'
  depth: number
  depthRole: 'system' | 'user' | 'assistant'
}

function entryPrimaryKeys(e: WorldInfoEntry): string[] {
  if (Array.isArray(e.keys)) return e.keys.map(String).filter(Boolean)
  if (typeof e.key === 'string') return [e.key]
  if (Array.isArray(e.key)) return e.key.map(String).filter(Boolean)
  return []
}

function entrySecondaryKeys(e: WorldInfoEntry): string[] {
  if (Array.isArray(e.secondaryKeys)) return e.secondaryKeys.map(String).filter(Boolean)
  return []
}

function entryLogic(e: WorldInfoEntry): WILogic {
  const raw = String(e.selectiveLogic ?? '').toUpperCase()
  if (raw === 'AND_ALL') return 'AND_ALL'
  if (raw === 'NOT_ANY') return 'NOT_ANY'
  if (raw === 'NOT_ALL') return 'NOT_ALL'
  return 'AND_ANY'
}

function keyMatcher(k: string, e: WorldInfoEntry, text: string): boolean {
  let useRegex = !!e.useRegex
  let pattern = k
  let flags = 'gi'
  const m = k.match(/^\/(.+)\/([a-z]*)$/s)
  if (m) { useRegex = true; pattern = m[1]; flags = m[2] || 'i' }
  if (useRegex) {
    try { return new RegExp(pattern, flags.includes('g') ? flags : flags + 'g').test(text) } catch { return false }
  }
  if (e.matchWholeWords === true) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\b${esc}\\b`, e.caseSensitive ? '' : 'i').test(text)
  }
  return e.caseSensitive === true ? text.includes(k) : text.toLowerCase().includes(k.toLowerCase())
}

function primaryHit(e: WorldInfoEntry, text: string): boolean {
  const keys = entryPrimaryKeys(e)
  return keys.length > 0 && keys.some((k) => keyMatcher(k, e, text))
}

function secondaryPass(e: WorldInfoEntry, text: string): boolean {
  const sec = entrySecondaryKeys(e)
  if (!sec.length) return true
  const hits = sec.map((k) => keyMatcher(k, e, text))
  switch (entryLogic(e)) {
    case 'AND_ALL': return hits.every(Boolean)
    case 'NOT_ANY': return !hits.some(Boolean)
    case 'NOT_ALL': return !hits.every(Boolean)
    default: return hits.some(Boolean)
  }
}

function probPass(e: WorldInfoEntry): boolean {
  if (!e.useProbability && typeof e.probability !== 'number') return true
  const p = typeof e.probability === 'number' ? Math.max(0, Math.min(100, e.probability)) : 100
  return p >= 100 || Math.random() * 100 < p
}

interface Activated { entry: WorldInfoEntry; placement: 'before_char' | 'after_char' | 'depth'; depth: number; depthRole: 'system' | 'user' | 'assistant' }

function toActivated(e: WorldInfoEntry): Activated {
  let placement: Activated['placement'] = 'after_char'
  if (e.position === 'before_char' || e.position === 0) placement = 'before_char'
  else if (typeof e.position === 'string' && String(e.position).startsWith('@')) placement = 'depth'
  else if (typeof e.position === 'number' && (e.position === 3 || e.position === 4)) placement = 'depth'
  return { entry: e, placement, depth: typeof e.depth === 'number' ? e.depth : 4, depthRole: (e.depthRole as any) || 'system' }
}

export interface WIResult {
  beforeChar: string[]
  afterChar: string[]
  byDepth: { depth: number; role: 'system' | 'user' | 'assistant'; content: string }[]
}

export function resolveWorldInfo(
  entries: WorldInfoEntry[],
  recentMessages: string[],
  maxRecursionSteps = 0,
): WIResult {
  const active = entries.filter((e) => e && e.enabled !== false && String(e.content || '').trim())
  const maxScan = Math.max(2, ...active.map((e) => typeof e.scanDepth === 'number' ? e.scanDepth : 2))

  const activatedSet = new Set<WorldInfoEntry>()
  const activatedList: Activated[] = []

  function tryActivate(e: WorldInfoEntry, source: string[]): boolean {
    if (activatedSet.has(e)) return false
    const d = typeof e.scanDepth === 'number' ? e.scanDepth : maxScan
    const windowText = source.slice(-Math.max(1, d)).join('\n')
    if (!primaryHit(e, windowText) && !e.constant) return false
    if (!secondaryPass(e, windowText)) return false
    if (!probPass(e)) return false
    activatedSet.add(e)
    activatedList.push(toActivated(e))
    return true
  }

  // 第一轮：基于消息文本
  for (const e of active) { tryActivate(e, recentMessages) }

  // 递归轮：已激活条目的内容作为新扫描文本（逐轮累积，直到不再有新激活）
  for (let step = 0; step < maxRecursionSteps; step++) {
    const texts = activatedList.map((a) => a.entry.content).join('\n')
    if (!texts.trim()) break
    let anyNew = false
    for (const e of active) {
      if (activatedSet.has(e)) continue
      if (tryActivate(e, [texts])) anyNew = true
    }
    if (!anyNew) break
  }

  // 分组输出
  const beforeChar: string[] = []
  const afterChar: string[] = []
  const byDepth: { depth: number; role: 'system' | 'user' | 'assistant'; content: string }[] = []

  const sorted = [...activatedList].sort((a, b) => (a.entry.order ?? 100) - (b.entry.order ?? 100))
  for (const a of sorted) {
    const content = String(a.entry.content || '').trim()
    if (!content) continue
    if (a.placement === 'before_char') beforeChar.push(content)
    else if (a.placement === 'after_char') afterChar.push(content)
    else byDepth.push({ depth: a.depth, role: a.depthRole, content })
  }
  byDepth.sort((a, b) => a.depth - b.depth)

  return { beforeChar, afterChar, byDepth }
}
