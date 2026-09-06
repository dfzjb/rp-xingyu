import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, db, exportAll, restoreAll, saveSettings } from '../src/db'
import type { CharacterCard, ChatSession, MsgNode } from '../src/types'

function node(partial: Partial<MsgNode> & { id: string }): MsgNode {
  return {
    role: 'user',
    name: '',
    content: '',
    isSelf: true,
    createdAt: 1,
    parentId: null,
    childrenIds: [],
    ...partial,
  }
}

function card(uuid: string, name: string): CharacterCard {
  return {
    uuid,
    name,
    description: 'desc',
    personality: '',
    scenario: '',
    first_mes: '',
    creator_notes: '',
    avatar: '',
    createdAt: 1,
    importedAt: 1,
    alternateGreetings: [],
    mesExample: '',
    systemPromptOverride: '',
    postHistoryInstructions: '',
    creator: '',
    characterVersion: '',
    tags: [],
    worldInfo: [],
    regexScripts: [],
    uiTemplates: [],
  }
}

function session(id: string, charUuid: string, extra: Partial<ChatSession>): ChatSession {
  return {
    id,
    charUuid,
    name: '主线',
    rootNodeId: null,
    activeNodeId: null,
    createdAt: 1,
    updatedAt: 1,
    origin: 'main',
    nodes: {},
    ...extra,
  }
}

describe('settings 存取', () => {
  it('saveSettings 与默认值合并；响应式 Proxy 补丁可安全入库', async () => {
    const merged = await saveSettings(reactive({ themeMode: 'dark', temperature: 1.1 }))
    expect(merged.themeMode).toBe('dark')
    expect(merged.temperature).toBe(1.1)
    // 未覆盖字段保留默认值
    expect(merged.contextMessages).toBe(DEFAULT_SETTINGS.contextMessages)
    const fresh = await db.settings.get('app')
    expect(fresh?.themeMode).toBe('dark')
  })
})

describe('全库备份往返 exportAll → restoreAll', () => {
  it('八张表数据完整往返', async () => {
    await db.characters.put(card('c1', '角色一'))
    await db.memories.put({ id: 'm1', sessionId: 's1', content: '记得', createdAt: 1, updatedAt: 1 } as never)
    await db.affinity.put({ id: 's1:小明', sessionId: 's1', npcName: '小明', interest: 10, trust: 5, attraction: 5, annoyance: 0, cringe: 0, disgust: 0, conflictOverride: null, updatedAt: 1 })
    await db.usage.put({ date: '2026-08-29', charsIn: 10, charsOut: 20, calls: 1 } as never)
    await db.modules.put({ id: 'mod1', name: '雾镇迷局', synopsis: '', chapters: [], routes: [], endings: [], tables: [], createdAt: 1, updatedAt: 1 })

    const backup = await exportAll()
    expect(backup.format).toBe('rp-site-backup')

    // 清库后恢复
    await Promise.all([db.characters.clear(), db.chats.clear(), db.memories.clear(), db.affinity.clear(), db.usage.clear(), db.modules.clear()])
    expect(await db.characters.count()).toBe(0)
    await restoreAll(backup)

    expect((await db.characters.get('c1'))?.name).toBe('角色一')
    expect(await db.memories.count()).toBe(1)
    expect(await db.affinity.count()).toBe(1)
    expect(await db.usage.count()).toBe(1)
    expect((await db.modules.get('mod1'))?.name).toBe('雾镇迷局')
  })

  it('非法备份（缺 characters/chats）抛错', async () => {
    await expect(restoreAll({ data: {} })).rejects.toThrow('不是有效的备份文件')
    await expect(restoreAll(undefined as never)).rejects.toThrow()
  })
})


