/**
 * 正则脚本引擎：内部统一模型 + 旧版/SillyTavern 格式互转。
 *
 * 内部模型（显式影响面，避免不同来源 placement 数字语义混淆）：
 *   { name, pattern, replace, flags, affectsUser, affectsAI, applyOnDisplay, applyOnSend, disabled }
 *   - applyOnDisplay：显示渲染层应用；applyOnSend：发送给 AI 前应用
 *   - 两者都 true ≈ ST 默认行为；只勾其一 ≈ ST 的 markdownOnly / promptOnly
 *
 * 兼容导入：
 *   - SillyTavern 扩展格式 {scriptName, findRegex(/p/f 或纯串), replaceString, placement[], markdownOnly, promptOnly, disabled, minDepth?, maxDepth?}
 *   - 旧版 旧版格式 {name?, find|regex, replacement|replaceText, flags, placement:[1用户输入,2AI输出]}
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
  // 调用本函数，若不识别 pattern 字段，编辑器创建的脚本会被当旧版格式丢掉 pattern 而静默失效
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
      applyOnSend: o.applyOnSend !== false,
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
    const mdOnly = o.markdownOnly === true
    const promptOnly = o.promptOnly === true
    const s: RegexScript = {
      id: typeof o.id === 'string' ? o.id : undefined,
      name: String(o.scriptName || o.name || '未命名'),
      pattern,
      replace,
      flags,
      affectsUser,
      affectsAI,
      applyOnDisplay: mdOnly || (!promptOnly && !mdOnly),
      applyOnSend: promptOnly || (!promptOnly && !mdOnly),
      disabled: o.disabled === true,
      minDepth: typeof o.minDepth === 'number' ? o.minDepth : null,
      maxDepth: typeof o.maxDepth === 'number' ? o.maxDepth : null,
    }
    return s
  }

  // 旧版 旧版格式
  pattern = typeof o.regex === 'string' && o.regex ? o.regex : String(o.find ?? '')
  replace = typeof o.replacement === 'string' ? o.replacement : String(o.replaceText ?? '')
  const pl = asArray(o.placement)
  if (pl.length) {
    affectsUser = pl.includes(1)
    affectsAI = pl.includes(2)
  }
  return {
    id: typeof o.id === 'string' ? o.id : undefined,
    name: String(o.name || '未命名'),
    pattern,
    replace,
    flags,
    affectsUser,
    affectsAI,
    applyOnDisplay: true,
    applyOnSend: true,
    disabled: o.disabled === true,
  }
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

/** 编译单个脚本为可执行正则（失败返回 null） */
function compile(s: RegexScript): RegExp | null {
  if (!s.pattern) return null
  let flags = s.flags || 'g'
  if (!flags.includes('g')) flags += 'g'
  try {
    return new RegExp(s.pattern, flags)
  } catch {
    return null
  }
}

/**
 * 对文本应用一批正则脚本。
 * @param layer 显示层(display)或发送层(send)；与脚本的 applyOn 开关和 affects 影响面共同决定是否生效
 */
export function applyRegexScripts(
  text: string,
  scripts: unknown,
  placement: number,
  layer: RegexLayer,
): string {
  let out = text || ''
  if (!Array.isArray(scripts) || !out) return out
  for (const raw of scripts) {
    const s = normalizeRegexScript(raw)
    if (!s || s.disabled) continue
    if (layer === 'display' && s.applyOnDisplay === false) continue
    if (layer === 'send' && s.applyOnSend === false) continue
    if (placement === PLACEMENT_USER_INPUT && s.affectsUser === false) continue
    if (placement === PLACEMENT_AI_OUTPUT && s.affectsAI === false) continue
    const re = compile(s)
    if (!re) continue
    try {
      out = out.replace(re, s.replace)
    } catch {
      // 替换串中的非法 $ 序列等异常：跳过该脚本
    }
  }
  return out
}

export const PLACEMENT_USER_INPUT = 1
export const PLACEMENT_AI_OUTPUT = 2
