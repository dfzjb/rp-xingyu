/**
 * 变量回写规则引擎：正则驱动的"更新指令 → 解析"泛化层。
 *
 * 内置的 <ui_template_updates> 通道（ui-template-state.ts）只认 旧版 自有方言；
 * 其他生态角色卡（酒馆 Variables 框架的 <UpdateVariable>、{{setvar}} 宏、任意自定义
 * 标签块）的更新指令会被当正文丢弃。本模块把"从 AI 回复中提取变量更新"抽象成
 * 可配置的正则规则，随角色卡携带（char.stateSyncRules），任何卡都能接上回写闭环。
 *
 * 规则模型：
 *   { name, pattern(正则源码，捕获组1=载荷), flags, dialect, template?, disabled? }
 *   - legacy_json   载荷为 {"updates":[{id?,name?,variables:{路径:值}}]}（兼容裸 variables / 数组）
 *   - json_block    载荷为 {路径:值} 平铺 JSON（可带 id/name/template 元字段，或 updates 数组）
 *   - macro_setvar  正则需带命名捕获组 (?<path>…) / (?<value>…)（或缺省取第 1/2 组）
 */
import type { UiTemplateUpdate } from './ui-template-state'
import { parseUpdatesPayload } from './ui-template-state'

export type StateSyncDialect = 'legacy_json' | 'json_block' | 'macro_setvar'

export interface StateSyncRule {
  id?: string
  name: string
  /** 匹配单个更新块的正则源码；除 macro_setvar 外捕获组 1 = 载荷 */
  pattern: string
  flags?: string
  dialect: StateSyncDialect
  /** json_block / macro_setvar 的固定目标模板（id 或名称）；缺省走载荷内 id/name 或唯一模板 */
  template?: string
  /** 残缺开块剥离正则源码（输出被 max_tokens 截断时，开标签后没有闭合标签，pattern 匹配不到，需要单独剥到文末） */
  openPattern?: string
  disabled?: boolean
}

/** 内置规则：旧版 原生块 + 酒馆 <UpdateVariable> 默认开启；{{setvar}} 宏误伤面大，默认关闭可手动启用 */
export function builtinStateSyncRules(): StateSyncRule[] {
  return [
    {
      id: 'builtin-legacy-updates',
      name: '旧版 更新块 <ui_template_updates>',
      pattern: '<ui_template_updates\\b[^>]*>([\\s\\S]*?)</ui_template_updates>',
      openPattern: '<ui_template_updates\\b[^>]*>[\\s\\S]*$',
      flags: 'gi',
      dialect: 'legacy_json',
    },
    {
      id: 'builtin-update-variable',
      name: '酒馆变量块 <UpdateVariable>',
      pattern: '<UpdateVariable\\b[^>]*>([\\s\\S]*?)</UpdateVariable>',
      openPattern: '<UpdateVariable\\b[^>]*>[\\s\\S]*$',
      flags: 'gi',
      dialect: 'json_block',
    },
    {
      id: 'builtin-setvar-macro',
      name: '酒馆宏 {{setvar}} / {{setglobalvar}}',
      pattern: '\\{\\{set(?:global)?var::(?<path>[^:{}]+)::(?<value>[\\s\\S]*?)\\}\\}',
      flags: 'g',
      dialect: 'macro_setvar',
      disabled: true,
    },
  ]
}

const DIALECTS: StateSyncDialect[] = ['legacy_json', 'json_block', 'macro_setvar']

/** 任意来源 → 规范规则（字段宽松兼容 enabled/disabled、dialect 别名）；正则编译失败返回 null */
export function normalizeStateSyncRule(raw: unknown): StateSyncRule | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, any>
  const pattern = typeof o.pattern === 'string' ? o.pattern : typeof o.regex === 'string' ? o.regex : ''
  if (!pattern) return null
  const rawDialect = String(o.dialect || o.parser || 'json_block').toLowerCase()
  const dialect = (DIALECTS.includes(rawDialect as StateSyncDialect) ? rawDialect : 'json_block') as StateSyncDialect
  try {
    void new RegExp(pattern, typeof o.flags === 'string' && o.flags ? o.flags : 'g')
  } catch {
    return null
  }
  return {
    id: typeof o.id === 'string' ? o.id : undefined,
    name: String(o.name || '未命名回写规则'),
    pattern,
    flags: typeof o.flags === 'string' && o.flags ? o.flags : 'g',
    dialect,
    template: typeof o.template === 'string' && o.template ? o.template : undefined,
    openPattern: typeof o.openPattern === 'string' && o.openPattern ? o.openPattern : undefined,
    disabled: o.disabled === true || o.enabled === false,
  }
}

export function normalizeStateSyncRules(list: unknown): StateSyncRule[] {
  if (!Array.isArray(list)) return []
  return list.map(normalizeStateSyncRule).filter((r): r is StateSyncRule => !!r && !r.disabled)
}

/** setvar 宏值类型矫正：纯数字/布尔转对应类型，避免每次更新都因 "80"≠80 判定为变更 */
function coerceScalar(v: string): unknown {
  const t = v.trim()
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t)
  if (/^true$/i.test(t)) return true
  if (/^false$/i.test(t)) return false
  return v.trim()
}

const JSON_META_KEYS = new Set(['id', 'name', 'template', '模板', '名称', 'target', 'reason', '原因'])

/** json_block 载荷 → 更新列表：兼容 updates 数组 / variables 包装 / 平铺 {路径:值} */
function parseJsonBlockPayload(raw: string, rule: StateSyncRule): UiTemplateUpdate[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try { parsed = JSON.parse(raw.slice(s, e + 1)) } catch { return [] }
    } else {
      return []
    }
  }
  const fromObject = (obj: Record<string, unknown>): UiTemplateUpdate | null => {
    if (Array.isArray(obj.updates)) return null // 交给 legacy 语义处理
    if (obj.variables && typeof obj.variables === 'object' && !Array.isArray(obj.variables)) {
      return {
        id: typeof obj.id === 'string' ? obj.id : undefined,
        name: typeof obj.name === 'string' ? obj.name : undefined,
        variables: obj.variables as Record<string, unknown>,
      }
    }
    const vars: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (!JSON_META_KEYS.has(k)) vars[k] = v
    }
    return Object.keys(vars).length
      ? {
          id: typeof obj.id === 'string' ? obj.id : undefined,
          name: typeof (obj.name ?? obj.template) === 'string' ? String(obj.name ?? obj.template) : undefined,
          variables: vars,
        }
      : null
  }
  if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => fromObject(x)).filter(Boolean) as UiTemplateUpdate[]
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    if (Array.isArray(o.updates)) return parseUpdatesPayload(raw)
    const upd = fromObject(o)
    return upd ? [upd] : []
  }
  return []
}

/** macro_setvar 载荷：命名组 path/value（或缺省 1/2 组）→ 单路径更新 */
function parseMacroPayload(m: RegExpExecArray, rule: StateSyncRule): UiTemplateUpdate | null {
  const g = m.groups || {}
  const path = String(g.path ?? m[1] ?? '').trim()
  const value = g.value ?? m[2]
  if (!path || value === undefined) return null
  const target = rule.template
  return {
    id: target && /^[\w-]{8,}$/.test(target) ? target : undefined,
    name: target && !/^[\w-]{8,}$/.test(target) ? target : undefined,
    variables: { [path]: coerceScalar(value) },
  }
}

function compileRule(rule: StateSyncRule): RegExp | null {
  try {
    return new RegExp(rule.pattern, rule.flags || 'g')
  } catch {
    return null
  }
}

/**
 * 按 rules 从 AI 回复中提取全部变量更新（所有启用的内置规则 + 卡级规则一起跑，
 * 目标是 UiTemplate 的变量路径；applyUiTemplateUpdates 负责定位模板与写值）。
 */
export function extractStateSyncUpdates(text: string, rules: StateSyncRule[]): UiTemplateUpdate[] {
  const src = String(text || '')
  const out: UiTemplateUpdate[] = []
  for (const rule of rules) {
    if (rule.disabled) continue
    const re = compileRule(rule)
    if (!re) continue
    let m: RegExpExecArray | null
    let guard = 0
    while ((m = re.exec(src)) && guard++ < 500) {
      if (rule.dialect === 'macro_setvar') {
        const upd = parseMacroPayload(m, rule)
        if (upd) out.push(upd)
      } else if (rule.dialect === 'legacy_json') {
        out.push(...parseUpdatesPayload(m[1]))
      } else {
        out.push(...parseJsonBlockPayload(m[1], rule).map((u) => (rule.template && !u.id && !u.name ? { ...u, ...resolveTemplateTarget(rule.template) } : u)))
      }
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return out
}

function resolveTemplateTarget(template: string): Partial<UiTemplateUpdate> {
  return /^[\w-]{8,}$/.test(template) ? { id: template } : { name: template }
}

/** 按规则剥离 AI 回复中的更新块（显示层与发送给模型的历史共用）；规则编译失败静默跳过。
 *  同时剥离「只写了开标签就被 max_tokens 截断」的残缺块，避免裸机器指令残留在正文末尾。 */
export function stripStateSyncBlocks(text: string, rules: StateSyncRule[]): string {
  let out = String(text || '')
  for (const rule of rules) {
    if (rule.disabled) continue
    const re = compileRule(rule)
    if (!re) continue
    re.lastIndex = 0
    out = out.replace(re, '')
    // 残缺开块（无闭合标签）：openPattern 剥到文末
    if (rule.openPattern) {
      try {
        const openRe = new RegExp(rule.openPattern, rule.flags?.includes('i') ? 'i' : '')
        out = out.replace(openRe, '')
      } catch { /* 编译失败忽略 */ }
    }
  }
  return out
}

/** 正文里是否存在「开标签已出现但闭合标签缺失」的残缺更新块（典型：输出被 max_tokens 截断） */
export function hasUnclosedSyncBlock(text: string, rules: StateSyncRule[]): boolean {
  // 先只剥「完整闭合块」，再看是否仍残留开标签；残留即被截断的残缺块
  let closedOnly = String(text || '')
  for (const rule of rules) {
    if (rule.disabled) continue
    const re = compileRule(rule)
    if (!re) continue
    re.lastIndex = 0
    closedOnly = closedOnly.replace(re, '')
  }
  for (const rule of rules) {
    if (rule.disabled || !rule.openPattern) continue
    try {
      const openRe = new RegExp(rule.openPattern, rule.flags?.includes('i') ? 'i' : '')
      if (openRe.test(closedOnly)) return true
    } catch { /* ignore */ }
  }
  return false
}
