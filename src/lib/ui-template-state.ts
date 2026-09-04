/**
 * UI 模板动态状态：AI 回复时通过 <ui_template_updates> 更新模板变量，
 * 模板随剧情实时变化。对齐旧版 app.js 的 uiTemplate 更新管线（简化版）。
 */
import type { UiTemplate } from './uitemplate'

/** 会话级模板变量状态：templateId → variables */
export type UiTemplateStateMap = Record<string, Record<string, unknown>>

const OPEN = '<ui_template_updates>'
const CLOSE = '</ui_template_updates>'
const BLOCK_RE = /<ui_template_updates\b[^>]*>([\s\S]*?)<\/ui_template_updates>/i
const STRIP_RE = /<ui_template_updates\b[^>]*>[\s\S]*?<\/ui_template_updates>/gi
const OPEN_STRIP_RE = /<ui_template_updates\b[^>]*>[\s\S]*$/i

const CTX_OPEN = '<ui_template_state_context>'
const CTX_CLOSE = '</ui_template_state_context>'

/** 模板单条更新 */
export interface UiTemplateUpdate {
  id?: string
  name?: string
  variables?: Record<string, unknown>
  reason?: string
}

/** 按路径取值（支持 a.b.0.c） */
function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

/** 按路径设值，自动创建中间对象/数组 */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    const nextK = keys[i + 1]
    if (cur[k] === undefined || cur[k] === null) {
      cur[k] = /^\d+$/.test(nextK) ? [] : {}
    }
    cur = cur[k] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]] = value
  return obj
}

/** 深拷贝（JSON 安全） */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** 把 patch 深合并进 target（对象递归合并、数组/标量整体替换），返回变更字段数 */
function deepMergeCount(target: Record<string, unknown>, patch: Record<string, unknown>): number {
  let changed = 0
  for (const [k, v] of Object.entries(patch)) {
    const oldVal = target[k]
    if (isPlainObj(oldVal) && isPlainObj(v)) {
      changed += deepMergeCount(oldVal, v)
    } else if (JSON.stringify(oldVal) !== JSON.stringify(v)) {
      target[k] = v
      changed++
    }
  }
  return changed
}

/** 模板变量的静态兜底链（与渲染端 renderUiTemplateHtml 的回退顺序保持一致） */
function fallbackVars(t: UiTemplate): Record<string, unknown> {
  return t.variableState ?? t.initialVariableState ?? {}
}

/**
 * 从模板变量名里启发式挑出「描述当前这一幕、每幕都应随剧情重写」的字段并按组列名，
 * 命令式提醒模型逐项核对——否则模型会把场景/遭遇/选项/在场人物误当静态资料而漏改
 * （实测：不点名时补全模型只改最直白的环境/心情，整组 choice_*、npc 槽位保持旧值）。
 * 只列字段名（当前值在全量 currentVariables 里），控制提示长度、减轻思考模型负担。
 */
const SCENE_REFRESH_GROUPS: { label: string; re: RegExp }[] = [
  { label: '场景/时间/环境/位置', re: /^(env|scene|location|place|weather|time|date|weekday|season|temp)/i },
  { label: '当前遭遇与可选行动(选项)', re: /(choice|option|encounter|action|select|summary)/i },
  { label: '在场角色/NPC槽位(npc1=当前最主要互动对象)', re: /npc|^(character|actor|companion)\d/i },
  { label: '玩家当下状态(心情/体力/压力/健康/欲望/资金/穿着)', re: /(hp|health|stress|energy|stamina|mood|lust|libido|money|cash|condition|inner|clothing|outfit|emotion)/i },
]

function buildSceneRefreshHint(templates: { currentVariables: Record<string, unknown> }[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const g of SCENE_REFRESH_GROUPS) {
    const hit = new Set<string>()
    for (const t of templates) {
      for (const k of Object.keys(t.currentVariables || {})) if (g.re.test(k)) hit.add(k)
    }
    const list = [...hit].filter((k) => !seen.has(k))
    list.forEach((k) => seen.add(k))
    if (list.length) lines.push(`  · ${g.label}：${list.join(', ')}`)
  }
  if (!lines.length) return ''
  return [
    '【每幕必刷新】下列字段描述“当前这一幕”，不是静态资料；只要剧情推进、换地点、换在场人物或进入新情境，就必须按最近对话重写，不得沿用旧值：',
    ...lines,
    '  “遭遇/选项”类：用一句话概括当前处境，并给出当前场景下玩家真正可采取的数个不同行动；NPC 槽位按当前实际在场、与玩家互动的角色重排，最主要互动对象放 npc1，不在场的旧角色后移或清空。',
  ].join('\n')
}

/**
 * 构建注入到 system 提示词末尾的模板状态上下文。
 * 让 AI 知道当前模板变量的值，从而能判断如何更新。
 */
export function buildUiTemplateContextPrompt(
  templates: UiTemplate[],
  states: UiTemplateStateMap,
): string {
  const enabled = templates.filter((t) => t.enabled && t.htmlTemplate)
  if (!enabled.length) return ''

  const sections = enabled
    .map((t) => {
      const vars = states[t.id] ?? fallbackVars(t)
      if (!vars || Object.keys(vars).length === 0) return null
      return [
        `  <template_state name="${t.name || t.id}">`,
        JSON.stringify(vars, null, 2).split('\n').map((l) => '  ' + l).join('\n'),
        '  </template_state>',
      ].join('\n')
    })
    .filter(Boolean)

  if (!sections.length) return ''

  return [
    CTX_OPEN,
    '  <description>以下是当前 UI 模板的变量状态快照，仅供你理解角色状态、关系、地点等剧情信息，不要在正文中复述或输出这些变量。</description>',
    ...sections,
    CTX_CLOSE,
  ].join('\n')
}

/**
 * 构建追加到 system 提示词的"输出变量更新块"指令。
 * 告诉 AI 输出 <ui_template_updates>{"updates":[...]}</ui_template_updates>。
 * states：会话级实时变量状态 —— 必须传入，否则 AI 看到的是卡内静态初始值，
 * 会与 <ui_template_state_context> 里的实时快照互相矛盾。
 *
 * position（默认 'before'，对齐 2026-09-04 线上根因修正）：
 *   - 'before'：要求模型把更新块放在回复「最开头、正文之前」。这样即使正文很长撞上
 *     max_tokens 被截断（线上实测主模型 completion 正好卡在 4096），更新块也已完整流出，
 *     面板仍能更新；流式期间该块由渲染层 stripStateSyncBlocks 实时隐藏，用户看不到 JSON。
 *   - 'after'：旧版原始语义，正文结束后追加（正文被截断时块会一起丢，仅在 max_tokens 充裕时可靠）。
 */
export function buildUiTemplateUpdateInstruction(
  templates: UiTemplate[],
  states: UiTemplateStateMap = {},
  position: 'before' | 'after' = 'before',
): string {
  const enabled = templates.filter((t) => t.enabled && t.htmlTemplate)
  if (!enabled.length) return ''

  const payload = enabled.map((t) => ({
    id: t.id,
    name: t.name || 'UI模板',
    currentVariables: states[t.id] ?? fallbackVars(t),
    variableSchema: t.variableSchema || '',
  }))

  const placeLine = position === 'before'
    ? '位置（强制）：把更新块放在本次回复的「最开头」，先完整输出更新块、闭合标签之后再开始写正文；严禁先写正文再补块。'
    : '位置（强制）：先写完整段正文，在全部正文结束之后再追加更新块。'
  return [
    '[UI模板变量更新]',
    '本次回复必须携带一个隐藏变量更新块。这个块只给前端读取，不属于正文，不要在正文里提到或复述它。',
    placeLine,
    '格式必须严格如下：',
    OPEN,
    '{"updates":[{"id":"模板id","variables":{"变量路径":"新值"},"reason":"简短原因"}]}',
    CLOSE,
    '没有变量变化也必须输出空块：',
    `${OPEN}{"updates":[]}${CLOSE}`,
    '只更新下方模板已定义的变量；不要修改HTML；不要编造无关字段；只输出本次发生变化的字段，严禁把整份变量原样回写（会超长被截断）。',
    '变量值可以是文字、数字、对象或数组；数组字段可返回完整数组，也可用 "items.0.name" 这种路径更新单项。',
    buildSceneRefreshHint(payload.map((p) => ({ currentVariables: p.currentVariables }))),
    '模板变量如下：',
    JSON.stringify(payload, null, 2),
  ].filter(Boolean).join('\n')
}

/**
 * 副模型二次分析的消息组（旧版"副模型分析"语义，融合为单次调用）：
 * 主模型回复未携带变量更新块时，用副模型按最近楼层补一次变量分析。
 * 返回固定 JSON（{"updates":[…]}），解析复用 parseUpdatesPayload。
 */
export function buildAuxAnalysisMessages(
  templates: UiTemplate[],
  states: UiTemplateStateMap,
  recentFloors: { role: 'user' | 'assistant'; name: string; content: string }[],
  existingNpcs: { npcName: string; score?: number; stage?: string }[] = [],
): { role: 'system' | 'user'; content: string }[] {
  const enabled = templates.filter((t) => t.enabled && t.htmlTemplate)
  if (!enabled.length || !recentFloors.length) return []

  const payload = enabled.map((t) => ({
    id: t.id,
    name: t.name || 'UI模板',
    currentVariables: states[t.id] ?? fallbackVars(t),
    variableSchema: t.variableSchema || '',
  }))

  const npcRoster = existingNpcs.length
    ? existingNpcs.map((n) => `${n.npcName}（综合${n.score ?? '?'}·${n.stage ?? '未知阶段'}）`).join('、')
    : '（暂无档案）'
  const system = [
    '你是旧版的UI状态更新器。根据用户消息里提供的最近对话，同时完成两件事：①更新UI模板中受剧情影响的变量；②给本场出场的NPC做好感度评判。',
    '只返回一个JSON对象，不要解释，不要输出Markdown，不要展开思考过程。',
    '返回格式固定为 {"updates":[{"id":"模板id","variables":{"变量路径":"新值"},"reason":"简短原因"}],"affinity":[...NPC...]}。',
    '【updates 变量更新】variables 只包含「本次确实发生变化」的路径（通常十几到几十个）；值可以是文字、数字、对象或JSON数组。',
    '严禁把没变化的字段原样回写、严禁输出整份变量：全量回写会让输出超长被截断、反而导致更新失败。',
    '装备栏、背包、动态、聊天记录这类列表字段可直接返回完整数组，也可用 "feed.0.text" 这种路径更新单项。',
    '没有变量变化则 updates 返回 []。不要修改HTML，不要编造模板未定义的字段，变量路径必须与当前变量完全一致。',
    '【affinity 好感评判】只评最近对话中实际出场、与玩家互动的AI侧角色（玩家本人不是NPC）；已在档案但本场未出场的不要重复输出，本场无NPC则返回 []。',
    '每个NPC在三条相对轴上打0-100整数（方向相反、此消彼长）：interest兴趣/annoyance厌烦（关注轴）、attraction吸引/disgust反感（心动轴）、trust信任/cringe尴尬（自在轴），另有 conflict冲突等级0-4（0无冲突/1摩擦/2争执/3冷战/4决裂）。',
    '评分要有惯性：没有明显事件时只小幅浮动，重大事件（告白/背叛/救命）才可大幅调整。',
    `已有NPC档案：${npcRoster}。`,
    'affinity 单项格式 {"npcName":"角色名","interest":0-100,"annoyance":0-100,"attraction":0-100,"disgust":0-100,"trust":0-100,"cringe":0-100,"conflict":0-4}；面板里的 npcN_favor 数值应与该NPC综合好感一致（0-100）。',
    buildSceneRefreshHint(payload.map((p) => ({ currentVariables: p.currentVariables }))),
    '',
    '模板与当前变量如下：',
    JSON.stringify(payload, null, 2),
  ].filter(Boolean).join('\n')

  const user = recentFloors
    .map((f) => `[${f.role === 'user' ? f.name || '用户' : f.name || 'AI'}]：${f.content}`)
    .join('\n\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: `最近对话如下：\n\n${user}` },
  ]
}

/** 解析单个更新块内的 JSON 载荷为更新列表（state-sync 规则引擎复用） */
/**
 * 抢救被 max_tokens 截断、尾部不完整的更新 JSON。
 * 典型场景：轻量 fast 模型不遵守「只输出变化字段」，把整份变量全量回写，输出超长被砍断，
 * 结尾缺 `}}]}`。策略：从首个 `{` 起，逐次回退到上一个完整键值对边界（逗号），尝试补全闭合，
 * 能 parse 即返回（已完整写出的字段都可救回）。
 */
function salvageTruncatedUpdates(body: string): unknown {
  const start = body.indexOf('{')
  if (start < 0) return null
  let work = body.slice(start)
  for (let i = 0; i < 600; i++) {
    const cut = work.lastIndexOf(',')
    if (cut <= 0) break
    work = work.slice(0, cut)
    // updates 结构 {"updates":[{"id":..,"variables":{ 已完整字段 ，依次尝试不同层级的闭合
    for (const suffix of ['}}]}', '}]}', ']}', '}}', '}']) {
      try {
        return JSON.parse(work + suffix)
      } catch {
        /* 继续尝试下一种闭合 */
      }
    }
  }
  return null
}

/** 去围栏 + 直接 parse，失败则截取最外层对象，再失败则按截断 JSON 抢救；返回解析出的对象/数组 */
function parsePayloadObject(raw: string): unknown {
  const body = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    return JSON.parse(body)
  } catch {
    const s = body.indexOf('{')
    const e = body.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try { return JSON.parse(body.slice(s, e + 1)) } catch { return salvageTruncatedUpdates(body) }
    }
    return salvageTruncatedUpdates(body)
  }
}

/** 从解析结果里取模板更新列表（兼容数组 / {updates:[]} / 裸 {variables:{}} 三种形态） */
function toUpdateList(parsed: unknown): UiTemplateUpdate[] {
  if (Array.isArray(parsed)) return parsed as UiTemplateUpdate[]
  if (parsed && typeof parsed === 'object') {
    const p = parsed as { updates?: unknown[]; variables?: Record<string, unknown> }
    if (Array.isArray(p.updates)) return p.updates as UiTemplateUpdate[]
    if (p.variables && typeof p.variables === 'object') return [{ variables: p.variables }]
  }
  return []
}

export function parseUpdatesPayload(raw: string): UiTemplateUpdate[] {
  return toUpdateList(parsePayloadObject(raw))
}

/** UI 补全搭车返回的单个 NPC 好感评判（字段同 affinity.ts 的 NpcEvalResult） */
export interface AuxAffinityItem {
  npcName: string
  interest?: number
  annoyance?: number
  attraction?: number
  disgust?: number
  trust?: number
  cringe?: number
  conflict?: number
}

/** UI 补全一次调用的解析结果：模板变量更新 + 出场 NPC 好感评判 */
export interface AuxPayload {
  updates: UiTemplateUpdate[]
  affinity: AuxAffinityItem[]
}

/** 解析补全模型返回（{"updates":[...],"affinity":[...]}），两部分互不影响（一部分残缺不拖垮另一部分） */
export function parseAuxPayload(raw: string): AuxPayload {
  const parsed = parsePayloadObject(raw)
  const updates = toUpdateList(parsed)
  let affinity: AuxAffinityItem[] = []
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { affinity?: unknown }).affinity)) {
    affinity = ((parsed as { affinity: unknown[] }).affinity)
      .filter((a) => a && typeof a === 'object' && String((a as AuxAffinityItem).npcName || '').trim()) as AuxAffinityItem[]
  }
  return { updates, affinity }
}

/** 从 AI 回复中提取全部 <ui_template_updates> 块并解析为更新列表（支持多个块） */
export function parseUiTemplateUpdates(text: string): UiTemplateUpdate[] {
  const out: UiTemplateUpdate[] = []
  const re = new RegExp(BLOCK_RE.source, 'gi')
  const src = String(text || '')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    out.push(...parseUpdatesPayload(m[1]))
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return out
}

/** 向单个模板状态写入一个路径值（对象深合并），返回变更数 */
function writeToState(state: Record<string, unknown>, key: string, value: unknown): number {
  const oldVal = getByPath(state, key)
  if (isPlainObj(oldVal) && isPlainObj(value)) {
    // 双方都是对象 → 深合并（模型常只回传嵌套变量的部分字段，整体替换会丢兄弟键）
    const merged = clone(oldVal)
    const n = deepMergeCount(merged, value)
    if (n > 0) {
      setByPath(state, key, merged)
      return n
    }
    return 0
  }
  if (JSON.stringify(oldVal) !== JSON.stringify(value)) {
    setByPath(state, key, value)
    return 1
  }
  return 0
}

/** 把 AI 返回的更新应用到状态映射，返回新映射和变更数 */
export function applyUiTemplateUpdates(
  states: UiTemplateStateMap,
  templates: UiTemplate[],
  updates: UiTemplateUpdate[],
): { states: UiTemplateStateMap; changedCount: number } {
  const next = clone(states)
  let changedCount = 0

  // 模板初始化状态（缺省用卡内初始值）
  const ensureState = (tpl: UiTemplate): Record<string, unknown> => {
    if (!next[tpl.id]) next[tpl.id] = clone(tpl.initialVariableState ?? {})
    return next[tpl.id]
  }

  for (const upd of updates) {
    if (!upd || !upd.variables || typeof upd.variables !== 'object') continue
    // 找到目标模板：显式 id/name → 精确匹配；省略目标时单模板直取；
    // 多模板则逐路径智能路由（写入已拥有该路径的模板；全新路径回退写入全部）
    let targets: UiTemplate[]
    if (upd.id) targets = templates.filter((t) => t.id === upd.id)
    else if (upd.name) targets = templates.filter((t) => t.name === upd.name)
    else if (templates.length === 1) targets = [templates[0]]
    else targets = templates
    if (!targets.length) continue

    for (const [key, value] of Object.entries(upd.variables)) {
      const owners = targets.length > 1
        ? (() => {
            const owning = templates.filter((t) => getByPath(next[t.id] ?? clone(t.initialVariableState ?? {}), key) !== undefined)
            return owning.length ? owning : targets
          })()
        : targets
      for (const tpl of owners) {
        changedCount += writeToState(ensureState(tpl), key, value)
      }
    }
  }

  return { states: next, changedCount }
}

/** 从可见正文中剥离 <ui_template_updates> 块 */
export function stripUiTemplateUpdates(text: string): string {
  return String(text || '')
    .replace(STRIP_RE, '')
    .replace(OPEN_STRIP_RE, '')
    .trimEnd()
}
