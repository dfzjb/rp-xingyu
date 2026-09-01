/**
 * 提示词组装（对齐旧版 + SillyTavern 语义）：
 * system = [预设前缀条目] → 角色卡(system_prompt 覆盖或 描述/性格/场景) → 人设 → 世界书(before_char)
 *          → 示例对话(<START> 分块) → 世界书(after_char) → 预设 system 条目
 * 历史 = 消息链（正则应用后），经典记忆按绑定 AI 消息之后插入，未绑定记忆插在历史最前
 * 尾部 = post_history_instructions(历史后指令) + @深度世界书条目 + 预设 user/assistant 条目
 */
import type { CharacterCard, MemoryEntry, MsgNode, Persona, PromptPreset } from '../types'
import { parseCot } from './cot'
import { applyRegexScripts, PLACEMENT_AI_OUTPUT, PLACEMENT_USER_INPUT } from './regex'
import { replaceMacros } from './macros'
import { resolveWorldInfo, type WorldInfoEntry } from './worldinfo'
import type { UiTemplate } from './uitemplate'
import { buildUiTemplateContextPrompt, buildUiTemplateUpdateInstruction } from './ui-template-state'
import { builtinStateSyncRules, stripStateSyncBlocks, type StateSyncRule } from './state-sync'

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface PromptOptions {
  regexScripts?: unknown
  regexEnabled?: boolean
  memories?: MemoryEntry[]
  memoryCharLimit?: number
  promptEntries?: PromptPreset[]
  /** 一次性临时规范指令（旧版"随下次发送附带"） */
  pendingInstruction?: string
  /** 好感度状态行（每个已追踪 NPC 一条） */
  affinityLines?: string[]
  /** 角色卡启用的 UI 模板（用于变量状态注入 + 更新指令） */
  uiTemplates?: UiTemplate[]
  /** 会话级 UI 模板变量状态 */
  uiTemplateStates?: Record<string, Record<string, unknown>>
  /** 变量回写规则（含内置方言）；历史消息按此剥离更新块，缺省按内置规则剥离 */
  stateSyncRules?: StateSyncRule[]
}

/** 节点正文：剥思维链 → 剥变量更新块（规则化）→ 应用正则 → 替换宏 */
function nodeBody(n: MsgNode, opts: PromptOptions, ctx: { charName: string; userName: string }): string {
  let main = parseCot(n.content || '').main
  // 缺省用内置规则兜底（含原生 <ui_template_updates>），传入卡级合并规则时按规则剥离
  main = stripStateSyncBlocks(main, opts.stateSyncRules ?? builtinStateSyncRules())
  if (opts.regexEnabled && opts.regexScripts) {
    const placement = n.role === 'user' ? PLACEMENT_USER_INPUT : PLACEMENT_AI_OUTPUT
    main = applyRegexScripts(main, opts.regexScripts, placement, 'send')
  }
  main = replaceMacros(main, ctx)
  return main.trim()
}

function textBody(text: string | undefined, ctx: { charName: string; userName: string }): string {
  if (!text?.trim()) return ''
  return replaceMacros(text.trim(), ctx)
}

/** mes_example 按 <START> 分块为示例消息组（逐行识别 {{char}}/{{user}} 或"名字:"发言方） */
export function parseMesExample(raw: string | undefined): { role: 'user' | 'assistant'; content: string }[][] {
  if (!raw?.trim()) return []
  const blocks = raw.split(/<START>/i).map((b) => b.trim()).filter(Boolean)
  return blocks.map((block) => {
    const msgs: { role: 'user' | 'assistant'; content: string }[] = []
    let cur: 'user' | 'assistant' | null = null
    let buf = ''
    const flush = () => {
      if (cur && buf.trim()) msgs.push({ role: cur, content: buf.trim() })
      buf = ''
    }
    for (const line of block.split('\n')) {
      const generic = line.match(/^([^:{}\n]{1,32})\s*:\s*(.*)$/)
      if (generic && !/^https?/i.test(generic[2])) {
        flush()
        const speaker = generic[1].trim()
        cur = /char/i.test(speaker) ? 'assistant' : (/user|你|我/i.test(speaker) ? 'user' : 'assistant')
        buf = generic[2]
      } else if (line.trim()) {
        buf += (buf ? '\n' : '') + line
      }
    }
    flush()
    return msgs
  }).filter((msgs) => msgs.length > 0)
}

/**
 * 完整组装请求 messages。
 */
export function buildPrompt(
  character: CharacterCard,
  persona: Persona | undefined,
  chainNodes: MsgNode[],
  contextMessages: number,
  opts: PromptOptions = {},
): ApiMessage[] {
  const ctx = {
    charName: character.name,
    userName: persona?.name || '我',
  }

  // ── 系统提示主体 ──
  let sysMain = ''
  if (character.systemPromptOverride?.trim()) {
    sysMain = textBody(character.systemPromptOverride, ctx)
  } else {
    const parts: string[] = []
    if (character.description?.trim()) parts.push(replaceMacros(character.description.trim(), ctx))
    if (character.personality?.trim()) parts.push(`【性格】${replaceMacros(character.personality.trim(), ctx)}`)
    if (character.scenario?.trim()) parts.push(`【场景】${replaceMacros(character.scenario.trim(), ctx)}`)
    sysMain = parts.join('\n\n')
  }
  if (!sysMain) sysMain = `你扮演角色「${character.name}」，与用户进行沉浸式文字角色扮演。`

  const messages: ApiMessage[] = []

  // ── 世界书解析 ──
  const worldEntries = (character.worldInfo || []) as WorldInfoEntry[]
  const recentUserTexts = chainNodes
    .filter((n) => n.role === 'user')
    .map((n) => nodeBody(n, opts, ctx))
    .filter(Boolean)
  const wi = resolveWorldInfo(worldEntries, recentUserTexts)

  const sysBlocks: string[] = []
  for (const c of wi.beforeChar) sysBlocks.push(c)
  sysBlocks.push(sysMain)
  for (const c of wi.afterChar) sysBlocks.push(c)

  // ── 人设 ──
  if (persona?.description?.trim()) {
    sysBlocks.push(`【用户人设】${persona.name}\n${replaceMacros(persona.description.trim(), ctx)}`)
  }

  // ── 好感度状态行 ──
  for (const line of opts.affinityLines || []) sysBlocks.push(line)

  // ── UI 模板变量状态上下文 ──
  if (opts.uiTemplates?.length) {
    const ctx = buildUiTemplateContextPrompt(opts.uiTemplates, opts.uiTemplateStates || {})
    if (ctx) sysBlocks.push(ctx)
  }

  // ── 示例对话（<START> 分块）──
  const exampleGroups = parseMesExample(character.mesExample).map((group) =>
    group.map((m) => ({ ...m, content: replaceMacros(m.content, ctx) })),
  )
  for (const group of exampleGroups) {
    messages.push({ role: 'system', content: '【示例对话（仅供参考的文风与格式示范）】' })
    for (const m of group) messages.push(m)
  }

  // ── 记忆分配：绑定的挂 AI 消息后，未绑定的插历史最前 ──
  let memBudget = opts.memoryCharLimit ?? 1500
  const enabledMemories = (opts.memories || [])
    .filter((m) => m.enabled !== false && m.summary?.trim())
    .sort((a, b) => a.createdAt - b.createdAt)
  const memoryByAssistantId = new Map<string, MemoryEntry>()
  const unbound: MemoryEntry[] = []
  for (const m of enabledMemories) {
    const ids = (m.sourceAssistantIds || []).filter(Boolean)
    if (ids.length) {
      for (const id of ids) if (!memoryByAssistantId.has(id)) memoryByAssistantId.set(id, m)
    } else {
      unbound.push(m)
    }
  }
  function consumeMemory(m: MemoryEntry): boolean {
    const t = m.summary.trim()
    if (t.length > memBudget) return false
    memBudget -= t.length
    return true
  }
  for (const m of unbound) {
    if (!consumeMemory(m)) break
    sysBlocks.push(`【此前剧情记忆】\n${m.summary.trim()}`)
  }

  // 系统消息合并输出（sysBlocks 全部进第一条 system）
  if (sysBlocks.length) {
    messages.unshift({ role: 'system', content: sysBlocks.join('\n\n---\n\n') })
  }

  // ── 历史滑窗 + 绑定记忆插入 ──
  const historyAll = chainNodes.filter((n) => n.role !== 'system')
  const windowSet = new Set<MsgNode>()
  let kept = 0
  for (let i = historyAll.length - 1; i >= 0 && kept < Math.max(2, contextMessages); i--) {
    if (nodeBody(historyAll[i], opts, ctx)) {
      windowSet.add(historyAll[i])
      kept++
    }
  }
  const memAfterNode = new Map<MsgNode, MemoryEntry[]>()
  for (const n of historyAll) {
    const m = memoryByAssistantId.get(n.id)
    if (m && windowSet.has(n) && consumeMemory(m)) {
      const arr = memAfterNode.get(n) || []
      arr.push(m)
      memAfterNode.set(n, arr)
    }
  }
  const out: ApiMessage[] = []
  for (const n of historyAll) {
    if (!windowSet.has(n)) continue
    const body = nodeBody(n, opts, ctx)
    if (!body) continue
    out.push({ role: n.role === 'user' ? 'user' : 'assistant', content: body })
    const mems = memAfterNode.get(n)
    if (mems) {
      for (const m of mems) out.push({ role: 'system', content: `【剧情记忆】\n${replaceMacros(m.summary.trim(), ctx)}` })
    }
  }

  // ── 历史后指令（ST post_history_instructions）──
  const phi = textBody(character.postHistoryInstructions, ctx)
  if (phi) out.push({ role: 'system', content: phi })

  // ── @深度世界书条目（depth 升序，0 最靠近最新消息）──
  for (const d of wi.byDepth) {
    out.push({ role: d.role, content: replaceMacros(d.content, ctx) })
  }

  // ── 预设 user/assistant 条目追加 ──
  const tailEntries = (opts.promptEntries || []).filter(
    (p) => p.enabled && p.content.trim() && (p.role === 'user' || p.role === 'assistant'),
  )
  for (const p of tailEntries) {
    out.push({ role: p.role, content: replaceMacros(p.content.trim(), ctx) })
  }

  // ── 一次性临时规范指令：紧跟最后一条用户消息之前语义 → 放在历史末尾作为系统注记 ──
  if (opts.pendingInstruction?.trim()) {
    out.push({ role: 'system', content: `【本次回复需遵守的临时指令】\n${opts.pendingInstruction.trim()}` })
  }

  // ── UI 模板变量更新指令（告诉 AI 在正文后输出 <ui_template_updates>）──
  // 必须传会话实时状态：指令位于消息末尾，若用卡内静态初始值会诱导 AI 把已更新的变量改回去
  if (opts.uiTemplates?.length) {
    const instr = buildUiTemplateUpdateInstruction(opts.uiTemplates, opts.uiTemplateStates || {})
    if (instr) out.push({ role: 'system', content: instr })
  }

  messages.push(...out)
  return messages
}
