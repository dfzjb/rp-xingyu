// 旧版 legacy_* 数据形状（迁移用；字段宽松处理，未知字段一律保留）
import type { UiTemplate } from './lib/uitemplate'

/** 旧版角色卡（服务端已把 .cards 池合并还原后的完整卡） */
export interface LegacyCharacter {
  name: string
  description?: string
  personality?: string
  scenario?: string
  first_mes?: string
  creator_notes?: string
  avatar?: string // data:image/*;base64,...
  uuid: string
  createdAt?: number
  hash?: string
  worldInfo?: unknown[]
  regexScripts?: unknown[]
  uiTemplates?: unknown[]
  recentGenerationTimes?: number[]
  [k: string]: unknown
}

/** 旧版消息（扁平结构，含大量 UI 态字段——实质字段之外的原样保留） */
export interface LegacyMessage {
  id?: string
  role: string
  name?: string
  content?: string
  reasoning?: string
  avatar?: string | null
  isSelf?: boolean | string // 旧版存的是 'True'/'False' 字符串
  isTriggered?: boolean
  imageAttachments?: { dataUrl: string; description?: string }[]
  [k: string]: unknown
}

// ============ 新站原生模型 ============

/** 新站消息：树节点（借鉴 Artemis tree.js 的结构，重新生成为兄弟节点） */
export interface MsgNode {
  id: string
  role: 'user' | 'assistant' | 'system'
  name: string
  content: string
  reasoning?: string
  avatar?: string | null
  isSelf: boolean
  createdAt: number
  parentId: string | null
  childrenIds: string[]
  imageAttachments?: { dataUrl: string; description?: string }[]
  /** 旧数据原样保留的额外字段（UI 态等，供未来功能升级用） */
  extra?: Record<string, unknown>
  /** 流式生成中的临时标记（不落库） */
  streaming?: boolean
}

/** 新站会话：角色 × 会话（消息以 id→node 映射存储，当前链路 = 根→activeNode） */
export interface ChatSession {
  id: string // 旧版键名（`<charId>` / `<charId>__branch__<bid>`）或新会话 uuid
  charUuid: string
  name: string // 展示名：主线 / 原分支名 / 会话 N
  rootNodeId: string | null
  activeNodeId: string | null
  createdAt: number
  updatedAt: number
  origin: 'main' | 'legacy-branch' | 'new'
  legacyBranchId?: string
  nodes: Record<string, MsgNode>
  /** UI 模板运行时变量状态（templateId → variables），由 AI 回复中的 <ui_template_updates> 驱动 */
  uiTemplateStates?: Record<string, Record<string, unknown>>
  /** 托管面板当前版本（自动识别 AI 自画整页 HTML 后由副模型重绘维护），随会话持久化 */
  auxPanel?: { html: string; updatedAt: number }
}

/** 新站角色卡（字段与酒馆 v2/v3 兼容，未知字段原样保留） */
export interface CharacterCard {
  uuid: string
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  creator_notes: string
  avatar: string // data URI 或空串
  createdAt: number
  importedAt: number
  /** 备选开场白（ST alternate_greetings），新建会话时可选 */
  alternateGreetings?: string[]
  /** 示例对话（ST mes_example，<START> 分块） */
  mesExample?: string
  /** 覆盖主系统提示词（ST system_prompt） */
  systemPromptOverride?: string
  /** 历史后指令（ST post_history_instructions） */
  postHistoryInstructions?: string
  creator?: string
  characterVersion?: string
  tags?: string[]
  worldInfo: unknown[]
  regexScripts: unknown[]
  uiTemplates: UiTemplate[]
  /** 变量回写规则（state-sync，正则驱动）：让非 旧版 方言的更新指令也能回写面板变量 */
  stateSyncRules?: unknown[]
  /** 收藏置顶（旧版 ☆）：收藏的卡在角色列表/侧栏置顶 */
  fav?: boolean
  /** 收藏时间（同为收藏时按此排序，最近的更靠前） */
  favAt?: number
  /** 整页 HTML 面板由副模型接管（自动识别 AI 自画整页面板，主模型只写正文）；缺省=开启 */
  uiPanelAuxTakeover?: boolean
  [k: string]: unknown
}

/** NPC 好感度（Artemis Behavior Engine 六维三轴模型 + 4 级冲突），按 会话+角色名 建档 */
export interface NpcAffinity {
  id: string // `${sessionId}:${npcName}`
  sessionId: string
  npcName: string
  /** 三组相对属性轴，每轴两方向 0-100，通常此消彼长 */
  interest: number // 关注轴正向：兴趣
  annoyance: number // 关注轴负向：厌烦
  attraction: number // 心动轴正向：吸引
  disgust: number // 心动轴负向：反感
  trust: number // 自在轴正向：信任
  cringe: number // 自在轴负向：尴尬
  /** 冲突等级手动覆盖（0-4）；null = 按维度自动推导 */
  conflictOverride?: number | null
  updatedAt: number
}

/** 每日用量记录（date = YYYY-MM-DD，主键） */
export interface UsageRow {
  date: string
  charsIn: number
  charsOut: number
  calls: number
}

/** 用户人设 */
export interface Persona {
  uuid: string
  name: string
  description: string
  person: string // 视角：first / second
  avatar: string
}

/** kv 表：旧版其余键原样存档（无损兜底） */
export interface KvRow {
  key: string // 原 legacy_* 键名
  value: unknown
  updatedAt: number
}

export interface ModelSlot {
  label: string
  model: string
}

/**
 * 提示词预设条目（对齐旧版模型）：有序列表，每条可独立启停。
 * role=system 拼入系统提示末尾；user/assistant 作为消息追加在历史之后。
 */
export interface PromptPreset {
  id: string
  name: string
  content: string
  enabled: boolean
  role: 'system' | 'user' | 'assistant'
}

/** 会话记忆条目（对齐旧版经典记忆形状） */
export interface MemoryEntry {
  id: string
  sessionId: string // 会话 id；'global' 为全局记忆
  summary: string // 记忆要点正文
  turn?: number // 关联楼层（从 1 起）
  sourceAssistantIds?: string[] // 绑定的 AI 消息节点 id（注入到其后）
  /** 向量原文分片：来源的全部节点 id（user+assistant），用于去重跳过已入库楼层 */
  sourceTurnIds?: string[]
  /** summary=AI 提炼要点；chunk=向量模式的对话原文分片（自动向量化入库） */
  kind?: 'summary' | 'chunk'
  enabled: boolean
  classicMemory: true
  source: 'manual' | 'ai'
  createdAt: number
  /** 向量模式：文本嵌入向量（由 embedding 模型生成） */
  embedding?: number[]
}

/** 跑团专用 KP 模型配置（只对在线跑团生效；未配置完整时回退主站「语言模型」） */
export interface HallModelConfig {
  enabled: boolean // 启用跑团专用模型（false = 永远跟随主站当前激活槽位）
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  reasoningEffort: string // minimal | low | medium | high | xhigh | max（minimal 出口自动兼容为 low）
}

export interface Settings {
  id: 'app'
  apiBaseUrl: string
  apiKey: string
  /** 跑团专用 KP 模型：只对在线跑团生效；enabled 或连接信息不完整时回退「更多 → 语言模型」当前激活槽位 */
  hallModel: HallModelConfig
  /** 图片生成模型连接 */
  imageApiBaseUrl: string
  imageApiKey: string
  imageModel: string
  /** 视频生成模型连接 */
  videoApiBaseUrl: string
  videoApiKey: string
  videoModel: string
  /** 三模型槽：0=主对话 1=备用A 2=备用B（对齐旧版三槽设计） */
  modelSlots: ModelSlot[]
  activeSlot: number
  temperature: number
  maxTokens: number
  reasoningEffort: string // minimal | low | medium | high | xhigh | max（minimal 出口自动兼容为 low）
  contextMessages: number // 滑窗：随请求发送的最近消息条数
  themeMode: 'dark' | 'light'
  /** 聊天区角色卡封面背景：浓度 0-100（0=关闭）与模糊半径 px */
  chatCoverOpacity: number
  chatCoverBlur: number
  plazaUrl: string // 角色卡广场索引地址（index.json，默认指向站主广场服务）
  /** 广场上传接口地址（server/plaza.js 的 /plaza/api/cards，开放上传进待审区） */
  plazaUploadUrl: string
  /** 广场管理口令（审核上架/拒绝/下架凭据 = 服务器 PLAZA_TOKEN；只存本机浏览器） */
  plazaUploadToken: string
  hallWsUrl: string // 在线跑团中继地址（ws(s)://…，留空 = 同源 /ws；服务端需自行部署 rp-site 内的 server/）
  /** 跑团「我的团」保留最近 N 场战役（0 = 全部保留）；超出自动删除最旧的 */
  hallKeepCampaigns: number
  regexEnabled: boolean // 全局启用正则脚本（显示层与发送层）
  memoryCharLimit: number // 经典记忆注入总字数上限
  memoryAutoPatrol: boolean // 记忆自动巡逻提炼开关
  memoryPatrolFloors: number // 每提炼一次所需的最低新增楼数
  memorySummaryStyle: 'brief' | 'balanced' | 'detailed' // 提炼详略档位
  /** ── 记忆引擎（旧版参数语义）── */
  memoryEngineOn: boolean
  memoryMode: 'summary' | 'vector'
  memoryAuxModel: string // 总结模式副模型（空 = 用主模型）
  memoryEmbeddingModel: string // 向量模式 embedding 模型
  memoryVectorTopK: number // 向量模式检索条数
  memoryConcurrency: number // 补录并发数
  memoryKeepFloors: number // 保留最近楼层（不参与提炼）
  /** ── UI 模板副模型分析（旧版"副模型分析"语义）──
   * 主模型回复未携带变量更新块时，后台用副模型按最近楼层补一次变量分析（对齐旧版二次分析管线）。
   * 关闭后完全依赖主模型在正文里输出 <ui_template_updates>（或卡级规则方言）。 */
  uiTemplateAuxAnalysis: boolean
  /** 主模型同步更新面板变量（默认关 = 主模型纯扮演）。开启后主模型在回复最前同步输出
   * <ui_template_updates> 更新块（双保险第一主力，不依赖额外请求）；关闭时主模型不接收
   * 任何面板指令与变量状态（UI 上下文也不注入），面板变量全由副模型每轮补全。
   * 实测思考模型会把面板字段规划写满思考链、吃满 max_tokens 致正文零输出，故默认关。 */
  uiTemplateMainModelUpdates: boolean
  /** 副模型（空 = 复用记忆副模型 memoryAuxModel；两者都未配置则不兜底，不默认占用主模型） */
  uiTemplateAuxModel: string
  /** UI 面板变量兜底补全的输出上限 token（思考模型的思考 token 也占此预算，默认 2000） */
  uiAuxMaxTokens: number
  /** 整页面板托管重绘的输出上限 token（面板 HTML 很大，默认 16000） */
  panelAuxMaxTokens: number
  /** 提示词预设条目（旧版 presets 模型）：有序、可启停、带角色 */
  promptEntries: PromptPreset[]
  lastActiveCharUuid?: string
  activePersonaUuid?: string
  migratedFrom?: string // 旧版用户目录标识
  migratedAt?: number
}

/** 迁移导入报告 */
export interface MigrateReport {
  characters: number
  chats: number
  branches: number
  messages: number
  kvKeys: number
  personas: number
  unmatchedChats: string[]
  warnings: string[]
}
