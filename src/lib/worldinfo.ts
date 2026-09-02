/**
 * 世界书引擎（SillyTavern 语义兼容 + 旧版字段归一）：
 * 常驻/关键词/次要过滤词+逻辑/概率/扫描深度/@深度注入/递归激活。
 *
 * 数据进入引擎前一律先过 normalizeWorldInfoEntry：把 ST v2/v3 卡、旧版备份、
 * 编辑器产出的异构字段（extensions 嵌套、snake/camel、字符串/数字位置编码）
 * 归一到统一内部模型，避免「字段对不上 → 静默落默认值」。
 */
export interface WorldInfoEntry {
  id?: string
  comment?: string
  content?: string
  enabled?: boolean
  keys?: string[]
  key?: string | string[]
  secondaryKeys?: string[]
  selectiveLogic?: 'AND_ANY' | 'AND_ALL' | 'NOT_ANY' | 'NOT_ALL' | number
  useRegex?: boolean
  caseSensitive?: boolean
  matchWholeWords?: boolean
  constant?: boolean
  /** 归一后统一为 'before_char' | 'after_char' | 'at_depth'；原始输入也可被 toActivated 防御性识别 */
  position?: string | number
  depth?: number
  depthRole?: 'system' | 'user' | 'assistant' | number
  order?: number
  scanDepth?: number
  probability?: number
  useProbability?: boolean
  [k: string]: unknown
}

export type WILogic = 'AND_ANY' | 'AND_ALL' | 'NOT_ANY' | 'NOT_ALL'

export interface ActivatedEntry {
  content: string
  comment: string
  order: number
  placement: 'before_char' | 'after_char' | 'depth'
  depth: number
  depthRole: 'system' | 'user' | 'assistant'
}

// ── 归一化层（防腐层，对齐旧版 normalizeWorldInfoEntry）──

function toBool(v: unknown, dflt = false): boolean {
  if (v === undefined || v === null || v === '') return dflt
  if (typeof v === 'string') {
    if (v.toLowerCase() === 'false') return false
    if (v.toLowerCase() === 'true') return true
  }
  return !!v
}

function toNum(v: unknown, dflt?: number): number | undefined {
  if (v === undefined || v === null || v === '') return dflt
  const n = Number(v)
  return Number.isNaN(n) ? dflt : n
}

function splitKeys(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
  return []
}

const POS_ALIAS: Record<string, string> = {
  before_char: 'before_char',
  before_character: 'before_char',
  character_top: 'before_char',
  before_examples: 'before_char',
  example_top: 'before_char',
  // 新站无 system_top / global_note（作者注/系统顶）位置，语义最接近角色定义前
  system_top: 'before_char',
  global_note: 'before_char',
  an_top: 'before_char',
  author_note: 'before_char',
  after_char: 'after_char',
  after_character: 'after_char',
  character_bottom: 'after_char',
  after_examples: 'after_char',
  example_bottom: 'after_char',
  an_bottom: 'after_char',
  // 新站无 user_top / assistant_top 位置，落到角色定义后
  user_top: 'after_char',
  assistant_top: 'after_char',
  at_depth: 'at_depth',
  em_depth: 'at_depth',
  '@depth': 'at_depth',
}

/**
 * 把任意来源的世界书条目归一为内部模型。
 * @param source 'st' = SillyTavern 卡（数字编码 0/1/2/3/4 中 2/3/4 均为 at_depth）；
 *               'legacy' = 旧版备份（数字 2/3 = global_note → before_char，4 = at_depth）
 */
export function normalizeWorldInfoEntry(raw: unknown, source: 'st' | 'legacy' = 'st'): WorldInfoEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  // ST v3 大量字段嵌在 extensions 内，先拍平（顶层字段优先）
  const ext = (r.extensions && typeof r.extensions === 'object' ? r.extensions : {}) as Record<string, unknown>
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (r[k] !== undefined && r[k] !== null) return r[k]
      if (ext[k] !== undefined && ext[k] !== null) return ext[k]
    }
    return undefined
  }

  // ── 位置归一 ──
  let position = 'after_char'
  const rawPos = pick('position')
  if (typeof rawPos === 'string') {
    const p = rawPos.toLowerCase().replace(/ /g, '_')
    if (p.startsWith('@')) position = 'at_depth'
    else position = POS_ALIAS[p] ?? (/depth/.test(p) ? 'at_depth' : 'after_char')
  } else if (typeof rawPos === 'number' || (typeof rawPos === 'string' && rawPos.trim() !== '' && !Number.isNaN(Number(rawPos)))) {
    const n = Number(rawPos)
    if (n === 0) position = 'before_char'
    else if (n === 1) position = 'after_char'
    else if (n === 4) position = 'at_depth'
    else if (n === 2 || n === 3) position = source === 'legacy' ? 'before_char' : 'at_depth'
  }
  // 编辑器产出的 '@4' 形式
  if (typeof r.position === 'string' && String(r.position).startsWith('@')) position = 'at_depth'

  // ── depthRole 归一（ST 数字：0 system,1 user,2 assistant）──
  let depthRole: WorldInfoEntry['depthRole'] = 'system'
  const rawRole = pick('depthRole', 'depth_role', 'role')
  if (rawRole === 'user' || rawRole === 1) depthRole = 'user'
  else if (rawRole === 'assistant' || rawRole === 2) depthRole = 'assistant'

  // ── 选择逻辑归一（ST 数字：0 AND_ANY,1 AND_ALL,2 NOT_ANY,3 NOT_ALL）──
  let selectiveLogic: WorldInfoEntry['selectiveLogic'] = 'AND_ANY'
  const rawLogic = pick('selectiveLogic', 'selective_logic')
  const logicMap = ['AND_ANY', 'AND_ALL', 'NOT_ANY', 'NOT_ALL'] as const
  if (typeof rawLogic === 'number' && rawLogic >= 0 && rawLogic <= 3) selectiveLogic = logicMap[rawLogic]
  else {
    const up = String(rawLogic ?? '').toUpperCase()
    if ((logicMap as readonly string[]).includes(up)) selectiveLogic = up as WILogic
  }

  const content = String(pick('content', 'entry', 'text') ?? '')
  const entry: WorldInfoEntry = {
    id: (r.id as string) || (r.uid as string) || undefined,
    comment: String(pick('comment', 'name', 'title') ?? ''),
    content,
    enabled: toBool(pick('enabled'), true) && !toBool(pick('disable', 'disabled'), false),
    keys: splitKeys(pick('keys', 'key', 'keywords')),
    secondaryKeys: splitKeys(pick('secondaryKeys', 'secondary_keys', 'keysecondary')),
    selectiveLogic,
    useRegex: toBool(pick('useRegex', 'use_regex')),
    caseSensitive: toBool(pick('caseSensitive', 'case_sensitive')),
    matchWholeWords: toBool(pick('matchWholeWords', 'match_whole_words', 'wholeWords')),
    constant: toBool(pick('constant')),
    position,
    depth: toNum(pick('depth'), 4) as number,
    depthRole,
    order: toNum(pick('order', 'insertion_order', 'insertionOrder'), 100) as number,
    scanDepth: toNum(pick('scanDepth', 'scan_depth')),
    probability: toNum(pick('probability')),
    useProbability: toBool(pick('useProbability', 'use_probability')),
  }
  return entry
}

export function normalizeWorldInfoList(raw: unknown, source: 'st' | 'legacy' = 'st'): WorldInfoEntry[] {
  const book = raw as Record<string, unknown> | null | undefined
  // ST character_book.entries 结构 / 裸数组 / {entries:{}} 字典
  let list: unknown = raw
  if (book && !Array.isArray(raw)) {
    if (Array.isArray(book.entries)) list = book.entries
    else if (book.entries && typeof book.entries === 'object') list = Object.values(book.entries)
  }
  if (!Array.isArray(list)) return []
  return list.map((e) => normalizeWorldInfoEntry(e, source)).filter((e): e is WorldInfoEntry => !!e)
}

// ── 匹配引擎 ──

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

/** 位置 → 注入分组（防御性识别，正常数据已在 normalize 阶段归一） */
function toActivated(e: WorldInfoEntry): Activated {
  let placement: Activated['placement'] = 'after_char'
  const pos = e.position
  if (pos === 'before_char' || pos === 0) placement = 'before_char'
  else if (pos === 'at_depth' || (typeof pos === 'string' && String(pos).startsWith('@'))) placement = 'depth'
  else if (typeof pos === 'number' && pos >= 2) placement = 'depth'
  let depthRole: Activated['depthRole'] = 'system'
  if (e.depthRole === 'user' || e.depthRole === 1) depthRole = 'user'
  else if (e.depthRole === 'assistant' || e.depthRole === 2) depthRole = 'assistant'
  return { entry: e, placement, depth: typeof e.depth === 'number' ? e.depth : 4, depthRole }
}

export interface WIResult {
  beforeChar: string[]
  afterChar: string[]
  byDepth: { depth: number; role: 'system' | 'user' | 'assistant'; content: string; comment: string; order: number }[]
}

/** 默认递归激活步数（对齐旧版链式激活体验；0 = 关闭递归） */
export const DEFAULT_WI_RECURSION_STEPS = 3

/**
 * 解析世界书激活结果。
 * @param entries 条目（建议先过 normalizeWorldInfoList；内部会对漏网条目做一次轻量归一）
 * @param recentMessages 扫描文本序列（按楼层顺序，元素为该层正文；用户+AI 全部消息）
 * @param maxRecursionSteps 递归激活步数，默认 3
 */
export function resolveWorldInfo(
  entries: WorldInfoEntry[],
  recentMessages: string[],
  maxRecursionSteps: number = DEFAULT_WI_RECURSION_STEPS,
): WIResult {
  const normalized = (entries || [])
    .map((e) => (e && (e.position === 'before_char' || e.position === 'after_char' || e.position === 'at_depth') ? e : normalizeWorldInfoEntry(e)))
    .filter((e): e is WorldInfoEntry => !!e)
  const active = normalized.filter((e) => e.enabled !== false && String(e.content || '').trim())
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
  const byDepth: WIResult['byDepth'] = []

  const sorted = [...activatedList].sort((a, b) => (a.entry.order ?? 100) - (b.entry.order ?? 100))
  for (const a of sorted) {
    const content = String(a.entry.content || '').trim()
    if (!content) continue
    if (a.placement === 'before_char') beforeChar.push(content)
    else if (a.placement === 'after_char') afterChar.push(content)
    else byDepth.push({ depth: a.depth, role: a.depthRole, content, comment: a.entry.comment || '', order: a.entry.order ?? 100 })
  }
  byDepth.sort((a, b) => a.depth - b.depth || a.order - b.order)

  return { beforeChar, afterChar, byDepth }
}
