import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../src/db'
import { useSettingsStore } from '../src/stores/settings'
import type { PromptPreset, Settings } from '../src/types'

type Entry = PromptPreset & { builtinKey?: string; builtin?: boolean }

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('stripLegacyBuiltinEntries（内置预设组已移除，残留 builtinKey 条目一次性清掉）', () => {
  it('出厂首启：promptEntries 保持为空（不再注入任何内置预设）', async () => {
    const store = useSettingsStore()
    await store.load()
    expect(store.settings.promptEntries).toEqual([])
  })

  it('存量数据：带 builtinKey 的旧内置条目被清除，用户自建条目原样保留', async () => {
    const legacy: Entry[] = [
      { id: 'core:破限', name: '破限', content: '旧内置', enabled: true, role: 'system', builtinKey: 'core:破限', builtin: true },
      { id: 'u1', name: '我的条目', content: '自定义', enabled: true, role: 'system' },
      { id: 'managed:0', name: 'NSFW增强', content: '旧内置', enabled: false, role: 'system', builtinKey: 'managed:0', builtin: true },
      { id: 'u2', name: '另一条', content: '自定义2', enabled: false, role: 'system' },
    ]
    await saveSettings({ promptEntries: legacy } as Partial<Settings>)

    const store = useSettingsStore()
    await store.load()
    const list = store.settings.promptEntries as Entry[]
    expect(list.map((e) => e.id)).toEqual(['u1', 'u2'])
    expect(list.every((e) => !e.builtinKey)).toBe(true)
  })

  it('清理结果落库（重载后仍是清理后的列表）', async () => {
    const legacy: Entry[] = [
      { id: 'core:破限', name: '破限', content: '旧内置', enabled: true, role: 'system', builtinKey: 'core:破限', builtin: true },
      { id: 'u1', name: '我的条目', content: '自定义', enabled: true, role: 'system' },
    ]
    await saveSettings({ promptEntries: legacy } as Partial<Settings>)
    const store = useSettingsStore()
    await store.load()
    const saved = await getSettings()
    expect((saved.promptEntries as Entry[]).map((e) => e.id)).toEqual(['u1'])
  })
})

describe('人称视角互斥（按条目名匹配）', () => {
  it('patch 写入 promptEntries 时：启用第二/第三人称其一会自动关闭另一条', async () => {
    const store = useSettingsStore()
    await store.load()
    const entries: PromptPreset[] = [
      { id: 'a', name: '第二人称', content: 'x', enabled: true, role: 'system' },
      { id: 'b', name: '第三人称', content: 'y', enabled: true, role: 'system' },
    ]
    await store.patch({ promptEntries: entries })
    const list = store.settings.promptEntries || []
    const second = list.find((e) => e.name === '第二人称')
    const third = list.find((e) => e.name === '第三人称')
    expect(second?.enabled && third?.enabled).toBe(false)
  })

  it('普通条目不受互斥影响', async () => {
    const entries: PromptPreset[] = [
      { id: 'a', name: '第二人称', content: 'x', enabled: true, role: 'system' },
      { id: 'b', name: '第三人称', content: 'y', enabled: false, role: 'system' },
      { id: 'c', name: '普通条目', content: 'z', enabled: true, role: 'system' },
    ]
    const store = useSettingsStore()
    await store.load()
    await store.patch({ promptEntries: entries })
    const list = store.settings.promptEntries || []
    expect(list.find((e) => e.name === '普通条目')?.enabled).toBe(true)
  })
})

describe('默认设置不含内置预设', () => {
  it('DEFAULT_SETTINGS.promptEntries 为空数组', () => {
    expect(DEFAULT_SETTINGS.promptEntries).toEqual([])
  })
})
