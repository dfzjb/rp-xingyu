/**
 * AI KP 管线：剧情流 → 提示词 → 流式生成。
 * KP 在正文中以 <roll>XdY 检定名</roll> 请求检定；房主端掷骰、广播结果并自动续写一轮。
 * KP 还会在正文末尾用 <state>{...}</state> 上报战局变化（地点/道具/记忆），
 * 房主端解析合并进战局状态（见 gamestate.ts）——同一次生成顺带完成，零额外调用。
 */
import type { MemberInfo, RoomEvent } from './protocol'
import { PARTY_LINE, type HallScene } from './protocol'
import { isEmptyGameState, type HallGameState } from './gamestate'
import { renderModuleBlock, type GameModule } from './module'
import { KP_STYLES, rulePreset, type RoomSetting } from './rules'

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

/** KP 战局上报：<state>{"area":"...","add":[{"name":"...","note":"..."}],"remove":["..."],"mem":["..."]}</state>，字段均可省略 */
const STATE_RE = /<state>([\s\S]*?)<\/state>/gi

export interface StateUpdate {
  area?: string
  add?: { name: string; note: string }[]
  remove?: string[]
  mem?: string[]
}

/** 解析正文里最后一个 <state> 标记为宽容的结构；坏 JSON / 无标记返回 null */
export function extractStateUpdate(text: string): StateUpdate | null {
  const matches = [...text.matchAll(STATE_RE)]
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
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? '')) : [])
  const add = Array.isArray(o.add)
    ? o.add.map((x) => {
        if (x && typeof x === 'object' && !Array.isArray(x)) {
          const y = x as Record<string, unknown>
          return { name: String(y.name ?? ''), note: String(y.note ?? '') }
        }
        return { name: String(x ?? ''), note: '' } // 容忍 "火把" 字符串简写
      })
    : []
  return {
    area: o.area === undefined ? undefined : String(o.area ?? ''),
    add,
    remove: strArr(o.remove),
    mem: strArr(o.mem),
  }
}

export function stripStateBlocks(text: string): string {
  return text.replace(STATE_RE, '')
}

/** 剥掉检定与战局标记后的干净正文（用于展示与回注上下文） */
export function stripKpMarkup(text: string): string {
  return stripStateBlocks(stripRollRequests(text))
}

/** 剥掉检定、战局与模组进度标记后的干净正文（KP 定稿进剧情流用） */
export function stripKpOutput(text: string): string {
  return stripKpMarkup(text).replace(/<module>[\s\S]*?<\/module>/gi, '').trim()
}

const KP_SYSTEM = `你是一名跑团主持人（KP），正在主持一场自由团的多人在线跑团，玩家们各自扮演自己的角色。

职责与写法：
- 用旁白推进场景，用 NPC 台词与玩家互动；每次回复聚焦一个场景节点，给玩家留出行动空间，不要替玩家决定其角色的言行。
- 保持战役连贯，承接已发生的剧情事实与检定结果。
- 剧情按「线」平行推进：玩家可能分头行动（个人线/小组合作线）。你一次只叙事一条线——「近期剧情」只含当前线的经过，「分线动向」告诉你其他线上谁在做什么，注意各线时间与空间保持一致，不要把别的线的玩家写进当前场景。
- 需要做技能/属性检定时，在正文相应位置输出 <roll>骰子表达式 检定名</roll>（如 <roll>1d100 侦查</roll>），系统会自动掷骰并把结果回传给你，届时再依据成败续写。
- 每次回复不要输出多个 <roll>；没有检定需要时不要输出。
- 战局状态（当前区域/随身道具/关键记忆）由系统为你持久化：当剧情推进导致地点切换、道具得失、或出现值得长期记住的事实时，在正文结束后另起一行输出一次 <state>{"area":"...","add":[{"name":"...","note":"..."}],"remove":["道具名"],"mem":["..."]}</state>。字段均可省略；没有任何变化就完全不输出 <state>；mem 每次最多 2 条，只记关键事实与线索，不要记流水账。
- 直接输出正文，不要解释规则、不要总结自己、不要以「好的/以下是」开场。`

function renderEvent(e: RoomEvent): string {
  switch (e.k) {
    case 'chat':
      return `【玩家】${e.charName || e.name}：${e.text}`
    case 'narration':
      return `【旁白】${e.text}`
    case 'roll':
      return `【检定】${e.charName || e.name} 掷 ${e.detail}`
    case 'wheel':
      return `【转盘】${e.charName || e.name} 转动「${e.tableName}」：${e.label}${e.note ? `（${e.note}）` : ''}`
    default:
      return '' // system 等界面级事件不喂给 KP
  }
}

export interface KpContext {
  events: RoomEvent[]
  members: MemberInfo[]
  /** 房主追加的世界观/团规备注，可为空 */
  worldNote?: string
  /** 详细模式创建时填写的开团设定，可为空 */
  setting?: RoomSetting | null
  /** 剧情模组定义（章节/路线/结局/随机表）；空 = 无模组自由团，不注入 */
  module?: GameModule | null
  /** 当前战局状态（区域/道具/记忆），注入提示词保证长团不失忆；空则不注入 */
  state?: HallGameState | null
  /** 当前叙事的线名（缺省 = 全体主线）；自定义线时近期剧情只含本线 */
  scene?: string
  /** 分线动向块（renderSceneBlock 产出），空串不注入 */
  sceneBlock?: string
  /** 注入上下文的剧情条数上限 */
  maxEvents?: number
}

/** 把结构化开团设定渲染成 KP 可读的设定块；空字段跳过 */
export function renderSettingBlock(s: RoomSetting): string {
  const lines: string[] = []
  const custom = s.system === 'custom' ? s.systemCustom.trim() : ''
  const preset = rulePreset(s.system)
  const ruleName = custom || preset.name
  lines.push(`- 规则系统：${ruleName}。${custom ? '' : preset.rollConventions}`)
  if (custom) lines.push('- 检定约定按上述自定义规则执行；KP 自行选择合理的骰子表达式。')
  if (s.era.trim()) lines.push(`- 时代背景：${s.era.trim()}（NPC、职业、装备、用语须符合时代）`)
  if (s.tones.length) lines.push(`- 团的基调：${s.tones.join('、')}`)
  if (s.players > 0) lines.push(`- 预期玩家：${s.players} 人`)
  if (s.world.trim()) lines.push(`- 世界观与舞台：\n${s.world.trim()}`)
  if (s.module.trim()) lines.push(`- 模组/剧情梗概（KP 秘密，不要提前剧透给玩家）：\n${s.module.trim()}`)
  if (s.opening.trim()) lines.push(`- 开场场景：${s.opening.trim()}`)
  if (s.npcs.trim()) lines.push(`- 关键 NPC：\n${s.npcs.trim()}`)
  if (s.houseRules.trim()) lines.push(`- 房规（优先级高于默认规则）：\n${s.houseRules.trim()}`)
  if (s.redlines.trim()) lines.push(`- 内容红线（绝不在正文中出现的描写）：\n${s.redlines.trim()}`)
  const style = KP_STYLES.find((k) => k.id === s.kpStyle)
  if (style) lines.push(`- KP 风格：${style.hint}`)
  if (s.sceneNotes.trim()) lines.push(`- 场景/地图备注（保持空间与方位连贯）：\n${s.sceneNotes.trim()}`)
  return `【开团设定】\n${lines.join('\n')}`
}

/** 事件所属线（不带 scene 字段 = 全体主线，老事件天然兼容） */
export function lineOf(e: RoomEvent): string {
  return ('scene' in e && e.scene) || PARTY_LINE
}

/**
 * 分线动向块：各线谁在做什么（取各线最近发言的角色），给 KP 跨线时空感。
 * 只有一条全体线且无自定义线时返回空串，不占提示词。
 */
export function renderSceneBlock(scenes: HallScene[], events: RoomEvent[]): string {
  if (!scenes.length) return ''
  const lines: string[] = []
  const render = (id: string, title: string, bound: string): string => {
    const seen = new Set<string>()
    const who: string[] = []
    if (bound) { who.push(bound); seen.add(bound) }
    for (let i = events.length - 1; i >= 0 && who.length < 6; i--) {
      const e = events[i]
      if (e.k !== 'chat' || lineOf(e) !== id) continue
      const char = e.charName || e.name
      if (char && !seen.has(char)) { seen.add(char); who.push(char) }
    }
    return `- ${title}：${who.length ? who.join('、') : '（还没有动静）'}`
  }
  lines.push(render(PARTY_LINE, '全体（主线）', ''))
  for (const s of scenes) lines.push(render(s.id, `${s.name}${s.closed ? '（已收线）' : ''}`, s.member))
  return `【分线动向】（各线平行推进，只叙事当前线；跨线引用时保持时间与空间一致）\n${lines.join('\n')}`
}

/** 把当前战局状态渲染成 KP 可读的状态块（长团靠它兜底，超出演义截断窗口的剧情事实也丢不了）；空状态返回空串 */
export function renderStateBlock(s: HallGameState): string {
  const lines: string[] = []
  if (s.area.trim()) lines.push(`- 当前区域：${s.area.trim()}`)
  if (s.items.length) lines.push(`- 随身道具：${s.items.map((i) => (i.note ? `${i.name}（${i.note}）` : i.name)).join('、')}`)
  if (s.memories.length) lines.push(`- 关键记忆：\n${s.memories.map((m, i) => `  ${i + 1}. ${m.text}`).join('\n')}`)
  if (!lines.length) return ''
  return `【战局状态】（以下内容系统已替你记住，不要复述；只在有变化时按约定输出 <state>）\n${lines.join('\n')}`
}

/** 组装 KP 请求：system（规则+开团设定+战局状态+玩家名单）+ user（近期剧情） */
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
    (ctx.setting ? `\n\n${renderSettingBlock(ctx.setting)}` : '') +
    (ctx.module ? `\n\n${renderModuleBlock(ctx.module, ctx.state?.progress)}` : '') +
    (ctx.scene && ctx.scene !== PARTY_LINE ? `\n\n当前叙事线：${ctx.scene}（「近期剧情」只含本线经过，其他线见分线动向）` : '') +
    (ctx.sceneBlock ? `\n\n${ctx.sceneBlock}` : '') +
    (ctx.state && !isEmptyGameState(ctx.state) ? `\n\n${renderStateBlock(ctx.state)}` : '') +
    (ctx.worldNote ? `\n\n世界观与团规备注：\n${ctx.worldNote}` : '') +
    (roster ? `\n\n玩家名单：\n${roster}` : '')

  const onCustomLine = !!ctx.scene && ctx.scene !== PARTY_LINE
  const openingGuide = ctx.setting?.opening.trim()
    ? '（战役刚开始，请以「开团设定」里的开场场景为起点写一段开场旁白，把玩家带入情境并邀请他们介绍自己的角色入场）'
    : '（战役刚开始，请以一段开场旁白引入，并邀请玩家们介绍自己的角色入场）'
  const lineGuide = `（「${ctx.scene}」这条线还没有动静：从这条线的切入点写一段开场旁白，把线上的玩家带入情境；时空上须与分线动向里其他线的进度衔接）`
  const userHeader = onCustomLine ? `当前叙事线：「${ctx.scene}」\n近期剧情：\n` : '近期剧情：\n'
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${userHeader}${recent || (onCustomLine ? lineGuide : openingGuide)}` },
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
