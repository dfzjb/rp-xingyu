/**
 * 提示词组装（严格对齐旧版 generateResponse 结构）：
 * 第一条 system = 破限 → system_top/global_note 世界书 → [System Presets]其他系统预设
 *                → [Style Priority] → [User Info] → 好感度/UI状态 → 未绑定记忆
 * user/assistant = 预设预注入条目（位于角色前奏之前）
 * user 角色前奏   = before_char 世界书([条目名]) → [Character] 角色定义+示例原文 → after_char 世界书
 * 历史 = 连续同角色楼层合并后的消息链，绑定记忆挂对应 AI 消息之后；@深度世界书在最终数组上倒数 splice（缺省 user）
 * 注入尾 = user_top 前置末条用户消息；assistant_top/phi/临时指令/UI 更新指令以 system 收尾
 * 最后一步 = 发送层正则：对整条 messages 逐条执行（system 跳过），对齐旧版 processRegex(isPrompt)
 *
 * 来源追踪：assemble() 在组装的同时给每条消息携带 origins（来自哪个预设/世界书条目/楼层/注入），
 * 经 buildPromptTrace() 暴露给开发者面板（P2-16）；buildPrompt() 保持原签名只返回 messages。
 */
import type { CharacterCard, MemoryEntry, MsgNode, Persona, PromptPreset } from '../types'
import { parseCot } from './cot'
import { applyRegexScripts, PLACEMENT_AI_OUTPUT, PLACEMENT_USER_INPUT } from './regex'
import { replaceMacros } from './macros'
import { resolveWorldInfo, DEFAULT_WI_RECURSION_STEPS, type WIPlacedEntry, type WorldInfoEntry } from './worldinfo'
import type { UiTemplate } from './uitemplate'
import { buildUiTemplateContextPrompt, buildUiTemplateUpdateInstruction } from './ui-template-state'
import { builtinStateSyncRules, stripStateSyncBlocks, type StateSyncRule } from './state-sync'

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 一条最终消息的来源标注（与 buildPromptTrace().trace 一一对应；合并后的消息带多个来源） */
export interface PromptTraceEntry {
  origins: string[]
}

/** 组装期内部消息：携带来源标记，返回前剥离 */
type AssembledMessage = ApiMessage & { _origins?: string[] }

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
  /** 主模型同步更新面板（默认 true = 双保险）。false：主模型不注入 UI 更新指令与变量状态上下文（纯扮演），面板由副模型负责 */
  uiMainModelUpdates?: boolean
  /** 变量回写规则（含内置方言）；历史消息按此剥离更新块，缺省按内置规则剥离 */
  stateSyncRules?: StateSyncRule[]
  /** 世界书递归激活步数（默认 0 对齐旧版不链式扩散；>0 时启用 ST 式递归） */
  worldInfoRecursion?: number
}

/** 节点正文（正则发送层已后置到组装末尾，此处只做：剥思维链 → 剥变量更新块 → 宏替换） */
function nodeBody(n: MsgNode, opts: PromptOptions, ctx: { charName: string; userName: string }): string {
  let main = parseCot(n.content || '').main
  // 缺省用内置规则兜底（含原生 <ui_template_updates>），传入卡级合并规则时按规则剥离
  main = stripStateSyncBlocks(main, opts.stateSyncRules ?? builtinStateSyncRules())
  main = replaceMacros(main, ctx)
  return main.trim()
}

/** 旧版 joinContent：一组世界书条目统一加 [条目名] 包裹后用空行连接 */
function joinWI(list: WIPlacedEntry[]): string {
  return list.map((e) => `[${(e.comment || '').trim() || 'Entry'}]\n${e.content.trim()}`).join('\n\n')
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

/** 世界书条目组 → 来源标签里的条目名列表 */
function wiNames(list: WIPlacedEntry[]): string {
  return list.map((e) => e.comment?.trim() || 'Entry').join('、')
}

/**
 * 完整组装请求 messages，并携带每条消息的来源标注。
 */
function assemble(
  character: CharacterCard,
  persona: Persona | undefined,
  chainNodes: MsgNode[],
  contextMessages: number,
  opts: PromptOptions = {},
): { messages: ApiMessage[]; trace: PromptTraceEntry[] } {
  const ctx = {
    charName: character.name,
    userName: persona?.name || '我',
  }

  // ── 角色定义本体（对齐旧版 charPrompt：[Character] 下 Name/Personality/Scenario；
  //    description 旧版虽未拼入，但 V2 卡主体在 description，缺失会丢设定，故保留为 Description 行）──
  let sysMain = ''
  if (character.systemPromptOverride?.trim()) {
    sysMain = textBody(character.systemPromptOverride, ctx)
  } else {
    const lines: string[] = [`Name: ${character.name}`]
    if (character.description?.trim()) lines.push(`Description: ${replaceMacros(character.description.trim(), ctx)}`)
    if (character.personality?.trim()) lines.push(`Personality: ${replaceMacros(character.personality.trim(), ctx)}`)
    if (character.scenario?.trim()) lines.push(`Scenario: ${replaceMacros(character.scenario.trim(), ctx)}`)
    sysMain = lines.join('\n')
  }
  if (!sysMain.trim()) sysMain = `Name: ${character.name}`

  // ── 世界书解析（对齐旧版：扫描源为正则发送层之前的历史原文；连续同角色楼层先合并）──
  const worldEntries = (character.worldInfo || []) as WorldInfoEntry[]
  const floorNodes = chainNodes.filter((x) => x.role !== 'system')
  // 对齐旧版 getPostprocessedChatMessages → mergeConsecutiveRoleMessages：相邻同角色正文以空行合并
  const scanTexts: string[] = []
  floorNodes.forEach((n, i) => {
    const body = nodeBody(n, opts, ctx)
    if (!body) return
    if (scanTexts.length && floorNodes[i - 1]?.role === n.role) {
      scanTexts[scanTexts.length - 1] += `\n\n${body}`
    } else {
      scanTexts.push(body)
    }
  })
  const wi = resolveWorldInfo(worldEntries, scanTexts, opts.worldInfoRecursion ?? DEFAULT_WI_RECURSION_STEPS)

  // ── system 预设：名为「破限」者置顶（旧版 systemPresetPrompt），其余系统预设包 [System Presets] ──
  const enabledEntries = (opts.promptEntries || []).filter((p) => p.enabled && p.content.trim())
  const sysPresetEntries = enabledEntries.filter((p) => p.role === 'system')
  const jailbreakEntries = sysPresetEntries.filter((p) => p.name === '破限')
  const otherSysPresetEntries = sysPresetEntries.filter((p) => p.name !== '破限')

  // ── 第一条 system（顺序严格对齐旧版 systemPromptParts）──
  const sysBlocks: string[] = []
  const sysMeta: string[][] = []
  for (const p of jailbreakEntries) {
    sysBlocks.push(replaceMacros(p.content.trim(), ctx))
    sysMeta.push([`预设·破限（${p.name}）`])
  }
  // system_top / global_note 世界书进 system（破限之后、其他预设之前）
  if (wi.systemTop.length) {
    sysBlocks.push(joinWI(wi.systemTop))
    sysMeta.push([`世界书·系统顶部（${wiNames(wi.systemTop)}）`])
  }
  if (wi.globalNote.length) {
    sysBlocks.push(joinWI(wi.globalNote))
    sysMeta.push([`世界书·全局注释（${wiNames(wi.globalNote)}）`])
  }
  if (otherSysPresetEntries.length) {
    sysBlocks.push(`[System Presets]\n${otherSysPresetEntries.map((p) => replaceMacros(p.content.trim(), ctx)).join('\n\n---\n\n')}`)
    sysMeta.push([`系统预设（${otherSysPresetEntries.map((p) => p.name).join('、')}）`])
  }
  // 旧版固定注入的 [Style Priority]（原文，不做增改）
  sysBlocks.push(
    '[Style Priority]\n开场白和历史消息只用于理解剧情事实、人物关系和场景状态，不作为文风模板；不要继承或模仿开场白、前文回复的句式、语气密度、段落节奏或排版习惯。最终回复的文风必须优先遵守上方系统预设中的规定文风。',
  )
  sysMeta.push(['固定注入·[Style Priority]'])
  // [User Info]（对齐旧版格式与位置：Style Priority 之后）
  if (persona?.description?.trim() || persona?.name) {
    sysBlocks.push(`[User Info]\nName: ${persona?.name || ctx.userName}\nDescription: ${replaceMacros(persona?.description?.trim() || '', ctx)}`)
    sysMeta.push(['用户人设·[User Info]'])
  }

  // ── 好感度状态行 ──
  for (const line of opts.affinityLines || []) {
    sysBlocks.push(line)
    sysMeta.push(['好感度状态行'])
  }

  // ── UI 模板变量状态上下文（仅主模型同步更新模式注入；关闭时主模型纯扮演，不接收面板状态）──
  if (opts.uiTemplates?.length && opts.uiMainModelUpdates !== false) {
    const uiCtxPrompt = buildUiTemplateContextPrompt(opts.uiTemplates, opts.uiTemplateStates || {})
    if (uiCtxPrompt) {
      sysBlocks.push(uiCtxPrompt)
      sysMeta.push(['UI 变量状态上下文'])
    }
  }

  // ── 记忆分配：绑定的挂 AI 消息后，未绑定的进 system 末尾 ──
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
    sysMeta.push([`记忆·未绑定（${m.summary.trim().slice(0, 12)}…）`])
  }

  // head = system 指令层 + user/assistant 预设（预注入）+ user 角色前奏
  const head: AssembledMessage[] = []
  if (sysBlocks.length) {
    head.push({ role: 'system', content: sysBlocks.join('\n\n'), _origins: sysMeta.flat() })
  }

  // ── user/assistant 预设条目：对齐旧版 messagePresets，位于角色前奏之前 ──
  for (const p of enabledEntries.filter((p) => p.role === 'user' || p.role === 'assistant')) {
    head.push({
      role: p.role,
      content: replaceMacros(p.content.trim(), ctx),
      _origins: [`预设预注入（${p.name}）`],
    })
  }

  // ── 角色前奏（一条 user 消息，对齐旧版 characterPreludePrompt）：
  // before_char 世界书 → [Character] 角色定义（含示例对话原文）→ after_char 世界书 ──
  const preludeParts: string[] = []
  const preludeMeta: string[] = []
  if (wi.beforeChar.length) {
    preludeParts.push(joinWI(wi.beforeChar))
    preludeMeta.push(`世界书·角色前（${wiNames(wi.beforeChar)}）`)
  }
  const charParts: string[] = ['[Character]', sysMain]
  // 示例对话按旧版方式作为角色定义的纯文本一部分（不占用消息轮次、不插 system 标题）
  const exampleText = textBody(character.mesExample, ctx)
  if (exampleText) charParts.push(exampleText)
  preludeParts.push(charParts.join('\n\n'))
  preludeMeta.push(exampleText ? '角色前奏·[Character]（含示例对话）' : '角色前奏·[Character]')
  if (wi.afterChar.length) {
    preludeParts.push(joinWI(wi.afterChar))
    preludeMeta.push(`世界书·角色后（${wiNames(wi.afterChar)}）`)
  }
  if (preludeParts.some((p) => p.trim())) {
    head.push({ role: 'user', content: preludeParts.join('\n\n'), _origins: preludeMeta })
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
  const out: AssembledMessage[] = []
  const winNodes: MsgNode[] = []
  for (const n of historyAll) if (windowSet.has(n)) winNodes.push(n)
  for (const n of winNodes) {
    const body = nodeBody(n, opts, ctx)
    if (!body) continue
    const floorLabel = n.parentId
      ? `历史楼层·${n.role === 'user' ? '用户' : 'AI'}（${n.name || ''}）`
      : `开场白（${n.name || character.name}）`
    out.push({
      role: n.role === 'user' ? 'user' : 'assistant',
      content: body,
      _origins: [floorLabel],
    })
    // 绑定记忆（新站特性）：挂在对应 AI 楼之后；system 会打断后续同角色合并，与旧版语义不冲突
    const mems = memAfterNode.get(n)
    if (mems) {
      for (const m of mems) {
        out.push({
          role: 'system',
          content: `【剧情记忆】\n${replaceMacros(m.summary.trim(), ctx)}`,
          _origins: [`记忆·绑定（${m.summary.trim().slice(0, 12)}…）`],
        })
      }
    }
  }

  // head（system 指令层 + 预设 + 角色前奏）与历史楼层合并；@深度在最终数组上倒数插入，
  // 对齐旧版 processMessageInjections + safeTargetLimit：插入点不得进入 head 区
  const merged: AssembledMessage[] = [...head, ...out]
  const safeFloor = head.length

  // ── @深度世界书条目（逐字对齐旧版 processMessageInjections 的 At Depth 段，回归 R1）──
  // 组内按 order 升序逐条处理；每条都在【含先前注入结果】的当前数组上从末尾重新倒数：
  // countdown=depth，每遇一条 user/assistant 消息减 1，减至 -1 时插入该消息【之前】——
  // 即旧版口径"注入点之后还有 depth+1 条对话消息"（与 SillyTavern 的 depth 语义整体 +1，
  // 属旧版既定行为，卡片按旧版调校须保持一致）。先前注入的 user 角色条目同样参与后续
  // 条目的倒数（旧版如此，勿"修复"）。永不越入 head 区（safeFloor 等价旧版 safeTargetLimit
  // = 1 + 预设数 + 角色前奏）。注入角色缺省 user（旧版硬编码 user），显式 system/assistant
  // 为新站扩展；每条独立成消息，相邻同角色合并交给末尾统一后处理（旧版 5707 同款）。
  const depthEntries = [...wi.byDepth].sort((a, b) => (a.order || 0) - (b.order || 0))
  for (const d of depthEntries) {
    const content = `[${d.comment?.trim() || 'Entry'}]\n${d.content}`
    const reversed = [...merged].reverse()
    let countdown = Math.max(0, d.depth)
    let targetIndex = -1
    for (let i = 0; i < reversed.length; i++) {
      if (reversed[i].role === 'user' || reversed[i].role === 'assistant') countdown--
      if (countdown < 0) {
        targetIndex = merged.length - 1 - i
        break
      }
    }
    if (targetIndex < safeFloor) targetIndex = safeFloor
    merged.splice(targetIndex, 0, {
      role: d.role,
      content: replaceMacros(content, ctx),
      _origins: [`世界书·@深度注入（${d.comment?.trim() || 'Entry'}，depth=${d.depth}，${d.role}）`],
    })
  }

  // ── user_top 世界书：前置进当前数组最后一条 user 消息（旧版顺序：在 @深度注入之后执行，
  // 因此尾部 @深度 user 注入条目会先被当作"最后一条 user 消息"——旧版 5669-5680 同款行为）──
  if (wi.userTop.length) {
    let lastUser = -1
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i].role === 'user') { lastUser = i; break }
    }
    if (lastUser >= 0) {
      merged[lastUser].content = `${joinWI(wi.userTop)}\n\n${merged[lastUser].content}`
      const target = merged[lastUser]
      target._origins = [`世界书·user_top 前置（${wiNames(wi.userTop)}）`, ...(target._origins ?? [])]
    }
  }

  // ── 历史后指令（ST post_history_instructions）──
  const phi = textBody(character.postHistoryInstructions, ctx)
  if (phi) merged.push({ role: 'system', content: phi, _origins: ['卡 phi·post_history_instructions'] })

  // ── assistant_top 世界书：末尾 system「[Instructions for next message]」（对齐旧版）──
  if (wi.assistantTop.length) {
    merged.push({
      role: 'system',
      content: `[Instructions for next message]\n${joinWI(wi.assistantTop)}`,
      _origins: [`世界书·assistant_top（${wiNames(wi.assistantTop)}）`],
    })
  }

  // ── 一次性临时规范指令：放在历史末尾作为系统注记 ──
  if (opts.pendingInstruction?.trim()) {
    merged.push({
      role: 'system',
      content: `【本次回复需遵守的临时指令】\n${opts.pendingInstruction.trim()}`,
      _origins: ['临时规范指令（随下轮发送）'],
    })
  }

  // ── UI 模板：主模型在正文「之前」同步输出变量更新块（面板更新的第一主力）──
  // 仅双保险模式（settings.uiTemplateMainModelUpdates 开启）注入；默认关闭 = 主模型纯扮演，
  // 面板全由副模型 runAuxTemplateAnalysis 每轮补全（实测思考模型会把面板字段规划写满思考链致正文零输出）。
  if (opts.uiTemplates?.length && opts.uiMainModelUpdates !== false) {
    const uiInstr = buildUiTemplateUpdateInstruction(opts.uiTemplates, opts.uiTemplateStates || {}, 'before')
    if (uiInstr) {
      merged.push({ role: 'system', content: uiInstr, _origins: ['UI 更新指令（主模型同步模式）'] })
    }
  }

  // ── 统一后处理（对齐旧版 5707-5714：先 postprocessContextMessages 合并连续同角色，
  //    再对每条消息跑发送层正则；system 不参与合并、也不经过正则）──
  const post: AssembledMessage[] = []
  for (const msg of merged) {
    const prev = post[post.length - 1]
    if (prev && prev.role === msg.role && (msg.role === 'user' || msg.role === 'assistant')) {
      prev.content = [prev.content, msg.content].filter(Boolean).join('\n\n')
      prev._origins = [...(prev._origins ?? []), ...(msg._origins ?? [])]
    } else {
      post.push({ ...msg })
    }
  }
  if (opts.regexEnabled && opts.regexScripts) {
    for (let i = 0; i < post.length; i++) {
      const msg = post[i]
      if (msg.role === 'system') continue
      const placement = msg.role === 'user' ? PLACEMENT_USER_INPUT : PLACEMENT_AI_OUTPUT
      // depth = 最终数组全长度倒数（system 楼层也占下标，与旧版口径一致）
      msg.content = applyRegexScripts(msg.content, opts.regexScripts, placement, 'send', { depth: post.length - 1 - i })
    }
  }

  return {
    messages: post.map((m) => ({ role: m.role, content: m.content })),
    trace: post.map((m) => ({ origins: m._origins ?? [] })),
  }
}

/**
 * 完整组装请求 messages（签名与行为与历史版本一致）。
 */
export function buildPrompt(
  character: CharacterCard,
  persona: Persona | undefined,
  chainNodes: MsgNode[],
  contextMessages: number,
  opts: PromptOptions = {},
): ApiMessage[] {
  return assemble(character, persona, chainNodes, contextMessages, opts).messages
}

/**
 * 组装请求 messages 并携带每条消息的来源标注（P2-16 开发者面板用）。
 * trace 与返回的 messages 一一对应；连续同角色合并后 origins 顺序拼接。
 */
export function buildPromptTrace(
  character: CharacterCard,
  persona: Persona | undefined,
  chainNodes: MsgNode[],
  contextMessages: number,
  opts: PromptOptions = {},
): { messages: ApiMessage[]; trace: PromptTraceEntry[] } {
  return assemble(character, persona, chainNodes, contextMessages, opts)
}
