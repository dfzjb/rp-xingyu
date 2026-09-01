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
 * 告诉 AI 在正文后输出 <ui_template_updates>{"updates":[...]}</ui_template_updates>。
 * states：会话级实时变量状态 —— 必须传入，否则 AI 看到的是卡内静态初始值，
 * 会与 <ui_template_state_context> 里的实时快照互相矛盾。
 */
export function buildUiTemplateUpdateInstruction(
  templates: UiTemplate[],
  states: UiTemplateStateMap = {},
): string {
  const enabled = templates.filter((t) => t.enabled && t.htmlTemplate)
  if (!enabled.length) return ''

  const payload = enabled.map((t) => ({
    id: t.id,
    name: t.name || 'UI模板',
    currentVariables: states[t.id] ?? fallbackVars(t),
    variableSchema: t.variableSchema || '',
  }))

  return [
    '[UI模板变量更新]',
    '你需要在正文结束后追加一个隐藏变量更新块。这个块只给前端读取，不属于正文，不要在正文中提到它。',
    '格式必须严格如下：',
    OPEN,
    '{"updates":[{"id":"模板id","variables":{"变量路径":"新值"},"reason":"简短原因"}]}',
    CLOSE,
    '没有变量变化也必须输出：',
    `${OPEN}{"updates":[]}${CLOSE}`,
    '只更新下方模板已定义的变量；不要修改HTML；不要编造无关字段。',
    '变量值可以是文字、数字、对象或数组；数组字段可返回完整数组，也可用 "items.0.name" 这种路径更新单项。',
    '模板变量如下：',
    JSON.stringify(payload, null, 2),
  ].join('\n')
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
): { role: 'system' | 'user'; content: string }[] {
  const enabled = templates.filter((t) => t.enabled && t.htmlTemplate)
  if (!enabled.length || !recentFloors.length) return []

  const payload = enabled.map((t) => ({
    id: t.id,
    name: t.name || 'UI模板',
    currentVariables: states[t.id] ?? fallbackVars(t),
    variableSchema: t.variableSchema || '',
  }))

  const system = [
    '你是旧版的UI变量更新器。根据用户消息里提供的最近对话，更新UI模板中受剧情影响的变量。',
    '只返回JSON，不要解释，不要输出Markdown。',
    '返回格式固定为 {"updates":[{"id":"模板id","variables":{"变量路径":"新值"},"reason":"简短原因"}]}。',
    'variables 只包含有变化的路径；值可以是文字、数字、对象或JSON数组。',
    '装备栏、背包、动态、聊天记录这类列表字段可直接返回完整数组，也可用 "feed.0.text" 这种路径更新单项。',
    '没有变化则返回 {"updates":[]}。不要修改HTML，不要编造模板未定义的字段，变量路径必须与当前变量完全一致。',
    '',
    '模板与当前变量如下：',
    JSON.stringify(payload, null, 2),
  ].join('\n')

  const user = recentFloors
    .map((f) => `[${f.role === 'user' ? f.name || '用户' : f.name || 'AI'}]：${f.content}`)
    .join('\n\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: `最近对话如下：\n\n${user}` },
  ]
}

/** 解析单个更新块内的 JSON 载荷为更新列表（state-sync 规则引擎复用） */
export function parseUpdatesPayload(raw: string): UiTemplateUpdate[] {
  const body = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // 尝试截取最外层 { ... }
    const s = body.indexOf('{')
    const e = body.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try { parsed = JSON.parse(body.slice(s, e + 1)) } catch { return [] }
    } else {
      return []
    }
  }
  if (Array.isArray(parsed)) return parsed as UiTemplateUpdate[]
  if (parsed && typeof parsed === 'object') {
    const p = parsed as { updates?: unknown[]; variables?: Record<string, unknown> }
    if (Array.isArray(p.updates)) return p.updates as UiTemplateUpdate[]
    if (p.variables && typeof p.variables === 'object') return [{ variables: p.variables }]
  }
  return []
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
