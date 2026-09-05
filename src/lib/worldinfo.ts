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
  /** 归一后统一为旧版七位置：system_top/global_note/before_char/after_char/user_top/assistant_top/at_depth */
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

/** 旧版世界书七位置 */
export type WIPosition =
  | 'system_top' | 'global_note' | 'before_char' | 'after_char'
  | 'user_top' | 'assistant_top' | 'at_depth'

export interface ActivatedEntry {
  content: string
  comment: string
  order: number
  placement: WIPosition
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

// 位置别名表（对齐旧版 posNameMap，七位置全部保留，不再折叠语义）
const POS_ALIAS: Record<string, WIPosition> = {
  system_top: 'system_top',
  // 作者注/全局注释类别名 → global_note（同旧版）
  global_note: 'global_note',
  an_top: 'global_note',
  an_bottom: 'global_note',
  author_note: 'global_note',
  before_char: 'before_char',
  before_character: 'before_char',
  character_top: 'before_char',
  before_examples: 'before_char',
  example_top: 'before_char',
  after_char: 'after_char',
  after_character: 'after_char',
  character_bottom: 'after_char',
  after_examples: 'after_char',
  example_bottom: 'after_char',
  user_top: 'user_top',
  assistant_top: 'assistant_top',
  at_depth: 'at_depth',
  em_depth: 'at_depth',
  '@depth': 'at_depth',
}

/**
 * 把任意来源的世界书条目归一为内部模型。
 * 位置映射对齐旧版 normalizeWorldInfoEntry（字符串别名 + 数字 0/1/2/3/4）：
 * 0 before_char、1 after_char、2/3 global_note、4 at_depth；无法识别时默认 at_depth。
 * source 仅标记数据来源（ST 卡 / 旧版备份），位置规则与旧版一致，不做差异化映射。
 */
export function normalizeWorldInfoEntry(raw: unknown, source: 'st' | 'legacy' = 'st'): WorldInfoEntry | null {
  void source
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

  // ── 位置归一（对齐旧版：默认 at_depth）──
  let position: WIPosition = 'at_depth'
  const rawPos = pick('position')
  if (typeof rawPos === 'string') {
    const p = rawPos.toLowerCase().replace(/ /g, '_')
    if (p.startsWith('@') || /depth/.test(p)) position = 'at_depth'
    else position = POS_ALIAS[p] ?? 'at_depth'
  } else if (typeof rawPos === 'number' || (typeof rawPos === 'string' && rawPos.trim() !== '' && !Number.isNaN(Number(rawPos)))) {
    const n = Number(rawPos)
    // 旧版数字编码：0 before_char / 1 after_char / 2,3 global_note / 4 at_depth，其余 at_depth
    if (n === 0) position = 'before_char'
    else if (n === 1) position = 'after_char'
    else if (n === 2 || n === 3) position = 'global_note'
    else position = 'at_depth'
  }
  // 编辑器产出的 '@4' 形式
  if (typeof r.position === 'string' && String(r.position).startsWith('@')) position = 'at_depth'

  // ── depthRole 归一（ST 数字：0 system,1 user,2 assistant）──
  // 对齐旧版：@深度条目缺省以 user 角色注入（旧版 processMessageInjections 固定 role:'user'）；
  // 仅当数据显式指定 system/0、assistant/2 时才覆盖默认值
  let depthRole: WorldInfoEntry['depthRole'] = 'user'
  const rawRole = pick('depthRole', 'depth_role', 'role')
  if (rawRole === 'system' || rawRole === 0) depthRole = 'system'
  else if (rawRole === 'user' || rawRole === 1) depthRole = 'user'
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

interface Activated { entry: WorldInfoEntry; placement: WIPosition; depth: number; depthRole: 'system' | 'user' | 'assistant' }

/** 位置 → 注入分组（防御性识别，正常数据已在 normalize 阶段归一为七位置） */
function toActivated(e: WorldInfoEntry): Activated {
  let placement: WIPosition = 'at_depth'
  const pos = e.position
  if (typeof pos === 'string') {
    if (pos.startsWith('@') || /depth/.test(pos)) placement = 'at_depth'
    else placement = POS_ALIAS[pos] ?? 'at_depth'
  } else if (typeof pos === 'number') {
    if (pos === 0) placement = 'before_char'
    else if (pos === 1) placement = 'after_char'
    else if (pos === 2 || pos === 3) placement = 'global_note'
    else placement = 'at_depth'
  }
  let depthRole: Activated['depthRole'] = 'user'
  if (e.depthRole === 'system' || e.depthRole === 0) depthRole = 'system'
  else if (e.depthRole === 'user' || e.depthRole === 1) depthRole = 'user'
  else if (e.depthRole === 'assistant' || e.depthRole === 2) depthRole = 'assistant'
  return { entry: e, placement, depth: typeof e.depth === 'number' ? e.depth : 4, depthRole }
}

/** 已激活、待注入的条目（携带条目名供旧版式 [条目名] 包裹） */
export interface WIPlacedEntry {
  comment: string
  content: string
  order: number
}

export interface WIResult {
  systemTop: WIPlacedEntry[]
  globalNote: WIPlacedEntry[]
  beforeChar: WIPlacedEntry[]
  afterChar: WIPlacedEntry[]
  userTop: WIPlacedEntry[]
  assistantTop: WIPlacedEntry[]
  byDepth: { depth: number; role: 'system' | 'user' | 'assistant'; content: string; comment: string; order: number }[]
}

/**
 * 默认递归激活步数。
 * 对齐旧版：旧版世界书只对对话楼层做一轮关键词扫描，不存在「已激活条目内容再去激活别的条目」
 * 的链式扩散，故默认 0（关闭递归），避免一条总纲条目把整本书无关条目链式拉进 prompt。
 * 需要 ST 式递归扫描时由调用方显式传入 >0 的步数。
 */
export const DEFAULT_WI_RECURSION_STEPS = 0

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
    .map((e) => (e && typeof e.position === 'string' && POS_ALIAS[e.position] ? e : normalizeWorldInfoEntry(e)))
    .filter((e): e is WorldInfoEntry => !!e)
  const active = normalized.filter((e) => e.enabled !== false && String(e.content || '').trim())

  const activatedSet = new Set<WorldInfoEntry>()
  const activatedList: Activated[] = []

  function tryActivate(e: WorldInfoEntry, source: string[]): boolean {
    if (activatedSet.has(e)) return false
    // 对齐旧版：条目未显式设 scanDepth 时用全局默认 2（只扫最近 2 楼），
    // 不再用「所有条目的最大扫描深度」当缺省值，避免个别大深度条目把其余条目窗口一并放大
    const d = Math.max(0, typeof e.scanDepth === 'number' ? e.scanDepth : 2)
    // 对齐旧版：scanDepth=0 的非常驻条目不参与扫描（窗口为零层）
    if (!e.constant && d === 0) return false
    const windowText = source.slice(-d).join('\n')
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

  // 分组输出（对齐旧版七位置；组内按 order 升序）
  const systemTop: WIPlacedEntry[] = []
  const globalNote: WIPlacedEntry[] = []
  const beforeChar: WIPlacedEntry[] = []
  const afterChar: WIPlacedEntry[] = []
  const userTop: WIPlacedEntry[] = []
  const assistantTop: WIPlacedEntry[] = []
  const byDepth: WIResult['byDepth'] = []

  const sorted = [...activatedList].sort((a, b) => (a.entry.order ?? 100) - (b.entry.order ?? 100))
  for (const a of sorted) {
    const content = String(a.entry.content || '').trim()
    if (!content) continue
    const placed = { comment: a.entry.comment || '', content, order: a.entry.order ?? 100 }
    switch (a.placement) {
      case 'system_top': systemTop.push(placed); break
      case 'global_note': globalNote.push(placed); break
      case 'before_char': beforeChar.push(placed); break
      case 'after_char': afterChar.push(placed); break
      case 'user_top': userTop.push(placed); break
      case 'assistant_top': assistantTop.push(placed); break
      default:
        byDepth.push({ depth: a.depth, role: a.depthRole, content, comment: a.entry.comment || '', order: a.entry.order ?? 100 })
    }
  }
  byDepth.sort((a, b) => a.depth - b.depth || a.order - b.order)

  return { systemTop, globalNote, beforeChar, afterChar, userTop, assistantTop, byDepth }
}
