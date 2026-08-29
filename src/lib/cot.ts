/**
 * 思维链解析：兼容旧版消息格式。
 * - CoT 以 <think>…</think> 或 <cot>…</cot> 标签嵌在正文里（支持未闭合、闭合格式不规范）
 * - 部分消息另有独立 reasoning 字段
 * - 正文尾部 [系统指令: …] 段视为系统注记，单独展示
 */
export interface ParsedContent {
  cot: string
  main: string
  sys: string
  cotFinished: boolean
}

const COT_PATTERN = /<(think|cot)>([\s\S]*?)(?:<\/\s*\1\s*>|<\s*\1\s*>|$)/gi
const SYS_PATTERN = /\n\n\[系统指令:\s*([\s\S]*?)\]\s*$/

export function parseCot(text: string): ParsedContent {
  if (!text) return { cot: '', main: '', sys: '', cotFinished: false }
  let cotContent = ''
  let isFinished = false
  const mainContent = text.replace(COT_PATTERN, (_match, tag: string, content: string, offset: number, full: string) => {
    // 引用块与代码块里的 < 保持原样，其余转义防止渲染层吞标签
    const parts = content.split(/(```[\s\S]*?```|`[^`]+`)/)
    const escaped = parts
      .map((p, i) => (i % 2 === 1 ? p : p.replace(/</g, '&lt;')))
      .join('')
    cotContent += escaped
    if (full.slice(offset ?? 0).includes('</')) isFinished = true
    return ''
  })

  let sys = ''
  let main = mainContent
  const sysMatch = main.match(SYS_PATTERN)
  if (sysMatch && typeof sysMatch.index === 'number') {
    sys = sysMatch[1]
    main = main.slice(0, sysMatch.index) + main.slice(sysMatch.index + sysMatch[0].length)
  }
  return { cot: cotContent.trim(), main: main.trim(), sys: sys.trim(), cotFinished: isFinished }
}

/** 统计正文口径的字数（思维链/系统指令不计入，与旧版 getConversationBodyLength 对齐） */
export function bodyLength(text: string): number {
  return parseCot(text || '').main.length
}
