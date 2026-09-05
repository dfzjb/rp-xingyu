import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { db, DEFAULT_SETTINGS, getSettings, saveSettings } from '../db'
import type { PromptPreset, Settings } from '../types'
import { fetchModels, normalizeBaseUrl } from '../lib/api'
import { deepPlain } from '../lib/plain'
import { BUILTIN_CORE_PRESETS, BUILTIN_MANAGED_PRESETS, builtinCoreDefaultEnabled, builtinManagedDefaultEnabled, enforcePerspectiveMutex, rebuildWithFactoryBuiltinEntries } from '../lib/builtinPresets'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS })
  const loaded = ref(false)
  const modelsCache = ref<string[]>([])
  const fetchingModels = ref(false)
  const imageModelsCache = ref<string[]>([])
  const videoModelsCache = ref<string[]>([])

  async function load() {
    if (loaded.value) return
    settings.value = await getSettings()
    syncBuiltinPromptEntries()
    loaded.value = true
    // 已配置 API Key 时自动拉取模型列表（静默失败，不打扰用户）
    if (settings.value.apiBaseUrl && settings.value.apiKey) {
      void refreshModels().catch(() => {})
      // 图片/视频模型留空时复用对话 API，一并拉取
      void refreshImageModels().catch(() => {})
      void refreshVideoModels().catch(() => {})
    }
    if (settings.value.imageApiBaseUrl && settings.value.imageApiKey) {
      void refreshImageModels().catch(() => {})
    }
    if (settings.value.videoApiBaseUrl && settings.value.videoApiKey) {
      void refreshVideoModels().catch(() => {})
    }
  }

  // API Key / Base URL 变化时自动刷新模型列表（防抖）
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    () => [settings.value.apiBaseUrl, settings.value.apiKey],
    ([url, key]) => {
      if (!loaded.value || !url || !key) return
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => { void refreshModels().catch(() => {}) }, 800)
    },
  )

  // 图片模型配置变化时自动拉取（留空时跟随对话 API）
  let imgTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    () => [settings.value.imageApiBaseUrl, settings.value.imageApiKey, settings.value.apiBaseUrl, settings.value.apiKey],
    () => {
      if (!loaded.value) return
      const url = settings.value.imageApiBaseUrl || settings.value.apiBaseUrl
      const key = settings.value.imageApiKey || settings.value.apiKey
      if (!url || !key) return
      if (imgTimer) clearTimeout(imgTimer)
      imgTimer = setTimeout(() => { void refreshImageModels().catch(() => {}) }, 800)
    },
  )

  // 视频模型配置变化时自动拉取（留空时跟随对话 API）
  let vidTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    () => [settings.value.videoApiBaseUrl, settings.value.videoApiKey, settings.value.apiBaseUrl, settings.value.apiKey],
    () => {
      if (!loaded.value) return
      const url = settings.value.videoApiBaseUrl || settings.value.apiBaseUrl
      const key = settings.value.videoApiKey || settings.value.apiKey
      if (!url || !key) return
      if (vidTimer) clearTimeout(vidTimer)
      vidTimer = setTimeout(() => { void refreshVideoModels().catch(() => {}) }, 800)
    },
  )

  /**
   * 内置预设条目同步（旧版 syncBuiltinPreset 语义的内置优先版）：
   * 按 builtinKey 确保存在、不重复，每次启动稳定分区重排为 核心组 → 管理组 → 用户条目
   * （组内相对顺序不变，内置整体优先于自建内容）。已存在的内置条目保留用户的启停与内容修改；
   * 缺失的补回并按出厂默认启用（默认全开，仅第三人称因人称互斥默认停用）。
   */
  function syncBuiltinPromptEntries() {
    const s = settings.value
    const entries = deepPlain(s.promptEntries || []) as (PromptPreset & { builtinKey?: string; builtin?: boolean })[]
    const existingByKey = new Map<string, (PromptPreset & { builtinKey?: string; builtin?: boolean })>()
    entries.forEach((e) => {
      if (e.builtinKey && !existingByKey.has(e.builtinKey)) existingByKey.set(e.builtinKey, e)
    })

    const core: (PromptPreset & { builtinKey?: string; builtin?: boolean })[] = []
    for (const def of BUILTIN_CORE_PRESETS) {
      const key = 'core:' + def.name
      const found = existingByKey.get(key)
      if (found) {
        core.push(found)
      } else {
        core.push({
          id: key, name: def.name, content: def.content,
          enabled: builtinCoreDefaultEnabled(def.name), role: def.role as PromptPreset['role'],
          builtinKey: key, builtin: true,
        })
      }
    }

    const managed: (PromptPreset & { builtinKey?: string; builtin?: boolean })[] = []
    for (const def of BUILTIN_MANAGED_PRESETS) {
      const bk = 'managed:' + def.builtinKey
      const found = existingByKey.get(bk)
      if (found) {
        managed.push(found)
      } else {
        managed.push({
          id: bk,
          name: def.name || def.builtinKey,
          content: def.content,
          enabled: builtinManagedDefaultEnabled(def.name || def.builtinKey),
          role: def.role === 'user' || def.role === 'assistant' ? def.role : 'system',
          builtinKey: bk,
          builtin: true,
        })
      }
    }

    // 用户条目原样保留；带 builtinKey 但已不在内置清单中的旧残留条目随之清除（强制存在语义收敛为当前内置集）
    const custom = entries.filter((e) => !e.builtinKey)
    const next = [...core, ...managed, ...custom]

    const beforeIds = entries.map((e) => e.id).join('\n')
    const afterIds = next.map((e) => e.id).join('\n')
    if (beforeIds !== afterIds) {
      void saveSettings({ promptEntries: next })
    }
    settings.value = { ...settings.value, promptEntries: next }
  }

  /**
   * 重置内置预设为出厂状态（内容=原文、启停=出厂默认；用户自建条目原样保留）。
   * syncBuiltinPromptEntries 保留存量条目的启停与内容修改——出厂默认的启停/文案调整需经此操作应用。
   */
  async function resetBuiltinPromptEntries() {
    const rebuilt = rebuildWithFactoryBuiltinEntries(
      deepPlain(settings.value.promptEntries || []) as (PromptPreset & { builtinKey?: string; builtin?: boolean })[],
    )
    const list = rebuilt.list as (PromptPreset & { builtinKey?: string; builtin?: boolean })[]
    settings.value = { ...settings.value, promptEntries: list }
    await saveSettings({ promptEntries: list })
  }

  async function patch(p: Partial<Settings>) {
    // 人称视角互斥：开启第二/第三人称其一时自动关闭另一条
    if (p.promptEntries) p = { ...p, promptEntries: enforcePerspectiveMutex(p.promptEntries) }
    settings.value = { ...settings.value, ...p }
    await saveSettings(p)
  }

  const activeModel = computed(() => settings.value.modelSlots[settings.value.activeSlot]?.model || '')

  async function refreshModels(): Promise<string[]> {
    fetchingModels.value = true
    try {
      const list = await fetchModels({
        baseUrl: settings.value.apiBaseUrl,
        apiKey: settings.value.apiKey,
      })
      modelsCache.value = list
      return list
    } finally {
      fetchingModels.value = false
    }
  }

  async function refreshImageModels(): Promise<string[]> {
    const list = await fetchModels({
      baseUrl: settings.value.imageApiBaseUrl || settings.value.apiBaseUrl,
      apiKey: settings.value.imageApiKey || settings.value.apiKey,
    })
    imageModelsCache.value = list
    return list
  }

  async function refreshVideoModels(): Promise<string[]> {
    const list = await fetchModels({
      baseUrl: settings.value.videoApiBaseUrl || settings.value.apiBaseUrl,
      apiKey: settings.value.videoApiKey || settings.value.apiKey,
    })
    videoModelsCache.value = list
    return list
  }

  const normalizedBase = computed(() => normalizeBaseUrl(settings.value.apiBaseUrl))

  return {
    settings, loaded, modelsCache, fetchingModels, activeModel, normalizedBase,
    imageModelsCache, videoModelsCache,
    load, patch, resetBuiltinPromptEntries, refreshModels, refreshImageModels, refreshVideoModels,
  }
})
