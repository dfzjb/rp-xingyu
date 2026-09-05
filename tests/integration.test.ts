import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, db, exportAll, restoreAll, saveSettings } from '../src/db'
import { parseLegacyBackupFile } from '../src/lib/migrate'
import { exportLegacyBundle, sessionChainMessages } from '../src/lib/legacyExport'
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

describe('sessionChainMessages 消息树链路展开', () => {
  it('root → … → activeNode 路径展开，兄弟分支不带出；extra 字段保留', () => {
    const s = session('s1', 'c1', {
      rootNodeId: 'n1',
      activeNodeId: 'n3',
      nodes: {
        n1: node({ id: 'n1', role: 'assistant', name: '角色', content: '开场', isSelf: false, childrenIds: ['n2'] }),
        n2: node({ id: 'n2', role: 'user', content: '主线发言', isSelf: true, parentId: 'n1', childrenIds: ['n3', 'n4'] }),
        n3: node({ id: 'n3', role: 'assistant', name: '角色', content: '主线回复', isSelf: false, parentId: 'n2', extra: { uiTplState: { t: { hp: 1 } } } }),
        n4: node({ id: 'n4', role: 'assistant', name: '角色', content: '重roll回复', isSelf: false, parentId: 'n2' }),
      },
    })
    const chain = sessionChainMessages(s)
    expect(chain.map((m) => m.content)).toEqual(['开场', '主线发言', '主线回复'])
    // 老消息的 UI 态字段（extra 内容）原样摊平在消息顶层带回
    expect(chain[2].uiTplState).toEqual({ t: { hp: 1 } })

    // 切到兄弟分支 n4
    const s2 = { ...s, activeNodeId: 'n4' }
    expect(sessionChainMessages(s2).map((m) => m.content)).toEqual(['开场', '主线发言', '重roll回复'])
    // 无活动节点 → 空数组
    expect(sessionChainMessages({ ...s, activeNodeId: null })).toEqual([])
  })
})

describe('exportLegacyBundle 新站 → 旧版同构导出', () => {
  it('角色进 legacy_characters；主线与分支分开映射键', async () => {
    await db.characters.put(card('c1', '角色一'))
    await db.chats.put(session('c1', 'c1', {
      rootNodeId: 'n1',
      activeNodeId: 'n2',
      nodes: {
        n1: node({ id: 'n1', role: 'assistant', content: '开场', isSelf: false, childrenIds: ['n2'] }),
        n2: node({ id: 'n2', role: 'user', content: '你好', isSelf: true, parentId: 'n1' }),
      },
    }))
    await db.chats.put(session('c1__branch__br1', 'c1', {
      name: '分支',
      origin: 'new',
      legacyBranchId: 'br1',
      rootNodeId: 'n1',
      activeNodeId: 'n1',
      nodes: { n1: node({ id: 'n1', role: 'assistant', content: '分支开场', isSelf: false }) },
    }))

    const { d1, count } = await exportLegacyBundle()
    expect(d1['legacy_characters']).toHaveLength(1)
    expect((d1['legacy_chat_c1'] as Record<string, unknown>[]).map((m) => m.content)).toEqual(['开场', '你好'])
    expect((d1['legacy_chat_c1__branch__br1'] as Record<string, unknown>[]).map((m) => m.content)).toEqual(['分支开场'])
    expect(count).toBe(Object.keys(d1).length)
  })
})

describe('parseLegacyBackupFile 旧版备份解析', () => {
  it('d1+ls 结构合并：ls 只补缺键并尝试 JSON 反序列化', () => {
    const obj = {
      d1: { legacy_characters: [{ name: 'A' }] },
      ls: {
        legacy_characters: '不应覆盖',
        legacy_user: '{"name":"旅人"}',
        legacy_last_active_char: '3',
      },
    }
    const merged = parseLegacyBackupFile(obj)
    expect(merged.legacy_characters).toEqual([{ name: 'A' }])
    expect(merged.legacy_user).toEqual({ name: '旅人' })
    expect(merged.legacy_last_active_char).toBe(3) // '3' 是合法 JSON 数字，会被反序列化
  })

  it('平面表直接透传；两无结构抛错', () => {
    expect(parseLegacyBackupFile({ legacy_characters: [] })).toEqual({ legacy_characters: [] })
    expect(() => parseLegacyBackupFile({ foo: 1 })).toThrow('未找到旧版数据')
    expect(() => parseLegacyBackupFile('str')).toThrow('不是有效 JSON 对象')
  })
})
