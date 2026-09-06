import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { db, DEFAULT_SETTINGS, getSettings, saveSettings } from '../db'
import type { PromptPreset, Settings } from '../types'
import { fetchModels, normalizeBaseUrl } from '../lib/api'
import { deepPlain } from '../lib/plain'
import { enforcePerspectiveMutex } from '../lib/promptEntries'

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
    await stripLegacyBuiltinEntries()
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
   * 清理历史内置预设条目：内置预设组已移除，带 builtinKey 的旧条目不再补发，
   * 仅保留用户自建条目（存在残留时一次性清掉并存回）。
   */
  async function stripLegacyBuiltinEntries() {
    const entries = deepPlain(settings.value.promptEntries || []) as (PromptPreset & { builtinKey?: string })[]
    const next = entries.filter((e) => !e.builtinKey)
    if (next.length !== entries.length) {
      await saveSettings({ promptEntries: next })
      settings.value = { ...settings.value, promptEntries: next }
    }
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
    load, patch, refreshModels, refreshImageModels, refreshVideoModels,
  }
})
