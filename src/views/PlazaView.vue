<script setup lang="ts">
/** 角色卡广场：从远程索引拉取分享卡清单，一键导入 */
import { computed, onMounted, ref } from 'vue'
import { Store, RefreshCw, DownloadCloud, Search } from 'lucide-vue-next'
import { NButton, NInput, NTag, NSpin } from 'naive-ui'
import { useCharactersStore } from '../stores/characters'
import { useSettingsStore } from '../stores/settings'
import { importCardFile } from '../lib/cardio'
import { toast } from '../lib/toast'

const characters = useCharactersStore()
const settings = useSettingsStore()

const loading = ref(false)
const error = ref('')
const search = ref('')
const items = ref<PlazaItem[]>([])
const importingUrl = ref('')

interface PlazaItem {
  name?: string
  description?: string
  tags?: string[]
  url: string
}

onMounted(() => load())

async function onUrlChange(v: string) {
  await settings.patch({ plazaUrl: v.trim() })
  await load()
}

async function load() {
  error.value = ''
  loading.value = true
  try {
    const base = settings.settings.plazaUrl || 'plaza/index.json'
    const resp = await fetch(base)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    const list = Array.isArray(data) ? data : (data.cards || [])
    items.value = list.filter((x: PlazaItem) => x && x.url)
  } catch (err) {
    error.value = `加载失败：${(err as Error).message}`
  } finally {
    loading.value = false
  }
}

function absUrl(u: string): string {
  try { return new URL(u, location.href).href } catch { return u }
}

async function importCard(item: PlazaItem) {
  const url = absUrl(item.url)
  importingUrl.value = url
  try {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    const name = url.split('/').pop() || 'card'
    const file = new File([blob], name, { type: name.endsWith('.png') ? 'image/png' : 'application/json' })
    const card = await importCardFile(file)
    await characters.put(card)
    toast.success(`已导入：${item.name || card.name}`)
  } catch (err) {
    toast.error(`导入失败：${(err as Error).message}`)
  } finally {
    importingUrl.value = ''
  }
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return items.value
  return items.value.filter((x) =>
    (x.name || '').toLowerCase().includes(q) ||
    (x.description || '').toLowerCase().includes(q) ||
    (x.tags || []).some((t) => t.toLowerCase().includes(q)),
  )
})
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner" style="max-width: 900px">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap">
          <div class="section-title" style="margin-bottom: 0"><Store /> 卡片广场</div>
          <div style="flex: 1" />
          <input v-model="search" class="input" style="max-width: 200px" placeholder="搜索…" />
          <button class="btn sm" :disabled="loading" @click="load">
            <RefreshCw :size="13" />刷新
          </button>
        </div>

        <!-- 广场地址配置 -->
        <div class="card-panel" style="margin-bottom: 16px; padding: 12px 14px">
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
            <label style="font-size: 0.82rem; font-weight: 600; white-space: nowrap">广场索引地址</label>
            <input
              class="input mono"
              style="flex: 1; min-width: 240px; font-size: 0.8rem"
              :value="settings.settings.plazaUrl || ''"
              placeholder="plaza/index.json 或 https://…/index.json"
              @change="onUrlChange(($event.target as HTMLInputElement).value)"
            />
            <span style="font-size: 0.72rem; color: var(--text-2)">相对路径基于当前页面目录</span>
          </div>
        </div>

        <!-- 加载中 -->
        <div v-if="loading" class="chat-empty" style="padding: 60px 0">
          <NSpin size="medium" />
        </div>

        <!-- 加载失败 -->
        <div v-else-if="error" class="danger-box">{{ error }}</div>

        <!-- 卡片网格 -->
        <div v-else-if="filtered.length" class="plaza-grid">
          <div
            v-for="item in filtered"
            :key="item.url"
            class="card-panel plaza-card spotlight-card"
          >
            <div style="font-weight: 700; font-size: 0.9rem; margin-bottom: 6px">{{ item.name || '未命名' }}</div>
            <p style="font-size: 0.76rem; color: var(--text-2); flex: 1; line-height: 1.6; margin-bottom: 8px">
              {{ item.description || '（无描述）' }}
            </p>
            <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px">
              <NTag v-for="tg in item.tags || []" :key="tg" size="small" round type="primary" :bordered="false">{{ tg }}</NTag>
            </div>
            <NButton size="small" type="primary" :loading="importingUrl === absUrl(item.url)" @click="importCard(item)" block>
              <template #icon><DownloadCloud /></template>
              导入此卡
            </NButton>
          </div>
        </div>

        <div v-else class="chat-empty" style="padding: 50px 0">
          <div class="empty-glyph"><Search /></div>
          <div style="font-size: 0.88rem">没有找到匹配的卡片</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plaza-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}
.plaza-card {
  display: flex;
  flex-direction: column;
}
</style>
