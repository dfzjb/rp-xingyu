import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { DEFAULT_SETTINGS, saveSettings } from '../src/db'
import { BUILTIN_CORE_PRESETS, BUILTIN_MANAGED_PRESETS } from '../src/lib/builtinPresets'
import { useSettingsStore } from '../src/stores/settings'
import type { PromptPreset, Settings } from '../src/types'

type Entry = PromptPreset & { builtinKey?: string; builtin?: boolean }

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('syncBuiltinPromptEntries（内置优先：强制存在、默认全开、分区重排）', () => {
  it('出厂首启：内置默认全开（仅第三人称停用），布局=核心组→管理组', async () => {
    const store = useSettingsStore()
    await store.load()
    const list = store.settings.promptEntries as Entry[]
    expect(list).toHaveLength(BUILTIN_CORE_PRESETS.length + BUILTIN_MANAGED_PRESETS.length)
    expect(list[0]).toMatchObject({ builtinKey: 'core:破限', enabled: true })
    expect(list[BUILTIN_CORE_PRESETS.length]).toMatchObject({ builtinKey: 'managed:0', enabled: true })
    const disabled = list.filter((e) => e.enabled === false)
    expect(disabled.map((e) => e.name)).toEqual(['第三人称'])
  })

  it('存量数据：老布局重排为 核心组→管理组→用户；用户启停/内容修改保留；缺失内置补回默认启用', async () => {
    const core = BUILTIN_CORE_PRESETS.map((d) => ({
      id: 'core:' + d.name, name: d.name, content: d.content, enabled: true,
      role: d.role, builtinKey: 'core:' + d.name, builtin: true as const,
    }))
    const managed = BUILTIN_MANAGED_PRESETS.map((d) => ({
      id: 'managed:' + d.builtinKey, name: d.name || d.builtinKey, content: d.content, enabled: true,
      role: 'system' as const, builtinKey: 'managed:' + d.builtinKey, builtin: true as const,
    }))
    const custom: Entry = { id: 'u1', name: '我的条目', content: '自定义', enabled: true, role: 'system' }

    // 老布局：core 缺失破限（补回场景）、破限预注入内容被用户改过；custom 居中；
    // managed 尾置，NSFW增强被用户关闭，第三人称保持存量停用
    const legacy: Entry[] = [
      ...core.slice(1).map((e, i) => (i === 0 ? { ...e, content: '被用户改过的预注入' } : e)),
      custom,
      ...managed.map((e) =>
        e.builtinKey === 'managed:0' ? { ...e, enabled: false }
        : e.builtinKey === 'managed:' + BUILTIN_MANAGED_PRESETS.find((d) => d.name === '第三人称')!.builtinKey ? { ...e, enabled: false }
        : e,
      ),
    ]
    await saveSettings({ promptEntries: legacy } as Partial<Settings>)

    const store = useSettingsStore()
    await store.load()
    const list = store.settings.promptEntries as Entry[]

    // 分区重排：内置在前、用户条目收尾，组内相对顺序不变
    const idxCustom = list.findIndex((e) => e.id === 'u1')
    expect(idxCustom).toBeGreaterThan(-1)
    expect(list.slice(0, idxCustom).every((e) => e.builtinKey)).toBe(true)
    expect(list.slice(idxCustom + 1).every((e) => !e.builtinKey)).toBe(true)
    expect(list[idxCustom]).toMatchObject({ id: 'u1' })

    // 缺失的破限补回且默认启用，位于最前
    expect(list[0]).toMatchObject({ builtinKey: 'core:破限', enabled: true })
    // 用户对已存在内置条目的内容修改与启停保留
    expect(list.find((e) => e.builtinKey === 'core:破限预注入 · User 1')?.content).toBe('被用户改过的预注入')
    expect(list.find((e) => e.builtinKey === 'managed:0')?.enabled).toBe(false)
    // 存量停用的第三人称保留停用；其余管理组按存量启用保留
    expect(list.find((e) => e.name === '第三人称')?.enabled).toBe(false)
    expect(list.find((e) => e.builtinKey === 'managed:1')?.enabled).toBe(true)
  })

  it('重复内置键与已下线的内置键收敛为当前内置集', async () => {
    const factory = (key: string, id: string): Entry => ({
      id, name: key, content: 'x', enabled: true, role: 'system', builtinKey: key, builtin: true,
    })
    const legacy: Entry[] = [
      factory('core:破限', 'dup-1'),
      factory('core:破限', 'dup-2'),
      factory('managed:已下线', 'old-1'),
      { id: 'u1', name: '我的条目', content: '自定义', enabled: true, role: 'system' },
    ]
    await saveSettings({ promptEntries: legacy } as Partial<Settings>)

    const store = useSettingsStore()
    await store.load()
    const list = store.settings.promptEntries as Entry[]
    expect(list.filter((e) => e.builtinKey === 'core:破限')).toHaveLength(1)
    expect(list.find((e) => e.builtinKey === 'managed:已下线')).toBeUndefined()
    expect(list.filter((e) => !e.builtinKey)).toHaveLength(1)
  })
})
