/**
 * AI KP 管线：剧情流 → 提示词 → 流式生成。
 * KP 在正文中以 <roll>XdY 检定名</roll> 请求检定；房主端掷骰、广播结果并自动续写一轮。
 */
import type { MemberInfo, RoomEvent } from './protocol'

export interface HallApiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** KP 检定请求：<roll>1d100 侦查</roll> —— 空格前是骰子表达式，后面是检定名 */
const ROLL_RE = /<roll>([^<]+?)<\/roll>/g

export interface RollRequest {
  expr: string
  label: string
}

export function extractRollRequests(text: string): RollRequest[] {
  const out: RollRequest[] = []
  for (const m of text.matchAll(ROLL_RE)) {
    const body = m[1].trim()
    const sp = body.indexOf(' ')
    const expr = (sp >= 0 ? body.slice(0, sp) : body).trim()
    const label = sp >= 0 ? body.slice(sp + 1).trim() : ''
    if (expr) out.push({ expr, label })
  }
  return out
}

export function stripRollRequests(text: string): string {
  return text.replace(ROLL_RE, '').trim()
}

const KP_SYSTEM = `你是一名跑团主持人（KP），正在主持一场自由团的多人在线跑团，玩家们各自扮演自己的角色。

职责与写法：
- 用旁白推进场景，用 NPC 台词与玩家互动；每次回复聚焦一个场景节点，给玩家留出行动空间，不要替玩家决定其角色的言行。
- 保持战役连贯，承接已发生的剧情事实与检定结果。
- 需要做技能/属性检定时，在正文相应位置输出 <roll>骰子表达式 检定名</roll>（如 <roll>1d100 侦查</roll>），系统会自动掷骰并把结果回传给你，届时再依据成败续写。
- 每次回复不要输出多个 <roll>；没有检定需要时不要输出。
- 直接输出正文，不要解释规则、不要总结自己、不要以「好的/以下是」开场。`

function renderEvent(e: RoomEvent): string {
  switch (e.k) {
    case 'chat':
      return `【玩家】${e.charName || e.name}：${e.text}`
    case 'narration':
      return `【旁白】${e.text}`
    case 'roll':
      return `【检定】${e.charName || e.name} 掷 ${e.detail}`
    default:
      return '' // system 等界面级事件不喂给 KP
  }
}

export interface KpContext {
  events: RoomEvent[]
  members: MemberInfo[]
  /** 房主追加的世界观/团规备注，可为空 */
  worldNote?: string
  /** 注入上下文的剧情条数上限 */
  maxEvents?: number
}

/** 组装 KP 请求：system（规则+玩家名单）+ user（近期剧情） */
export function buildKpMessages(ctx: KpContext): HallApiMessage[] {
  const roster = ctx.members
    .map((m) => `- ${m.charName || m.name}（玩家 ${m.name}${m.role === 'host' ? '，房主' : ''}）${m.persona ? `：${m.persona}` : ''}`)
    .join('\n')

  const maxEvents = ctx.maxEvents ?? 40
  const recent = ctx.events
    .slice(-maxEvents)
    .map(renderEvent)
    .filter(Boolean)
    .join('\n')

  const system = KP_SYSTEM +
    (ctx.worldNote ? `\n\n世界观与团规备注：\n${ctx.worldNote}` : '') +
    (roster ? `\n\n玩家名单：\n${roster}` : '')

  return [
    { role: 'system', content: system },
    { role: 'user', content: `近期剧情：\n${recent || '（战役刚开始，请以一段开场旁白引入，并邀请玩家们介绍自己的角色入场）'}` },
  ]
}

/** 检定结果回注给 KP 的续写指令 */
export function buildRollNudge(results: { label: string; detail: string }[]): HallApiMessage {
  const lines = results.map((r) => `- ${r.label || '检定'}：${r.detail}`).join('\n')
  return {
    role: 'user',
    content: `检定结果如下，请依据成败继续推进剧情：\n${lines}`,
  }
}
