import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db } from '../db'
import type { ChatSession, CharacterCard, MsgNode, Persona } from '../types'
import { uuid } from '../lib/id'
import { streamChat, chatOnce, type ApiConfig } from '../lib/api'
import { buildPrompt } from '../lib/prompt'
import { deepPlain } from '../lib/plain'
import { distillMemoriesFromChat, backfillMemories, searchVectorMemories, autoIngestVectorFloors } from '../lib/memories'
import { evaluateNpcsAutonomously } from '../lib/affinity'
import { parseCot } from '../lib/cot'
import { recordUsage } from '../lib/usage'
import { normalizeUiTemplates } from '../lib/uitemplate'
import { applyUiTemplateUpdates, buildAuxAnalysisMessages, parseUpdatesPayload } from '../lib/ui-template-state'
import { builtinStateSyncRules, normalizeStateSyncRules, extractStateSyncUpdates, stripStateSyncBlocks } from '../lib/state-sync'
import { useCharactersStore } from './characters'
import { usePersonasStore } from './personas'
import { useSettingsStore } from './settings'

/**
 * 对话核心：消息以树节点存储（Artemis 式），
 * 当前链路 = 根 → … → activeNode；重新生成 = 生成兄弟节点，历史永不丢失。
 */
export const useChatStore = defineStore('chat', () => {
  const sessions = ref<ChatSession[]>([])
  const currentSessionId = ref('')
  const loaded = ref(false)
  const generating = ref(false)
  const generatingError = ref('')
  /** 生成状态反馈：开始时间戳 / 连接已建立 / 是否还在等首字（大上下文+排队时首字可达 30~90 秒） */
  const generatingStartedAt = ref(0)
  const streamConnected = ref(false)
  const awaitingFirstDelta = ref(true)
  /** UI 模板变量更新状态条（主模型更新块 / 副模型兜底分析），一段时间后自动消失 */
  const uiTplStatus = ref<{ state: 'running' | 'ok' | 'empty' | 'skip' | 'error'; message: string; at: number } | null>(null)
  let uiTplStatusTimer: ReturnType<typeof setTimeout> | null = null
  function setUiTplStatus(state: 'running' | 'ok' | 'empty' | 'skip' | 'error', message: string) {
    uiTplStatus.value = { state, message, at: Date.now() }
    if (uiTplStatusTimer) clearTimeout(uiTplStatusTimer)
    uiTplStatusTimer = setTimeout(() => { uiTplStatus.value = null }, 12000)
  }
  /** 一次性临时规范指令（随下次发送附带，旧版语义） */
  const pendingInstruction = ref('')
  /** 每会话上次自动提炼时的楼层数 */
  const lastPatrolFloor = new Map<string, number>()
  /** 每会话上次向量原文分片入库时的楼层数（独立于副模型巡逻，频率更高） */
  const lastVectorFloor = new Map<string, number>()

  let abortFn: (() => void) | null = null

  async function load() {
    const rows = await db.chats.toArray()
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    // 崩溃残留的 streaming 标记清理
    for (const s of rows) {
      for (const n of Object.values(s.nodes)) n.streaming = false
    }
    sessions.value = rows
    loaded.value = true
  }

  const currentSession = computed<ChatSession | null>(
    () => sessions.value.find((s) => s.id === currentSessionId.value) || null,
  )

  /** 当前链路：root → … → activeNode */
  const chain = computed<MsgNode[]>(() => {
    const s = currentSession.value
    if (!s || !s.activeNodeId) return []
    const path: MsgNode[] = []
    let cur: MsgNode | undefined = s.nodes[s.activeNodeId]
    while (cur) {
      path.unshift(cur)
      cur = cur.parentId ? s.nodes[cur.parentId] : undefined
    }
    return path
  })

  /** 链路正文总字数（剥思维链标签与空白，与旧版口径对齐） */
  const totalBodyChars = computed(() => {
    let n = 0
    for (const m of chain.value) {
      const t = (m.content || '').replace(/<(think|cot)>[\s\S]*?(?:<\/\s*\1\s*>|$)/gi, '')
      n += t.replace(/\s/g, '').length
    }
    return n
  })

  function persist(session: ChatSession) {
    session.updatedAt = Date.now()
    // deepPlain 剥掉响应式 Proxy（IndexedDB 无法结构化克隆 Proxy）
    return db.chats.put(deepPlain(session))
  }

  function sessionsOfChar(charUuid: string) {
    return sessions.value.filter((s) => s.charUuid === charUuid)
  }

  /** 打开角色：有会话选最近的，没有则用开场白新建 */
  async function openCharacter(charUuid: string) {
    const chars = useCharactersStore()
    if (!chars.loaded) await chars.load()
    const char = chars.list.find((c) => c.uuid === charUuid)
    if (!char) return
    const settings = useSettingsStore()
    settings.patch({ lastActiveCharUuid: charUuid })

    const existing = sessionsOfChar(charUuid)
    if (existing.length) {
      currentSessionId.value = [...existing].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].id
      return
    }
    await createSession(char)
  }

  async function selectSession(id: string) {
    currentSessionId.value = id
  }

  /**
   * 新建会话。greetingIndex：开场白序号（0=first_mes，1..n=alternate_greetings）；
   * 不传且存在备选开场白时由调用方决定，此处默认用 first_mes。
   */
  async function createSession(char: CharacterCard, greetingIndex = 0) {
    const s: ChatSession = {
      id: uuid(),
      charUuid: char.uuid,
      name: `会话 ${sessionsOfChar(char.uuid).length + 1}`,
      rootNodeId: null,
      activeNodeId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      origin: 'new',
      nodes: {},
    }
    const greetings = [char.first_mes?.trim() || '', ...(char.alternateGreetings || []).map((g) => g.trim())].filter(Boolean)
    const opening = greetings[greetingIndex] || greetings[0] || ''
    if (opening) {
      const root: MsgNode = {
        id: uuid(),
        role: 'assistant',
        name: char.name,
        content: opening,
        avatar: char.avatar || null,
        isSelf: false,
        createdAt: Date.now(),
        parentId: null,
        childrenIds: [],
      }
      s.nodes[root.id] = root
      s.rootNodeId = root.id
      s.activeNodeId = root.id
    }
    sessions.value.unshift(s)
    currentSessionId.value = s.id
    await persist(s)
    return s
  }

  async function deleteSession(id: string) {
    await db.chats.delete(id)
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (currentSessionId.value === id) {
      currentSessionId.value = sessions.value[0]?.id || ''
    }
  }

  async function renameSession(id: string, name: string) {
    const s = sessions.value.find((x) => x.id === id)
    if (!s) return
    s.name = name
    await persist(s)
  }

  function appendNode(s: ChatSession, node: MsgNode) {
    if (node.parentId) {
      const p = s.nodes[node.parentId]
      if (p) p.childrenIds.push(node.id)
    } else {
      s.rootNodeId = node.id
    }
    s.nodes[node.id] = node
    s.activeNodeId = node.id
  }

  /** 发送用户消息 → 自动生成回复 */
  async function send(text: string, images?: { dataUrl: string; description?: string }[]) {
    const s = currentSession.value
    if (!s || generating.value) return
    const chars = useCharactersStore()
    const char = chars.list.find((c) => c.uuid === s.charUuid)
    if (!char) return
    const personas = usePersonasStore()
    const persona = personas.list.find((p) => p.uuid === personas.activeUuid)

    const userNode: MsgNode = {
      id: uuid(),
      role: 'user',
      name: persona?.name || '我',
      content: text,
      isSelf: true,
      createdAt: Date.now(),
      parentId: s.activeNodeId,
      childrenIds: [],
      imageAttachments: images?.length ? images : undefined,
    }
    appendNode(s, userNode)

    const assistantNode: MsgNode = {
      id: uuid(),
      role: 'assistant',
      name: char.name,
      content: '',
      reasoning: '',
      avatar: char.avatar || null,
      isSelf: false,
      createdAt: Date.now(),
      parentId: userNode.id,
      childrenIds: [],
      streaming: true,
    }
    appendNode(s, assistantNode)
    // 关键：从响应式代理取回节点引用——直接持有原始对象的话，
    // 流式写入不会触发 Vue 更新（内容永远不上屏）
    const liveAssistant = s.nodes[assistantNode.id]
    await persist(s)
    const instruction = pendingInstruction.value
    pendingInstruction.value = ''
    try {
      await generateInto(s, liveAssistant, char, persona, instruction)
      // 记忆自动巡逻：AI 回复完成后按楼数阈值后台提炼
      void maybeAutoPatrol(s)
    } finally {
      pendingInstruction.value = ''
    }
  }

  /** 重新生成：assistant 节点生成兄弟节点（旧版本保留在树里可切回） */
  async function regenerate(nodeId: string) {
    const s = currentSession.value
    if (!s || generating.value) return
    const old = s.nodes[nodeId]
    if (!old || old.role !== 'assistant' || !old.parentId) return
    const chars = useCharactersStore()
    const char = chars.list.find((c) => c.uuid === s.charUuid)
    if (!char) return
    const personas = usePersonasStore()
    const persona = personas.list.find((p) => p.uuid === personas.activeUuid)

    const node: MsgNode = {
      id: uuid(),
      role: 'assistant',
      name: char.name,
      content: '',
      reasoning: '',
      avatar: char.avatar || null,
      isSelf: false,
      createdAt: Date.now(),
      parentId: old.parentId,
      childrenIds: [],
      streaming: true,
    }
    appendNode(s, node) // active 已指向父节点所在位置的下潜链
    const liveNode = s.nodes[node.id] // 经代理取回，保证流式写入可触发更新
    await persist(s)
    await generateInto(s, liveNode, char, persona)
  }

  /**
   * 某节点时点的模板变量状态：沿链向上找最近的 AI 节点快照（finish 时写入 extra.uiTplState）。
   * 分支切换 / 重 roll / 删除节点时用它回滚，避免面板显示另一条分支的变量。
   * 找不到快照返回 null（旧版本会话无快照，调用方回退会话级状态）。
   */
  function baselineUiState(s: ChatSession, nodeId: string | null): Record<string, Record<string, unknown>> | null {
    let cur: MsgNode | undefined = nodeId ? s.nodes[nodeId] : undefined
    while (cur) {
      const snap = (cur.extra as Record<string, unknown> | undefined)?.uiTplState
      if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
        return snap as Record<string, Record<string, unknown>>
      }
      cur = cur.parentId ? s.nodes[cur.parentId] : undefined
    }
    return null
  }

  /** 回滚会话模板状态到当前活跃节点时点的快照（无快照不动，避免误清旧数据） */
  function restoreUiState(s: ChatSession) {
    const restored = s.activeNodeId ? baselineUiState(s, s.activeNodeId) : null
    if (restored) s.uiTemplateStates = restored
  }

  /** 进行中的副模型模板分析（会话级去重，防止连发时叠调用） */
  const auxAnalysisRunning = new Set<string>()

  /**
   * 副模型兜底分析（旧版"副模型分析"语义）：主模型回复未携带变量更新块时，
   * 后台按最近楼层让副模型补一次变量分析并回写。静默失败，不阻塞对话。
   * 副模型取 uiTemplateAuxModel → memoryAuxModel（仅用显式配置的模型，不默认占用主模型）。
   */
  async function runAuxTemplateAnalysis(
    s: ChatSession,
    node: MsgNode,
    path: MsgNode[],
    uiTpls: ReturnType<typeof normalizeUiTemplates>,
    states: Record<string, Record<string, unknown>>,
  ) {
    const settings = useSettingsStore()
    if (settings.settings.uiTemplateAuxAnalysis === false) return
    if (auxAnalysisRunning.has(s.id)) return
    const cfg: ApiConfig = {
      baseUrl: settings.settings.apiBaseUrl,
      apiKey: settings.settings.apiKey,
      model: settings.settings.uiTemplateAuxModel || settings.settings.memoryAuxModel,
      temperature: 0.3,
      maxTokens: 3000,
      reasoningEffort: 'minimal',
    }
    if (!cfg.apiKey) return
    if (!cfg.model) {
      setUiTplStatus('skip', '面板变量：未配置分析副模型，兜底未运行（UI 模板页可配置）')
      return
    }
    auxAnalysisRunning.add(s.id)
    setUiTplStatus('running', '面板变量：副模型分析中…')
    try {
      const floors = path
        .slice(-8)
        .map((n) => ({
          role: n.role === 'user' ? ('user' as const) : ('assistant' as const),
          name: n.name || '',
          content: parseCot(n.content || '').main.slice(0, 3000),
        }))
        .filter((f) => f.content.trim())
      const messages = buildAuxAnalysisMessages(uiTpls, states, floors)
      if (!messages.length) return
      const raw = await chatOnce(cfg, messages)
      const updates = parseUpdatesPayload(parseCot(raw).main)
      if (!updates.length) {
        setUiTplStatus('empty', '面板变量：副模型分析完成，无变化')
        return
      }
      const result = applyUiTemplateUpdates(states, uiTpls, updates)
      if (result.changedCount <= 0) {
        setUiTplStatus('empty', '面板变量：副模型分析完成，无变化')
        return
      }
      s.uiTemplateStates = result.states
      // 同步刷新本节点快照，保证分支回滚语义一致
      node.extra = { ...(node.extra || {}), uiTplState: result.states }
      setUiTplStatus('ok', `面板变量：副模型更新 ${result.changedCount} 项`)
      await persist(s)
    } catch (err) {
      setUiTplStatus('error', `面板变量：副模型分析失败（${(err as Error)?.message || '未知错误'}）`)
    } finally {
      auxAnalysisRunning.delete(s.id)
    }
  }

  /** 组装上下文并流式生成填充既有 assistant 占位节点 */
  async function generateInto(
    s: ChatSession,
    node: MsgNode,
    char: CharacterCard,
    persona?: Persona,
    pendingInstruction?: string,
  ) {
    const settings = useSettingsStore()
    const cfg: ApiConfig = {
      baseUrl: settings.settings.apiBaseUrl,
      apiKey: settings.settings.apiKey,
      model: settings.activeModel,
      temperature: settings.settings.temperature,
      maxTokens: settings.settings.maxTokens,
      reasoningEffort: settings.settings.reasoningEffort,
    }
    const contextMessages = settings.settings.contextMessages
    const fail = async (msg: string) => {
      node.streaming = false
      node.content = msg
      generating.value = false
      await persist(s)
    }
    if (!cfg.apiKey) return fail('（未配置 API Key：请到「设置」填写中转站密钥）')
    if (!cfg.model) return fail('（未选择模型：请到「设置」选择对话模型）')

    // 上下文链路 = root → … → 父节点（生成节点自身排除）
    const path: MsgNode[] = []
    let cur: MsgNode | undefined = node.parentId ? s.nodes[node.parentId] : undefined
    while (cur) {
      path.unshift(cur)
      cur = cur.parentId ? s.nodes[cur.parentId] : undefined
    }

    // UI 模板：启用的模板列表 + 本节点起点的变量状态
    // （优先沿父链取最近快照 —— 重 roll 时即父链时点；无快照回退会话级状态，兼容旧数据）
    const uiTpls = normalizeUiTemplates(char.uiTemplates).filter((t) => t.enabled)
    const uiStates = baselineUiState(s, node.parentId) ?? s.uiTemplateStates ?? {}
    // 变量回写规则：内置方言 + 卡级规则（正则驱动，兼容酒馆等外部更新格式）
    const syncRules = [...builtinStateSyncRules(), ...normalizeStateSyncRules(char.stateSyncRules)]

    // 记忆/好感度/提示词组装：任一步失败都不能把占位节点卡在 streaming 态
    let messages: ReturnType<typeof buildPrompt>
    try {
      let memories
      if (settings.settings.memoryMode === 'vector' && settings.settings.memoryEmbeddingModel) {
        // 向量模式：用最近对话作为 query 检索语义相关记忆
        try {
          const recentText = path
            .slice(-6)
            .map((n) => parseCot(n.content || '').main)
            .filter(Boolean)
            .join('\n')
            .slice(0, 2000)
          memories = await searchVectorMemories(
            {
              baseUrl: settings.settings.apiBaseUrl,
              apiKey: settings.settings.apiKey,
              model: settings.settings.memoryEmbeddingModel,
            },
            [s.id, 'global'],
            recentText || ' ',
            settings.settings.memoryVectorTopK || 8,
          )
        } catch {
          // 向量检索失败时回退到总结模式（全量注入总结条目；原文分片 chunk 不走全量注入）
          memories = (await db.memories
            .where('sessionId')
            .anyOf([s.id, 'global'])
            .toArray()).filter((m) => m.kind !== 'chunk')
        }
      } else {
        // 总结模式：全量注入总结条目（由 prompt.ts 按预算分配）；原文分片仅向量模式使用
        memories = (await db.memories
          .where('sessionId')
          .anyOf([s.id, 'global'])
          .toArray()).filter((m) => m.kind !== 'chunk')
      }

      // 好感度状态行（每个已追踪 NPC 一条）
      let affinityLines: string[] = []
      try {
        const { affinityStatusLines: lines } = await import('../lib/affinity')
        affinityLines = await lines(s.id)
      } catch {
        /* 无好感度数据不阻塞 */
      }

      messages = buildPrompt(char, persona, path, contextMessages, {
        regexScripts: char.regexScripts,
        regexEnabled: settings.settings.regexEnabled !== false,
        memories,
        memoryCharLimit: settings.settings.memoryCharLimit || 1500,
        promptEntries: (settings.settings.promptEntries || []).filter((p) => p.enabled),
        pendingInstruction,
        affinityLines,
        uiTemplates: uiTpls,
        uiTemplateStates: uiStates,
        stateSyncRules: syncRules,
      })
    } catch (err) {
      return fail(`（上下文组装失败：${(err as Error)?.message || String(err)}）`)
    }

    generating.value = true
    generatingError.value = ''
    generatingStartedAt.value = Date.now()
    streamConnected.value = false
    awaitingFirstDelta.value = true
    let lastPersist = Date.now()
    let finished = false
    const finish = async () => {
      if (finished) return
      finished = true
      node.streaming = false
      generating.value = false
      abortFn = null

      // 解析 AI 回复中的变量更新指令（规则化：内置方言 + 卡级规则）并更新会话状态
      let mainUpdateCount = 0
      let effective = uiStates
      if (uiTpls.length) {
        const updates = extractStateSyncUpdates(node.content, syncRules)
        mainUpdateCount = updates.length
        if (updates.length) {
          const result = applyUiTemplateUpdates(uiStates, uiTpls, updates)
          effective = result.states
          if (result.changedCount > 0) {
            s.uiTemplateStates = result.states
            setUiTplStatus('ok', `面板变量：主模型更新 ${result.changedCount} 项`)
          } else {
            setUiTplStatus('empty', '面板变量：主模型更新块无变化')
          }
        }
        // 把本节点时点的变量状态快照写到节点上（分支切换/重 roll/删除时按快照回滚）
        node.extra = { ...(node.extra || {}), uiTplState: effective }
      }
      // 从可见正文中剥离变量更新块（无模板也要剥，机器指令不该出现在正文里）
      node.content = stripStateSyncBlocks(node.content, syncRules)
      // 剥离后正文为空的兜底：不留一个空白气泡（常见于模型只输出了变量更新块、
      // 内容被安全过滤或 max_tokens 不足）
      if (!node.content.trim()) {
        node.content = '（模型本次没有输出正文：可能只输出了面板变量更新、内容被安全过滤，或 max_tokens 不足。可重 roll 或换模型试试。）'
      }
      // 主模型没输出任何更新块 → 副模型兜底分析（后台静默，对齐旧版二次分析管线）
      if (uiTpls.length && mainUpdateCount === 0) {
        void runAuxTemplateAnalysis(s, node, path, uiTpls, effective)
      }

      // 用量统计：最后一条用户消息正文为发送口径
      const lastUser = [...path].reverse().find((n) => n.role === 'user')
      void recordUsage(
        parseCot(lastUser?.content || '').main.length,
        parseCot(node.content || '').main.length,
      )
      await persist(s)
    }

    abortFn = streamChat(cfg, messages, {
      onOpen: () => { streamConnected.value = true },
      onDelta: (d) => {
        awaitingFirstDelta.value = false
        node.content += d
        // 流式中节流落库（防崩溃丢内容；whole-doc put 对几 MB 会话足够快）
        if (Date.now() - lastPersist > 3000) {
          lastPersist = Date.now()
          void persist(s)
        }
      },
      onReasoning: (d) => {
        awaitingFirstDelta.value = false
        node.reasoning = (node.reasoning || '') + d
      },
      onDone: () => { void finish() },
      onError: (err) => {
        generatingError.value = err.message
        node.content += `\n\n> ⚠️ 生成失败：${err.message}`
        void finish()
      },
    }).abort
  }

  /** 停止生成（保留已生成部分） */
  function stopGenerating() {
    abortFn?.()
  }

  /**
   * 记忆自动巡逻（两条独立自动入库通道）：
   *  A. 向量模式：配好 embedding 模型即把对话原文分片向量化入库（无需聊天副模型），轻量增量、独立节流；
   *  B. 总结模式：副模型按楼层阈值提炼记忆 + 自主评估出场 NPC 好感度（失败静默）。
   */
  async function maybeAutoPatrol(s: ChatSession) {
    const settings = useSettingsStore()
    if (settings.settings.memoryAutoPatrol === false || settings.settings.memoryEngineOn === false) return
    const hasAux = !!settings.settings.memoryAuxModel
    // 向量模式：配好 embedding 模型即可自动入库，不再硬依赖副模型
    const hasEmbed = settings.settings.memoryMode === 'vector' && !!settings.settings.memoryEmbeddingModel
    if (!hasAux && !hasEmbed) return

    const buildPath = (): MsgNode[] => {
      const path: MsgNode[] = []
      let cur: MsgNode | undefined = s.activeNodeId ? s.nodes[s.activeNodeId] : undefined
      while (cur) {
        path.unshift(cur)
        cur = cur.parentId ? s.nodes[cur.parentId] : undefined
      }
      return path
    }

    // ── A. 向量原文分片入库（增量幂等：已覆盖节点自动跳过；每新增 3 楼跑一次）──
    if (hasEmbed) {
      const totalFloors = Object.keys(s.nodes).length
      const lastV = lastVectorFloor.get(s.id) ?? -1
      if (totalFloors >= 2 && (lastV < 0 || totalFloors - lastV >= 3)) {
        lastVectorFloor.set(s.id, totalFloors)
        try {
          await autoIngestVectorFloors(
            {
              baseUrl: settings.settings.apiBaseUrl,
              apiKey: settings.settings.apiKey,
              model: settings.settings.memoryEmbeddingModel,
            },
            buildPath(),
            s.id,
          )
        } catch { /* embedding 暂不可用时静默，下轮增量再试 */ }
      }
    }

    // ── B. 副模型任务：好感度自主评判 + 总结式补录（未配副模型则到此为止）──
    if (!hasAux) return
    const floors = Math.max(5, settings.settings.memoryPatrolFloors || 20)
    const totalFloors = Object.keys(s.nodes).length
    const last = lastPatrolFloor.get(s.id) ?? -1
    if (totalFloors < floors || (last >= 0 && totalFloors - last < floors)) {
      lastPatrolFloor.set(s.id, last >= 0 ? last : 0)
      return
    }
    lastPatrolFloor.set(s.id, totalFloors)
    try {
      const path = buildPath()
      const cfg = {
        baseUrl: settings.settings.apiBaseUrl,
        apiKey: settings.settings.apiKey,
        // 副模型：记忆/评判专用（未配置时不会走到这里，不默认占用主模型）
        model: settings.settings.memoryAuxModel,
        temperature: 0.3,
        maxTokens: 1024,
        reasoningEffort: 'minimal',
      }
      // 好感度自主评判（多 NPC）
      try {
        await evaluateNpcsAutonomously(cfg, path, s.id, floors)
      } catch { /* 静默 */ }
      // 记忆补录（保留最近楼层之外）
      await backfillMemories(cfg, path, s.id, {
        keepFloors: settings.settings.memoryKeepFloors || 32,
        concurrency: Math.max(1, settings.settings.memoryConcurrency || 10),
        style: (settings.settings.memorySummaryStyle || 'balanced') as never,
      })
    } catch {
      // 静默：巡逻失败不打扰用户
    }
  }

  /** 页面卸载前冲洗流式状态 */
  async function flushOnUnload() {
    const s = currentSession.value
    if (!s) return
    let dirty = false
    for (const n of Object.values(s.nodes)) {
      if (n.streaming) { n.streaming = false; dirty = true }
    }
    if (dirty) await persist(s)
  }

  /** 续写：流式追加到最后一条 AI 消息尾部 */
  /** 沿当前链路取全部节点（root→activeNode） */
  function buildChain(s: ChatSession): MsgNode[] {
    const path: MsgNode[] = []
    let cur: MsgNode | undefined = s.activeNodeId ? s.nodes[s.activeNodeId] : undefined
    while (cur) { path.unshift(cur); cur = cur.parentId ? s.nodes[cur.parentId] : undefined }
    return path
  }

  const continuing = ref(false)
  const impersonateResult = ref('')

  async function continueLast() {
    const s = currentSession.value
    if (!s || generating.value) return
    const chain = buildChain(s)
    const lastAi = [...chain].reverse().find((n) => n.role === 'assistant')
    if (!lastAi) return
    const chars = useCharactersStore()
    const char = chars.list.find((c) => c.uuid === s.charUuid)
    if (!char) return
    const personas = usePersonasStore()
    const persona = personas.list.find((p) => p.uuid === personas.activeUuid)
    const settings = useSettingsStore()
    const cfg = {
      baseUrl: settings.settings.apiBaseUrl,
      apiKey: settings.settings.apiKey,
      model: settings.activeModel, // 与主生成同源：跟随当前激活槽位/模型
      temperature: settings.settings.temperature,
      maxTokens: settings.settings.maxTokens,
      reasoningEffort: 'minimal' as string,
    }
    if (!cfg.apiKey || !cfg.model) {
      generatingError.value = '（未配置 API Key 或未选择模型：请到「设置」填写）'
      return
    }
    // UI 模板（续写沿用该消息自身的最新快照；无快照回退会话级状态）
    const uiTpls = normalizeUiTemplates(char.uiTemplates).filter((t) => t.enabled)
    const uiStates = baselineUiState(s, lastAi.id) ?? s.uiTemplateStates ?? {}
    // 变量回写规则（与主生成同源）
    const syncRules = [...builtinStateSyncRules(), ...normalizeStateSyncRules(char.stateSyncRules)]
    // 构建提示词：历史里已带最后一条 AI 消息，不再重复发送其正文
    const msgs = buildPrompt(char, persona ?? undefined, chain, settings.settings.contextMessages, {
      uiTemplates: uiTpls,
      uiTemplateStates: uiStates,
      stateSyncRules: syncRules,
    })
    if (lastAi.content.trim()) {
      msgs.push({
        role: 'system',
        content: '【续写】从上面最后一条回复的断点无缝续写，直接输出后续正文；不要重复已有内容，不要重新开头。',
      })
    }
    generating.value = true
    generatingError.value = ''
    generatingStartedAt.value = Date.now()
    streamConnected.value = false
    awaitingFirstDelta.value = true
    let done = false
    let lastPersist = Date.now()
    const baseLen = lastAi.content.length
    abortFn = streamChat(cfg, msgs, {
      onOpen() { streamConnected.value = true },
      onDelta(d) {
        awaitingFirstDelta.value = false
        lastAi.content += d
        // 流式中节流落库（与 generateInto 同款，防崩溃丢内容）
        if (Date.now() - lastPersist > 3000) {
          lastPersist = Date.now()
          void persist(s)
        }
      },
      onDone() {
        if (done) return
        done = true
        generating.value = false
        abortFn = null
        // 解析变量更新指令（规则化）+ 快照回滚点
        let mainUpdateCount = 0
        let effective = uiStates
        if (uiTpls.length) {
          const updates = extractStateSyncUpdates(lastAi.content, syncRules)
          mainUpdateCount = updates.length
          if (updates.length) {
            const result = applyUiTemplateUpdates(uiStates, uiTpls, updates)
            effective = result.states
            if (result.changedCount > 0) s.uiTemplateStates = result.states
          }
          lastAi.extra = { ...(lastAi.extra || {}), uiTplState: effective }
        }
        lastAi.content = stripStateSyncBlocks(lastAi.content, syncRules)
        // 主模型没输出更新块 → 副模型兜底分析（后台静默）
        if (uiTpls.length && mainUpdateCount === 0) {
          void runAuxTemplateAnalysis(s, lastAi, chain, uiTpls, effective)
        }
        // 用量统计：续写无新用户输入，发送口径计 0
        void recordUsage(0, Math.max(0, lastAi.content.length - baseLen))
        void persist(s)
      },
      onError(err) {
        if (done) return
        done = true
        generating.value = false
        abortFn = null
        generatingError.value = err.message
        lastAi.content += `\n> ⚠️ ${err.message}`
        void persist(s)
      },
    }).abort
  }

  /** 代入：让 AI 代写用户下一句 */
  async function impersonate() {
    const s = currentSession.value
    if (!s || generating.value) return
    const chars = useCharactersStore()
    const char = chars.list.find((c) => c.uuid === s.charUuid)
    if (!char) return
    const personas = usePersonasStore()
    const persona = personas.list.find((p) => p.uuid === personas.activeUuid)
    const settings = useSettingsStore()
    const cfg = {
      baseUrl: settings.settings.apiBaseUrl,
      apiKey: settings.settings.apiKey,
      model: settings.activeModel, // 与主生成同源：跟随当前激活槽位/模型
      temperature: settings.settings.temperature,
      maxTokens: 300,
      reasoningEffort: 'minimal' as string,
    }
    if (!cfg.apiKey || !cfg.model) {
      generatingError.value = '（未配置 API Key 或未选择模型：请到「设置」填写）'
      return
    }
    const path: MsgNode[] = []
    let cur: MsgNode | undefined = s.activeNodeId ? s.nodes[s.activeNodeId] : undefined
    while (cur) { path.unshift(cur); cur = cur.parentId ? s.nodes[cur.parentId] : undefined }
    const messages = buildPrompt(char, persona ?? undefined, path, settings.settings.contextMessages).filter(m => m.role !== 'system')
    // 过滤 system 后补一条精简指令：带上用户人设，否则代入时不知道"我是谁"
    messages.unshift({
      role: 'system',
      content:
        `你是用户「${persona?.name || '用户'}」。根据上下文，写出用户的下一句台词。只输出台词本身，不要任何解释或旁白。不超过 100 字。` +
        (persona?.description?.trim() ? `\n【用户人设】\n${persona.description.trim()}` : ''),
    })
    generating.value = true
    let done = false
    let result = ''
    abortFn = streamChat(cfg, messages, {
      onDelta(d) { result += d },
      onDone() {
        if (done) return
        done = true
        generating.value = false
        abortFn = null
        impersonateResult.value = parseCot(result).main.trim()
      },
      onError(err) {
        if (done) return
        done = true
        generating.value = false
        abortFn = null
        generatingError.value = err.message
        console.error('impersonate error:', err.message)
      },
    }).abort
  }

  async function editNode(nodeId: string, content: string) {
    const s = currentSession.value
    if (!s) return
    const n = s.nodes[nodeId]
    if (!n) return
    n.content = content
    await persist(s)
  }

  /** 删除节点及其子树 */
  async function deleteNode(nodeId: string) {
    const s = currentSession.value
    if (!s) return
    const n = s.nodes[nodeId]
    if (!n) return
    const doomed: string[] = []
    const stack = [nodeId]
    while (stack.length) {
      const id = stack.pop()!
      const node = s.nodes[id]
      if (!node) continue
      doomed.push(id)
      stack.push(...node.childrenIds)
    }
    const wasActive = doomed.includes(s.activeNodeId || '')
    if (n.parentId) {
      const p = s.nodes[n.parentId]
      if (p) p.childrenIds = p.childrenIds.filter((id) => id !== nodeId)
    }
    for (const id of doomed) delete s.nodes[id]
    if (doomed.includes(s.rootNodeId || '')) {
      s.rootNodeId = null
      s.activeNodeId = null
    } else if (wasActive) {
      s.activeNodeId = n.parentId || s.rootNodeId
    }
    restoreUiState(s) // 活跃链变了，模板变量回滚到当前时点
    await persist(s)
  }

  /** 某节点的分支导航信息：当前 active 路径所用 child 序号 / 兄弟总数 */
  function branchInfo(nodeId: string): { index: number; total: number } | null {
    const s = currentSession.value
    if (!s) return null
    const n = s.nodes[nodeId]
    if (!n || n.childrenIds.length < 2) return null
    let cur = s.activeNodeId ? s.nodes[s.activeNodeId] : undefined
    let activeChildId: string | null = null
    while (cur) {
      if (cur.parentId === nodeId) { activeChildId = cur.id; break }
      cur = cur.parentId ? s.nodes[cur.parentId] : undefined
    }
    const idx = activeChildId ? n.childrenIds.indexOf(activeChildId) : n.childrenIds.length - 1
    return { index: idx < 0 ? n.childrenIds.length - 1 : idx, total: n.childrenIds.length }
  }

  /** 切到该节点的第 idx 个 child（沿最新子链下潜到叶） */
  async function switchBranch(nodeId: string, idx: number) {
    const s = currentSession.value
    if (!s) return
    const n = s.nodes[nodeId]
    if (!n) return
    const childId = n.childrenIds[idx]
    if (!childId) return
    let cur = s.nodes[childId]
    while (cur && cur.childrenIds.length) {
      cur = s.nodes[cur.childrenIds[cur.childrenIds.length - 1]]
    }
    if (cur) {
      s.activeNodeId = cur.id
      restoreUiState(s) // 模板变量回滚到该分支时点的快照
    }
    await persist(s)
  }

  return {
    sessions, currentSessionId, currentSession, chain, totalBodyChars,
    loaded, generating, generatingError, pendingInstruction,
    generatingStartedAt, streamConnected, awaitingFirstDelta,
    continuing, impersonateResult, uiTplStatus,
    load, openCharacter, selectSession, createSession, deleteSession, renameSession,
    send, regenerate, stopGenerating, flushOnUnload, continueLast, impersonate,
    editNode, deleteNode, branchInfo, switchBranch, sessionsOfChar,
  }
})
