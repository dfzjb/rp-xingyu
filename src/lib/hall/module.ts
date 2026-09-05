/**
 * 剧情模组（GameModule）：大致剧情（章节大纲）+ 规划路线（分支）+ 结局表 + 加权随机表（命运转盘）。
 * 骨架参照「命运转盘」类穿越生存游戏：出身转盘决定路线、时间线钉住章节、战败/存活对应不同结局。
 *
 * 同步与持久化策略（零新增通道）：
 * - 模组定义挂在战役文档 campaign.module 与 sync 快照上（可选字段，老存档天然兼容）；
 * - 模组进度 ModuleProgress 挂在战局状态 HallGameState.progress 上，搭 <state> 管线的顺风车
 *   （KP 上报 → 房主合并 → state 事件广播 → 注入回提示词）；
 * - KP 在正文末尾用 <module>{...}</module> 上报进度（绝对值语义），解析容错与 <state> 同款。
 */

export type ModuleEndingKind = 'good' | 'bad' | 'normal' | 'secret'

export interface ModuleChapter {
  id: string
  title: string
  /** 本章剧情节拍/真相（KP 秘密，不要向玩家剧透） */
  summary: string
  /** 本章推进条件/目标（KP 据此判断何时切章） */
  goal: string
}

export interface ModuleRoute {
  id: string
  name: string
  /** 进入条件（如「出身抽到咒灵/诅咒师即入反派线」） */
  entry: string
  /** 此路线的剧情差异（敌我逆转、专属节拍等） */
  summary: string
}

export interface ModuleEnding {
  id: string
  name: string
  kind: ModuleEndingKind
  /** 达成条件（存活到终章 / 关键战败 / 特定旗标…） */
  condition: string
  /** 结局文案提示（KP 写终章旁白的锚点） */
  epilogue: string
}

export interface ModuleTableEntry {
  label: string
  /** 权重（≥0；全 0 时等概率抽取） */
  weight: number
  /** 抽中后的效果/备注（数值加成、剧情含义等） */
  note: string
}

export interface ModuleTable {
  id: string
  name: string
  /** create = 开局出身抽取；action = 行动/遭遇轮盘；空 = 通用 */
  usage: 'create' | 'action' | ''
  entries: ModuleTableEntry[]
}

/** 剧情模组定义（模组库存档 + 战役挂载 + sync 快照同步） */
export interface GameModule {
  id: string
  name: string
  /** 大致剧情：给玩家看的一句话简介也由 KP 掌握全貌 */
  synopsis: string
  chapters: ModuleChapter[]
  routes: ModuleRoute[]
  endings: ModuleEnding[]
  tables: ModuleTable[]
  createdAt: number
  updatedAt: number
}

/** 模组进度：当前章节/天数/路线/旗标 + 是否终局。挂在 HallGameState.progress 上随 state 事件同步 */
export interface ModuleProgress {
  chapterId: string
  /** 时间线读数（天数/回合计数，含义由模组自定义，纯展示 + KP 锚点） */
  day: number
  routeId: string
  flags: string[]
  ended: boolean
  endingId: string
  updatedAt: number
}

/** KP 一次 <module> 上报的内容（字段均可缺省；chapter/day/route 为绝对值，flags 为增删列表） */
export interface ModuleProgressUpdate {
  chapter?: string
  day?: number
  route?: string
  addFlags?: string[]
  removeFlags?: string[]
  /** 非空 = 触发结局（置 ended 并记录 endingId） */
  ending?: string
}

// ── 容量上限：防模组/进度被 AI 或 KP 刷爆（超限丢最旧/截断）──

export const MAX_CHAPTERS = 24
export const MAX_ROUTES = 8
export const MAX_ENDINGS = 16
export const MAX_TABLES = 12
export const MAX_TABLE_ENTRIES = 24
export const MAX_FLAGS = 16

const clip = (v: unknown, n: number): string => String(v ?? '').trim().slice(0, n)

/** 结局类型的中文标签（面板与 KP 块共用） */
export function endingKindLabel(kind: string): string {
  switch (kind) {
    case 'good': return '好结局'
    case 'bad': return '坏结局'
    case 'secret': return '隐藏结局'
    default: return '普通结局'
  }
}

function normalizeKind(raw: unknown): ModuleEndingKind {
  const k = String(raw ?? '').trim()
  return k === 'good' || k === 'bad' || k === 'secret' ? k : 'normal'
}

/** 宽容归一化任意来源（AI 生成 / JSON 导入 / 旧存档）的模组：非法字段丢弃、超长截断、补 id */
export function normalizeModule(raw: unknown): GameModule | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const name = clip(o.name, 60)
  const chapters = (Array.isArray(o.chapters) ? o.chapters : [])
    .map((c, i) => {
      const x = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
      return {
        id: clip(x.id, 40) || `c${i + 1}`,
        title: clip(x.title, 60),
        summary: clip(x.summary, 500),
        goal: clip(x.goal, 160),
      }
    })
    .filter((c) => c.title)
    .slice(0, MAX_CHAPTERS)
  const routes = (Array.isArray(o.routes) ? o.routes : [])
    .map((r, i) => {
      const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
      return {
        id: clip(x.id, 40) || `r${i + 1}`,
        name: clip(x.name, 40),
        entry: clip(x.entry, 160),
        summary: clip(x.summary, 400),
      }
    })
    .filter((r) => r.name)
    .slice(0, MAX_ROUTES)
  const endings = (Array.isArray(o.endings) ? o.endings : [])
    .map((e, i) => {
      const x = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
      return {
        id: clip(x.id, 40) || `e${i + 1}`,
        name: clip(x.name, 60),
        kind: normalizeKind(x.kind),
        condition: clip(x.condition, 200),
        epilogue: clip(x.epilogue, 300),
      }
    })
    .filter((e) => e.name)
    .slice(0, MAX_ENDINGS)
  const tables = (Array.isArray(o.tables) ? o.tables : [])
    .map((t, i) => {
      const x = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
      const usage = String(x.usage ?? '').trim()
      const entries = (Array.isArray(x.entries) ? x.entries : [])
        .map((en) => {
          const y = (en && typeof en === 'object' ? en : {}) as Record<string, unknown>
          const w = Number(y.weight)
          return {
            label: clip(y.label, 60),
            weight: Number.isFinite(w) && w > 0 ? Math.min(999, Math.round(w)) : 1,
            note: clip(y.note, 120),
          }
        })
        .filter((en) => en.label)
        .slice(0, MAX_TABLE_ENTRIES)
      return {
        id: clip(x.id, 40) || `t${i + 1}`,
        name: clip(x.name, 40),
        usage: (usage === 'create' || usage === 'action' ? usage : '') as ModuleTable['usage'],
        entries,
      }
    })
    .filter((t) => t.name && t.entries.length)
    .slice(0, MAX_TABLES)
  // 名字与内容全空视为无效模组
  if (!name && !chapters.length && !routes.length && !endings.length && !tables.length) return null
  return {
    id: clip(o.id, 40),
    name: name || '未命名模组',
    synopsis: clip(o.synopsis, 600),
    chapters,
    routes,
    endings,
    tables,
    createdAt: Number(o.createdAt) || 0,
    updatedAt: Number(o.updatedAt) || 0,
  }
}

export function emptyProgress(): ModuleProgress {
  return { chapterId: '', day: 0, routeId: '', flags: [], ended: false, endingId: '', updatedAt: 0 }
}

export function isEmptyProgress(p: ModuleProgress | null | undefined): boolean {
  if (!p) return true
  return !p.chapterId && !p.routeId && !p.endingId && !p.ended && p.day === 0 && p.flags.length === 0
}

/** 宽容归一化任意来源（KP 上报合并结果 / sync 快照 / 旧存档）的进度 */
export function normalizeProgress(raw: unknown): ModuleProgress {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const flags = (Array.isArray(o.flags) ? o.flags : [])
    .map((f) => clip(f, 40))
    .filter(Boolean)
  const day = Number(o.day)
  return {
    chapterId: clip(o.chapterId, 40),
    day: Number.isFinite(day) && day > 0 ? Math.min(99999, Math.round(day)) : 0,
    routeId: clip(o.routeId, 40),
    flags: [...new Set(flags)].slice(Math.max(0, flags.length - MAX_FLAGS)),
    ended: !!o.ended,
    endingId: clip(o.endingId, 40),
    updatedAt: Number(o.updatedAt) || 0,
  }
}

/**
 * 把一次 <module> 上报合并进当前进度（返回新对象，不改入参）：
 * 章节/天数/路线取绝对值；旗标按文本去重增删；ending 非空即终局锁定。
 */
export function mergeProgressUpdate(base: ModuleProgress | null | undefined, upd: ModuleProgressUpdate): ModuleProgress {
  const cur = base ? normalizeProgress(base) : emptyProgress()
  const flags = cur.flags.filter((f) => !(upd.removeFlags || []).includes(f))
  for (const f of upd.addFlags || []) {
    const t = clip(f, 40)
    if (t && !flags.includes(t)) flags.push(t)
  }
  const ending = clip(upd.ending, 40)
  const day = upd.day === undefined ? cur.day : Math.max(0, Math.min(99999, Math.round(Number(upd.day) || 0)))
  return normalizeProgress({
    ...cur,
    chapterId: upd.chapter !== undefined ? clip(upd.chapter, 40) : cur.chapterId,
    day,
    routeId: upd.route !== undefined ? clip(upd.route, 40) : cur.routeId,
    flags: flags.slice(Math.max(0, flags.length - MAX_FLAGS)),
    ended: cur.ended || !!ending,
    endingId: ending || cur.endingId,
    updatedAt: Date.now(),
  })
}

/** 从 KP 正文里解析 <module>{...}</module> 上报（取最后一个；坏 JSON / 无标记返回 null） */
const MODULE_RE = /<module>([\s\S]*?)<\/module>/gi

export function extractModuleUpdate(text: string): ModuleProgressUpdate | null {
  const matches = [...text.matchAll(MODULE_RE)]
  const last = matches[matches.length - 1]
  if (!last) return null
  let obj: unknown
  try {
    obj = JSON.parse(last[1].replace(/```(?:json)?/gi, '').trim())
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  const strArr = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((x) => clip(x, 40)).filter(Boolean)
    if (typeof v === 'string' && v.trim()) return v.split(/\n|；|;|、/).map((s) => clip(s, 40)).filter(Boolean)
    return []
  }
  const day = Number(o.day)
  const upd: ModuleProgressUpdate = {
    chapter: o.chapter === undefined ? undefined : clip(o.chapter, 40),
    day: o.day === undefined || !Number.isFinite(day) ? undefined : Math.max(0, Math.round(day)),
    route: o.route === undefined ? undefined : clip(o.route, 40),
    addFlags: strArr(o.addFlags),
    removeFlags: strArr(o.removeFlags),
    ending: o.ending === undefined ? undefined : clip(o.ending, 40),
  }
  // 空上报（所有字段都缺/空）按无标记处理
  const empty = (upd.chapter === undefined || upd.chapter === '')
    && upd.day === undefined
    && (upd.route === undefined || upd.route === '')
    && !upd.addFlags!.length
    && !upd.removeFlags!.length
    && (upd.ending === undefined || upd.ending === '')
  return empty ? null : upd
}

/** 加权随机抽取（命运转盘）：全 0 权重退化为等概率；空表返回 null */
export function pickWeighted<T extends { weight: number }>(entries: T[], rng: () => number = Math.random): T | null {
  if (!entries.length) return null
  const total = entries.reduce((n, e) => n + Math.max(0, e.weight), 0)
  if (total <= 0) return entries[Math.floor(rng() * entries.length)] ?? null
  let r = rng() * total
  for (const e of entries) {
    r -= Math.max(0, e.weight)
    if (r < 0) return e
  }
  return entries[entries.length - 1]
}

// ── KP 提示词块 ──

function findName(list: { id: string; name?: string; title?: string }[], id: string): string {
  const hit = list.find((x) => x.id === id)
  return (hit && (hit.name || hit.title)) || ''
}

/** 把模组定义 + 当前进度渲染成 KP 可读的设定块；空模组返回空串 */
export function renderModuleBlock(m: GameModule | null | undefined, progress?: ModuleProgress | null): string {
  if (!m) return ''
  const lines: string[] = []
  lines.push(`【剧情模组：${m.name}】（本模组由系统跟踪章节/路线/结局进度；对玩家只呈现当前章节的内容，不要提前剧透后续章节节拍、其他路线差异与结局真相）`)
  if (m.synopsis) lines.push(`- 大致剧情：${m.synopsis}`)
  if (m.chapters.length) {
    lines.push('- 章节大纲（按顺序推进，节拍为 KP 秘密）：')
    m.chapters.forEach((c, i) => {
      const cur = progress?.chapterId && progress.chapterId === c.id
      lines.push(`  ${i + 1}. [${c.id}] ${c.title}${cur ? '（当前章节）' : ''}——${c.summary}${c.goal ? `；推进条件：${c.goal}` : ''}`)
    })
  }
  if (m.routes.length) {
    lines.push('- 规划路线（玩家行动/出身满足进入条件时切线，剧情按该线差异展开）：')
    for (const r of m.routes) {
      const cur = progress?.routeId === r.id
      lines.push(`  - [${r.id}] ${r.name}${cur ? '（当前路线）' : ''}——进入条件：${r.entry || '由你依剧情裁量'}；走向：${r.summary || '（未指定）'}`)
    }
  }
  if (m.endings.length) {
    lines.push('- 结局表（条件达成即引入对应结局并写终章旁白；绝不让剧情无结局地悬置）：')
    for (const e of m.endings) {
      lines.push(`  - [${e.id}] ${e.name}（${endingKindLabel(e.kind)}）——达成条件：${e.condition || '由你依剧情裁量'}${e.epilogue ? `；终章提示：${e.epilogue}` : ''}`)
    }
  }
  const createTables = m.tables.filter((t) => t.usage === 'create')
  if (createTables.length) {
    lines.push(`- 出身转盘：本模组含「${createTables.map((t) => t.name).join('」「')}」等开局抽取表，玩家会在入场阶段用房间「命运转盘」抽出身；请在开场与角色介绍环节把抽取结果（含备注里的加成/设定）融入剧情。`)
  }
  if (progress && !isEmptyProgress(progress)) {
    const parts: string[] = []
    if (progress.chapterId) parts.push(`当前章节：${findName(m.chapters, progress.chapterId) || progress.chapterId}`)
    if (progress.day > 0) parts.push(`时间线：第 ${progress.day} 天`)
    if (progress.routeId) parts.push(`当前路线：${findName(m.routes, progress.routeId) || progress.routeId}`)
    if (progress.flags.length) parts.push(`关键旗标：${progress.flags.join('、')}`)
    if (progress.ended) parts.push(`已终局：${findName(m.endings, progress.endingId) || progress.endingId}（除非房主重开周目，剧情不再推进）`)
    lines.push(`- 当前进度：${parts.join(' | ')}`)
  }
  lines.push('- 进度上报：当剧情推进导致章节切换、时间线推进、路线变动、出现值得记住的关键旗标、或达成结局时，在正文结束后另起一行输出一次 <module>{"chapter":"章节id","day":天数,"route":"路线id","addFlags":["旗标"],"removeFlags":["旗标"],"ending":"结局id"}</module>。章节/天数/路线直接给当前值；没有变化的字段省略；没有任何推进就完全不输出 <module>；结局 id 只在真正达成时输出一次。')
  return lines.join('\n')
}

// ── AI 锻造：一句话构想 → 整套模组（工作台与创建房间弹窗共用）──

/** AI 生成所需的最小调用配置（走 OpenAI 兼容接口） */
export interface ModuleAiConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export const MODULE_AI_SYSTEM = `你是资深跑团模组设计师。根据用户的构想，设计一个带「大致剧情 + 规划路线 + 结局表 + 命运转盘随机表」的结构化剧情模组（骨架参考"轮回转盘"类穿越生存游戏：出身决定阵营路线、时间线钉住章节、条件达成即进入对应结局）。
只输出严格 JSON，不要任何解释或代码围栏。字段要求：
{
  "name": "模组名（12 字内，有氛围感）",
  "synopsis": "大致剧情，100-200 字：开端-冲突-终局方向，可含真相（这是给 KP 的）",
  "chapters": [ { "title": "章节名（8 字内）", "summary": "本章剧情节拍/真相（KP 秘密，60-150 字）", "goal": "推进到下一章的条件（一句话）" } ],
  "routes": [ { "name": "路线名（6 字内）", "entry": "进入条件（如出身抽到某身份、关键选择）", "summary": "此路线的剧情差异（敌我变化/专属节拍，50-120 字）" } ],
  "endings": [ { "name": "结局名", "kind": "good|bad|normal|secret", "condition": "达成条件（一句话，可判定）", "epilogue": "终章旁白锚点（30-80 字）" } ],
  "tables": [ { "name": "转盘名", "usage": "create|action", "entries": [ { "label": "条目名（8 字内）", "weight": 权重整数, "note": "抽中效果/备注（30 字内）" } ] } ]
}
数量要求：chapters 按用户指定章节数（缺省 5 章，4-10 章之间）；routes 0-3 条（有阵营分支时必给至少 1 条，入口尽量挂到出身转盘条目上）；endings 3-6 个（至少 1 个好结局、1 个坏结局，条件不重叠）；tables：usage="create" 的出身转盘 1 张（5-8 项，权重和约 20，各项 note 带可玩的加成/设定），用户需要时再加 1 张 usage="action" 的行动/遭遇转盘（6-10 项）。`

/** 从模型回复里截取最外层 JSON 对象（容忍代码围栏） */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '')
  const s = cleaned.indexOf('{')
  const e = cleaned.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    return JSON.parse(cleaned.slice(s, e + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 一句话构想 → 整套结构化模组（工作台与创建房间弹窗共用；走 OpenAI 兼容接口） */
export async function aiGenerateModule(
  cfg: ModuleAiConfig,
  idea: string,
  opts: { chapters?: number; withActionTable?: boolean } = {},
): Promise<GameModule> {
  const { chatOnce } = await import('../api')
  const user = `模组构想：${idea.trim()}\n章节数：${opts.chapters || 5} 章\n随机表：${opts.withActionTable === false ? '只要出身转盘' : '出身转盘必带，行动转盘按题材决定'}`
  const raw = await chatOnce({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: 0.85,
    maxTokens: 8000,
    reasoningEffort: 'minimal',
  }, [
    { role: 'system', content: MODULE_AI_SYSTEM },
    { role: 'user', content: user },
  ])
  const m = normalizeModule(extractJsonObject(raw))
  if (!m) throw new Error('AI 返回了空模组，请重试或换个说法')
  return m
}
