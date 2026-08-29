/**
 * 基础宏系统（酒馆宏子集）：{{char}} {{user}} {{time}} {{date}} {{datetimeformat ...}} {{random:a|b}} {{pick:a|b}}
 * 在提示词组装与显示渲染前调用。
 */
export interface MacroContext {
  charName?: string
  userName?: string
}

/** 替换文本中的受支持宏（未知宏原样保留） */
export function replaceMacros(text: string, ctx: MacroContext = {}): string {
  if (!text) return text
  const char = ctx.charName || 'char'
  const user = ctx.userName || '我'
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

  let out = text
  out = out.split('{{char}}').join(char)
  out = out.split('{{user}}').join(user)
  out = out.split('{{time}}').join(timeStr)
  out = out.split('{{date}}').join(dateStr)
  out = out.replace(/\{\{(?:random|pick):([^}]+)\}\}/g, (_m, list: string) => {
    const opts = list.split('|').map((s) => s.trim()).filter(Boolean)
    return opts.length ? opts[Math.floor(Math.random() * opts.length)] : ''
  })

  // {{roll:dN}} 掷骰
  out = out.replace(/\{\{roll\s*:\s*d?(\d+)\}\}/gi, (_m, n: string) => {
    const max = Math.max(2, parseInt(n, 10) || 6)
    return String(1 + Math.floor(Math.random() * max))
  })
  return out
}
