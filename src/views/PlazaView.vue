<script setup lang="ts">
/** 角色卡广场（用户视图）：浏览 / 搜索 / 一键导入 / 开放上传（进待审区）。配置与审核在「广场后台」 */
import { computed, onMounted, ref } from 'vue'
import { Store, RefreshCw, DownloadCloud, Search, Upload } from 'lucide-vue-next'
import { NButton, NTag } from 'naive-ui'
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
const uploadInput = ref<HTMLInputElement | null>(null)
const uploadingCount = ref(0)
/** 索引所在目录（相对 item.url 以它为基准解析，才能订阅任意远程广场） */
const indexBase = ref('')

interface PlazaItem {
  name?: string
  description?: string
  tags?: string[]
  url: string
}

onMounted(() => load())

async function load() {
  error.value = ''
  loading.value = true
  try {
    const base = settings.settings.plazaUrl || 'plaza/index.json'
    indexBase.value = absUrl(base)
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
  try { return new URL(u, indexBase.value || location.href).href } catch { return u }
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

// ── 开放上传：任何人可传，进入待审区，审核通过才上架（审核在「广场后台」） ──
function pickUpload() { uploadInput.value?.click() }

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = r.result as string
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = reject
    r.readAsDataURL(f)
  })
}

/** 提交单张卡：先本地解析校验并取元数据，再 POST 到广场上传接口（进待审区） */
async function submitOne(f: File): Promise<string> {
  const card = await importCardFile(f)
  const resp = await fetch(settings.settings.plazaUploadUrl.trim(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: f.name,
      data: await fileToBase64(f),
      name: card.name,
      description: card.description,
      tags: card.tags,
    }),
  })
  const body = await resp.json().catch(() => ({}) as Record<string, unknown>)
  if (!resp.ok) throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`)
  return card.name
}

async function onUploadFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  if (!files.length) return
  if (!settings.settings.plazaUploadUrl.trim()) {
    toast.error('上传暂未开放')
    return
  }
  uploadingCount.value = files.length
  const ok: string[] = []
  const failed: string[] = []
  for (const f of files) {
    try {
      ok.push(await submitOne(f))
    } catch (err) {
      failed.push(`${f.name}：${(err as Error).message}`)
    } finally {
      uploadingCount.value--
    }
  }
  if (ok.length) toast.success(`已提交审核：${ok.join('、')}（审核通过后上架）`)
  if (failed.length) toast.error(`上传失败：\n${failed.join('\n')}`)
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
          <button class="btn sm primary" :disabled="uploadingCount > 0" @click="pickUpload">
            <Upload :size="13" />上传卡片
          </button>
          <button class="btn sm" :disabled="loading" @click="load">
            <RefreshCw :size="13" />刷新
          </button>
          <input ref="uploadInput" type="file" accept=".png,.json" multiple hidden @change="onUploadFiles" />
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
