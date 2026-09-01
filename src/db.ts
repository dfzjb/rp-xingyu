import Dexie, { type Table } from 'dexie'
import type { NpcAffinity, CharacterCard, ChatSession, KvRow, MemoryEntry, Persona, Settings, UsageRow } from './types'
import type { HallCampaign } from './lib/hall/protocol'
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
  }
}

export const db = new RpDb()

export const DEFAULT_SETTINGS: Settings = {
  id: 'app',
  apiBaseUrl: 'https://dfzjb.site/v1',
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
  maxTokens: 2048,
  reasoningEffort: 'medium',
  contextMessages: 50,
  themeMode: 'light' as const,
  chatCoverOpacity: 30,
  chatCoverBlur: 6,
  plazaUrl: 'https://dfzjb.site/plaza/index.json',
  plazaUploadUrl: 'https://dfzjb.site/plaza/api/cards',
  plazaUploadToken: '',
  hallWsUrl: '',
  hallKeepCampaigns: 0,
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
  uiTemplateAuxModel: '',
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
  const [characters, chats, personas, kv, settings, memories, affinity, usage, campaigns] = await Promise.all([
    db.characters.toArray(),
    db.chats.toArray(),
    db.personas.toArray(),
    db.kv.toArray(),
    db.settings.toArray(),
    db.memories.toArray(),
    db.affinity.toArray(),
    db.usage.toArray(),
    db.campaigns.toArray(),
  ])
  return {
    format: 'rp-site-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    data: { characters, chats, personas, kv, settings, memories, affinity, usage, campaigns },
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
  }
}) {
  const d = backup?.data
  if (!d || !Array.isArray(d.characters) || !Array.isArray(d.chats)) {
    throw new Error('不是有效的备份文件（缺少 data.characters / data.chats）')
  }
  await db.transaction('rw', [db.characters, db.chats, db.personas, db.kv, db.settings, db.memories, db.affinity, db.usage, db.campaigns], async () => {
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
