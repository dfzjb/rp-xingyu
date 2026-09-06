/**
 * 正则脚本引擎：内部统一模型 + SillyTavern 格式互转。
 *
 * 内部模型（显式影响面，避免不同来源 placement 数字语义混淆）：
 *   { name, pattern, replace, flags, affectsUser, affectsAI, applyOnDisplay, applyOnSend, disabled }
 *   - applyOnDisplay：显示渲染层应用；applyOnSend：发送给 AI 前应用
 *   - 两者都 true ≈ ST 默认行为；只勾其一 ≈ ST 的 markdownOnly / promptOnly
 *
 * 兼容导入：
 *   - SillyTavern 扩展格式 {scriptName, findRegex(/p/f 或纯串), replaceString, placement[], markdownOnly, promptOnly, disabled, minDepth?, maxDepth?}
 */
export interface RegexScript {
  id?: string
  name?: string
  pattern: string
  replace: string
  flags?: string
  affectsUser?: boolean
  affectsAI?: boolean
  applyOnDisplay?: boolean
  applyOnSend?: boolean
  disabled?: boolean
  minDepth?: number | null
  maxDepth?: number | null
  [k: string]: unknown
}

export type RegexLayer = 'display' | 'send'

function asArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map(Number).filter((n) => !Number.isNaN(n)) : []
}

/** 是否为酒馆扩展格式 */
function isStFormat(o: Record<string, unknown>): boolean {
  return typeof o.findRegex === 'string' || typeof o.scriptName === 'string'
}

function parseSlashPattern(findRegex: string): { src: string; flags: string } {
  const m = findRegex.match(/^\/(.+)\/([a-z]*)$/s)
  if (m) return { src: m[1], flags: m[2] || 'g' }
  return { src: findRegex, flags: 'g' }
}

/** 任意来源 → 内部模型 */
export function normalizeRegexScript(raw: unknown): RegexScript | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, any>
  // 内部模型（正则编辑器保存的形状）原样归一化：applyRegexScripts 会对库里每条脚本
  // 调用本函数，若不识别 pattern 字段，编辑器创建的脚本会被当外部格式丢掉 pattern 而静默失效
  if (typeof o.pattern === 'string') {
    return {
      id: typeof o.id === 'string' ? o.id : undefined,
      name: String(o.name || '未命名'),
      pattern: o.pattern,
      replace: String(o.replace ?? ''),
      flags: typeof o.flags === 'string' && o.flags ? o.flags : 'g',
      affectsUser: o.affectsUser !== false,
      affectsAI: o.affectsAI !== false,
      applyOnDisplay: o.applyOnDisplay !== false,
      // 默认只做显示层美化（与 ST 一致），不进发给模型的 prompt；需显式开启才在发送层执行
      applyOnSend: o.applyOnSend === true,
      disabled: o.disabled === true,
      minDepth: typeof o.minDepth === 'number' ? o.minDepth : null,
      maxDepth: typeof o.maxDepth === 'number' ? o.maxDepth : null,
    }
  }
  let pattern = ''
  let replace = ''
  let flags = o.flags && typeof o.flags === 'string' ? o.flags : 'g'
  let affectsUser = true
  let affectsAI = true

  if (isStFormat(o)) {
    const p = parseSlashPattern(String(o.findRegex || ''))
    pattern = p.src
    flags = p.flags || 'g'
    replace = String(o.replaceString ?? '')
    const pl = asArray(o.placement)
    // 酒馆编码：1=User Input 2=AI Response 3=Slash Command 4=World Info 5=Reasoning
    if (pl.length) {
      affectsUser = pl.includes(1)
      affectsAI = pl.includes(2)
    }
    // SillyTavern 语义：
    //   两个开关都不勾 = 仅显示层美化（不进发给模型的 prompt）；
    //   markdownOnly=仅显示；promptOnly=仅发送层（进 prompt，不显示）；两者同勾按仅显示处理。
    let mdOnly = o.markdownOnly === true
    let promptOnly = o.promptOnly === true
    if (mdOnly && promptOnly) promptOnly = false
    const s: RegexScript = {
      id: typeof o.id === 'string' ? o.id : undefined,
      name: String(o.scriptName || o.name || '未命名'),
      pattern,
      replace,
      flags,
      affectsUser,
      affectsAI,
      applyOnDisplay: !promptOnly,
      applyOnSend: promptOnly,
      disabled: o.disabled === true,
      minDepth: typeof o.minDepth === 'number' ? o.minDepth : null,
      maxDepth: typeof o.maxDepth === 'number' ? o.maxDepth : null,
    }
    return s
  }

  // 未知形状：无法识别则丢弃
  return null
}

/** 内部模型 → 酒馆扩展导出格式 */
export function toStRegexExport(s: RegexScript): Record<string, unknown> {
  const placement: number[] = []
  if (s.affectsUser !== false) placement.push(1)
  if (s.affectsAI !== false) placement.push(2)
  return {
    scriptName: s.name || 'script',
    findRegex: `/${s.pattern}/${s.flags || 'g'}`,
    replaceString: s.replace,
    placement,
    disabled: s.disabled === true,
    markdownOnly: s.applyOnDisplay === true && s.applyOnSend !== true,
    promptOnly: s.applyOnSend === true && s.applyOnDisplay !== true,
    runOnEdit: true,
    minDepth: s.minDepth ?? null,
    maxDepth: s.maxDepth ?? null,
  }
}

/**
 * 剥离 SillyTavern 正则常见的内联修饰符 (?i)(?m)(?s)（含组合如 (?im) 与关闭形式 (?-i)）。
 * JavaScript RegExp 不支持这些 PCRE 式内联标记（(?s) 直接 SyntaxError），
 * 需转为等价 flags：i=忽略大小写、m=多行、s=dotAll（现代浏览器均支持）。
 */
export function extractInlineFlags(pattern: string, baseFlags = ''): { pattern: string; flags: string } {
  const flagSet = new Set(baseFlags.replace(/[^gimsuy]/g, '').split('').filter(Boolean))
  const cleaned = pattern.replace(/\(\?([-ims]+)\)/g, (_m, inner: string) => {
    let on = true
    for (const ch of inner) {
      if (ch === '-') { on = false; continue }
      if (on && (ch === 'i' || ch === 'm' || ch === 's')) flagSet.add(ch)
    }
    return ''
  })
  return { pattern: cleaned, flags: [...flagSet].join('') }
}

/**
 * 受保护段：整页 HTML、script/style、
 * cot/think 思维链块、Markdown 代码块、行内代码、HTML 标签——普通正则不进入这些段，
 * 防止把卡内 HTML UI / 代码示例改坏。捕获组用于 split 后逐段识别。
 */
const PROTECTED_SOURCE =
  '(<!DOCTYPE html>[\\s\\S]*?<\\/html>|<html\\b[^>]*>[\\s\\S]*?<\\/html>|<script\\b[^>]*>[\\s\\S]*?<\\/script>|<style\\b[^>]*>[\\s\\S]*?<\\/style>|<(?:cot|think)>[\\s\\S]*?(?:<\\/(?:cot|think)>|<(?:cot|think)>|$)|```[\\s\\S]*?```|`[^`]+`|<\\/?[a-zA-Z][\\w:-]*[^>]*>)'
const PROTECTED_SPLIT = new RegExp(PROTECTED_SOURCE, 'gi')
const PROTECTED_TEST = new RegExp('^(?:' + PROTECTED_SOURCE + ')$', 'i')

/** 判断片段本身是否为受保护段 */
function isProtectedPart(part: string): boolean {
  PROTECTED_TEST.lastIndex = 0
  return PROTECTED_TEST.test(part)
}

/**
 * 带保护的替换：只对普通文本段执行 re，受保护段原样保留。
 * 若正则自身就在匹配 HTML/代码块（pattern 含 <> 或 ```），视为用户有意操作，跳过保护。
 */
export function protectedReplace(text: string, re: RegExp, replacement: string, scriptName?: string): string {
  if (/[<>]/.test(re.source) || re.source.includes('```') || scriptName === 'Auto Replace {{user}}') {
    return text.replace(re, replacement)
  }
  PROTECTED_SPLIT.lastIndex = 0
  return text
    .split(PROTECTED_SPLIT)
    .map((part) => (!part || isProtectedPart(part) ? part : part.replace(re, replacement)))
    .join('')
}

/** 编译单个脚本为可执行正则（失败返回 null）；自动剥离内联修饰符 */
function compile(s: RegexScript): RegExp | null {
  if (!s.pattern) return null
  // 斜杠写法 /pattern/flags 优先解析
  let pattern = s.pattern
  let flags = s.flags || ''
  const slash = pattern.match(/^\/(.+)\/([a-z]*)$/s)
  if (slash) {
    pattern = slash[1]
    flags = slash[2] || flags
  }
  const extracted = extractInlineFlags(pattern, flags)
  pattern = extracted.pattern
  flags = extracted.flags
  if (!flags.includes('g')) flags += 'g'
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/**
 * 对文本应用一批正则脚本。
 * @param layer 显示层(display)或发送层(send)；与脚本的 applyOn 开关和 affects 影响面共同决定是否生效
 * @param options.depth 该文本距最新消息的层数（0=最新），用于执行脚本的 minDepth/maxDepth 深度定向
 */
export function applyRegexScripts(
  text: string,
  scripts: unknown,
  placement: number,
  layer: RegexLayer,
  options?: { depth?: number },
): string {
  let out = text || ''
  if (!Array.isArray(scripts) || !out) return out
  const depth = options?.depth
  for (const raw of scripts) {
    const s = normalizeRegexScript(raw)
    if (!s || s.disabled) continue
    if (layer === 'display' && s.applyOnDisplay === false) continue
    if (layer === 'send' && s.applyOnSend === false) continue
    if (placement === PLACEMENT_USER_INPUT && s.affectsUser === false) continue
    if (placement === PLACEMENT_AI_OUTPUT && s.affectsAI === false) continue
    // 深度定向：只作用于 [minDepth, maxDepth] 楼层区间（depth 缺省时不限制，保持向后兼容）
    if (typeof depth === 'number') {
      if (typeof s.minDepth === 'number' && depth < s.minDepth) continue
      if (typeof s.maxDepth === 'number' && depth > s.maxDepth) continue
    }
    const re = compile(s)
    if (!re) continue
    try {
      out = protectedReplace(out, re, s.replace, s.name)
    } catch {
      // 替换串中的非法 $ 序列等异常：跳过该脚本
    }
  }
  return out
}

export const PLACEMENT_USER_INPUT = 1
export const PLACEMENT_AI_OUTPUT = 2
