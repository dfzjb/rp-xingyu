import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { db, DEFAULT_SETTINGS, getSettings, saveSettings } from '../db'
import type { PromptPreset, Settings } from '../types'
import { fetchModels, normalizeBaseUrl } from '../lib/api'
import { deepPlain } from '../lib/plain'
import { BUILTIN_CORE_PRESETS, BUILTIN_MANAGED_PRESETS, builtinCoreDefaultEnabled, rebuildWithFactoryBuiltinEntries } from '../lib/builtinPresets'

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
   * 内置预设条目同步（旧版 syncBuiltinPreset 语义）：
   * 按 builtinKey 确保存在、不重复；核心组保持在最前（出厂仅破限启用，few-shot 预注入默认停用——P0-5 方案A）；
   * 管理组默认停用；用户对内置条目的启停/编辑状态保留（只补不覆盖）。
   */
  function syncBuiltinPromptEntries() {
    const s = settings.value
    const entries = deepPlain(s.promptEntries || []) as (PromptPreset & { builtinKey?: string; builtin?: boolean })[]
    const byKey = new Map<string, number>()
    entries.forEach((e, i) => {
      if (e.builtinKey && !byKey.has(e.builtinKey)) byKey.set(e.builtinKey, i)
    })
    let changed = false

    // 核心组（破限 + 预注入）：逆序 unshift，保证组内原顺序且位于最前
    const coreDefs = [...BUILTIN_CORE_PRESETS].reverse()
    let insertAt = 0
    for (const def of coreDefs) {
      const key = 'core:' + def.name
      if (!byKey.has(key)) {
        entries.splice(insertAt, 0, {
          id: key, name: def.name, content: def.content,
          enabled: builtinCoreDefaultEnabled(def.name), role: def.role as PromptPreset['role'],
          builtinKey: key, builtin: true,
        })
        byKey.set(key, insertAt)
        insertAt++
        changed = true
      }
    }

    // 管理组：默认停用，追加在末尾
    for (const def of BUILTIN_MANAGED_PRESETS) {
      const bk = 'managed:' + def.builtinKey
      if (byKey.has(bk)) continue
      entries.push({
        id: bk,
        name: def.name || def.builtinKey,
        content: def.content,
        enabled: false,
        role: def.role === 'user' || def.role === 'assistant' ? def.role : 'system',
        builtinKey: bk,
        builtin: true,
      })
      byKey.set(bk, entries.length - 1)
      changed = true
    }

    if (changed) {
      void saveSettings({ promptEntries: entries })
    }
    settings.value = { ...settings.value, promptEntries: entries }
  }

  /**
   * 重置内置预设为出厂状态（内容=原文、启停=出厂默认；用户自建条目原样保留）。
   * syncBuiltinPromptEntries 只补不覆盖——内置条目的默认启停/文案调整需经此操作应用到存量数据。
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
