import Dexie, { type Table } from 'dexie'
import type { NpcAffinity, CharacterCard, ChatSession, KvRow, MemoryEntry, Persona, Settings, UsageRow } from './types'
import type { HallCampaign } from './lib/hall/protocol'
import type { GameModule } from './lib/hall/module'
import { deepPlain } from './lib/plain'

export class RpDb extends Dexie {
  characters!: Table<CharacterCard, string>
  chats!: Table<ChatSession, string>
  personas!: Table<Persona, string>
  kv!: Table<KvRow, string>
  settings!: Table<Settings, string>
  memories!: Table<MemoryEntry, string>
  affinity!: Table<NpcAffinity, string>
  usage!: Table<UsageRow, string>
  campaigns!: Table<HallCampaign, string>
  modules!: Table<GameModule, string>

  constructor() {
    super('RpSiteV2')
    this.version(1).stores({
      characters: 'uuid, name, createdAt',
      chats: 'id, charUuid, updatedAt',
      personas: 'uuid, name',
      kv: 'key',
      settings: 'id',
      memories: 'id, sessionId, createdAt',
      affinity: 'id, sessionId',
      usage: 'date',
    })
    // v2：在线跑团战役（房主本地持久化）。仅新增表，不改动既有表主键，升级安全
    this.version(2).stores({
      campaigns: 'id, roomCode, updatedAt',
    })
    // v3：剧情模组库（命运转盘随机表/章节/路线/结局，供开团挂载与 AI 生成）
    this.version(3).stores({
      modules: 'id, updatedAt',
    })
  }
}

export const db = new RpDb()

export const DEFAULT_SETTINGS: Settings = {
  id: 'app',
  // 站主服务器已下线：不预置任何 API 地址，用户在「更多 → 语言模型」里填自己的 OpenAI 兼容端点
  apiBaseUrl: '',
  apiKey: '',
  imageApiBaseUrl: '',
  imageApiKey: '',
  imageModel: '',
  videoApiBaseUrl: '',
  videoApiKey: '',
  videoModel: '',
  modelSlots: [
    { label: '主模型', model: '' },
    { label: '备用 A', model: '' },
    { label: '备用 B', model: '' },
  ],
  activeSlot: 0,
  hallModel: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.8,
    maxTokens: 2048,
    reasoningEffort: 'medium',
  },
  temperature: 0.8,
  // 4096：思考类模型（Gemini 2.5 Pro 等）的思考 token 也占用输出上限，2048 会截断正文与面板更新块
  maxTokens: 4096,
  reasoningEffort: 'medium',
  contextMessages: 50,
  themeMode: 'light' as const,
  chatCoverOpacity: 30,
  chatCoverBlur: 6,
  // 只读静态广场：卡池索引随站点发布（public/plaza/）；自建广场服务才需要改这里
  plazaUrl: './plaza/index.json',
  // 静态广场无上传接口；广场上传/审核属自建服务功能（server/plaza.js）
  plazaUploadUrl: '',
  plazaUploadToken: '',
  hallWsUrl: '',
  hallKeepCampaigns: 0,
  lastSpace: 'hall',
  regexEnabled: true,
  memoryCharLimit: 1500,
  memoryAutoPatrol: true,
  memoryPatrolFloors: 20,
  memorySummaryStyle: 'balanced',
  memoryEngineOn: true,
  memoryMode: 'summary',
  memoryAuxModel: '',
  memoryEmbeddingModel: 'text-embedding-3-small',
  memoryVectorTopK: 8,
  memoryConcurrency: 10,
  memoryKeepFloors: 32,
  uiTemplateAuxAnalysis: true,
  // 主模型同步更新面板：默认关 = 主模型纯扮演（实测思考模型把面板字段规划写满思考链，
  // 吃满 max_tokens 致正文零输出）；开启为「双保险」模式（正文前同步更新块 + 副模型兜底）
  uiTemplateMainModelUpdates: false,
  uiTemplateAuxModel: '',
  // 面板兜底补全的输出上限：默认自动改用 flash 非思考模型（无思考 token 占用），
  // 实测大面板一次改 60~80 字段约 1500 token，默认 2500 留足余量
  uiAuxMaxTokens: 3000,
  // 整页面板托管重绘的输出上限（面板 HTML 很大，截断则沿用上一版）
  panelAuxMaxTokens: 16000,
  promptEntries: [],
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('app')
  if (s) return { ...DEFAULT_SETTINGS, ...s }
  const fresh: Settings = { ...DEFAULT_SETTINGS }
  await db.settings.put(fresh)
  return fresh
}

export async function saveSettings(patch: Partial<Settings>) {
  const s = await getSettings()
  const merged = deepPlain({ ...s, ...deepPlain(patch) })
  await db.settings.put(merged)
  return merged
}

export async function exportAll() {
  const [characters, chats, personas, kv, settings, memories, affinity, usage, campaigns, modules] = await Promise.all([
    db.characters.toArray(),
    db.chats.toArray(),
    db.personas.toArray(),
    db.kv.toArray(),
    db.settings.toArray(),
    db.memories.toArray(),
    db.affinity.toArray(),
    db.usage.toArray(),
    db.campaigns.toArray(),
    db.modules.toArray(),
  ])
  return {
    format: 'rp-site-backup',
    version: 3,
    exportedAt: new Date().toISOString(),
    data: { characters, chats, personas, kv, settings, memories, affinity, usage, campaigns, modules },
  }
}

export async function restoreAll(backup: {
  data?: {
    characters?: unknown[]
    chats?: unknown[]
    personas?: unknown[]
    kv?: unknown[]
    settings?: unknown[]
    memories?: unknown[]
    affinity?: unknown[]
    usage?: unknown[]
    campaigns?: unknown[]
    modules?: unknown[]
  }
}) {
  const d = backup?.data
  if (!d || !Array.isArray(d.characters) || !Array.isArray(d.chats)) {
    throw new Error('不是有效的备份文件（缺少 data.characters / data.chats）')
  }
  await db.transaction('rw', [db.characters, db.chats, db.personas, db.kv, db.settings, db.memories, db.affinity, db.usage, db.campaigns, db.modules], async () => {
    await Promise.all([
      db.characters.clear(),
      db.chats.clear(),
      db.personas.clear(),
      db.kv.clear(),
      db.settings.clear(),
      db.memories.clear(),
      db.affinity.clear(),
      db.usage.clear(),
      db.campaigns.clear(),
      db.modules.clear(),
    ])
    if (d.characters?.length) await db.characters.bulkPut(d.characters.map(deepPlain) as CharacterCard[])
    if (d.chats?.length) await db.chats.bulkPut(d.chats.map(deepPlain) as ChatSession[])
    if (d.personas?.length) await db.personas.bulkPut(d.personas.map(deepPlain) as Persona[])
    if (d.kv?.length) await db.kv.bulkPut(d.kv.map(deepPlain) as KvRow[])
    if (d.settings?.length) await db.settings.bulkPut(d.settings.map(deepPlain) as Settings[])
    if (d.memories?.length) await db.memories.bulkPut(d.memories.map(deepPlain) as MemoryEntry[])
    // 旧备份可能没有这几张表：有则恢复，无则留空
    if (d.affinity?.length) await db.affinity.bulkPut(d.affinity.map(deepPlain) as NpcAffinity[])
    if (d.usage?.length) await db.usage.bulkPut(d.usage.map(deepPlain) as UsageRow[])
    if (d.campaigns?.length) await db.campaigns.bulkPut(d.campaigns.map(deepPlain) as HallCampaign[])
    if (d.modules?.length) await db.modules.bulkPut(d.modules.map(deepPlain) as GameModule[])
  })
}

export function downloadJson(obj: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
