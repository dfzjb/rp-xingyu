<script setup lang="ts">
/**
 * 广场后台（独立页面，站主专用）：广场地址配置 + 待审上架/拒绝/试卡 + 已上架卡下架。
 * 侧边栏无此入口，仅从「更多 → 管理员口令」解锁后进入；口令只存本机浏览器。
 */
import { computed, onMounted, ref } from 'vue'
import { ShieldCheck } from 'lucide-vue-next'
import { NTag, NSpin } from 'naive-ui'
import { useCharactersStore } from '../stores/characters'
import { useSettingsStore } from '../stores/settings'
import { importCardFile } from '../lib/cardio'
import { toast } from '../lib/toast'

const emit = defineEmits<{ (e: 'back'): void }>()

const characters = useCharactersStore()
const settings = useSettingsStore()

interface PlazaItem {
  name?: string
  description?: string
  tags?: string[]
  url: string
}

/** 待审记录（server/plaza.js review.json 条目） */
interface PendingItem {
  id: string
  filename: string
  name: string
  description: string
  tags: string[]
  submittedAt: number
}

const hasToken = computed(() => !!settings.settings.plazaUploadToken.trim())

/** 上传接口地址 → 管理端点前缀（…/plaza/api/cards → …/plaza/api/） */
function adminApi(): string {
  return settings.settings.plazaUploadUrl.trim().replace(/\/cards$/, '/')
}

function authHeaders(): Record<string, string> {
  const token = settings.settings.plazaUploadToken.trim()
  return token ? { 'x-plaza-token': token } : {}
}

onMounted(() => {
  void loadPublished()
  if (hasToken.value) void loadReview()
})

// ── 配置 ──
async function onPlazaUrlChange(v: string) {
  await settings.patch({ plazaUrl: v.trim() })
  await loadPublished()
}
async function onUploadUrlChange(v: string) {
  await settings.patch({ plazaUploadUrl: v.trim() })
}
async function onUploadTokenChange(v: string) {
  await settings.patch({ plazaUploadToken: v.trim() })
  if (v.trim()) void loadReview()
}

// ── 已上架卡（公开清单）与下架 ──
const published = ref<PlazaItem[]>([])
const publishedLoading = ref(false)
const publishedError = ref('')
const removingUrl = ref('')

async function loadPublished() {
  publishedError.value = ''
  publishedLoading.value = true
  try {
    const base = settings.settings.plazaUrl || 'plaza/index.json'
    const resp = await fetch(base)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    const list = Array.isArray(data) ? data : (data.cards || [])
    published.value = list.filter((x: PlazaItem) => x && x.url)
  } catch (err) {
    publishedError.value = `清单加载失败：${(err as Error).message}`
  } finally {
    publishedLoading.value = false
  }
}

async function takeDown(item: PlazaItem) {
  if (!confirm(`确定下架「${item.name || item.url}」？卡文件将从服务器删除。`)) return
  const base = adminApi()
  if (!base) {
    toast.error('请先配置上传接口地址')
    return
  }
  removingUrl.value = item.url
  try {
    const resp = await fetch(`${base}remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ url: item.url }),
    })
    const body = await resp.json().catch(() => ({}) as Record<string, unknown>)
    if (!resp.ok) throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`)
    toast.success(`已下架：${item.name || item.url}`)
    await loadPublished()
  } catch (err) {
    toast.error(`下架失败：${(err as Error).message}`)
  } finally {
    removingUrl.value = ''
  }
}

// ── 审核：待审列表 + 通过 / 拒绝 / 试卡 ──
const pendingList = ref<PendingItem[]>([])
const reviewBusy = ref(false)
const actingId = ref('')

async function loadReview() {
  const base = adminApi()
  if (!base || !settings.settings.plazaUploadToken.trim()) {
    toast.error('审核需要先配置上传接口地址与管理口令')
    return
  }
  reviewBusy.value = true
  try {
    const resp = await fetch(`${base}review`, { headers: authHeaders() })
    const body = await resp.json().catch(() => ({}) as Record<string, unknown>)
    if (!resp.ok) throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`)
    pendingList.value = ((body as { pending?: PendingItem[] }).pending || [])
      .filter((x) => x && x.id)
      .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0))
  } catch (err) {
    toast.error(`待审列表获取失败：${(err as Error).message}`)
  } finally {
    reviewBusy.value = false
  }
}

async function actOnPending(item: PendingItem, action: 'approve' | 'reject') {
  const base = adminApi()
  actingId.value = `${action}:${item.id}`
  try {
    const resp = await fetch(`${base}${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id: item.id }),
    })
    const body = await resp.json().catch(() => ({}) as Record<string, unknown>)
    if (!resp.ok) throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`)
    pendingList.value = pendingList.value.filter((x) => x.id !== item.id)
    if (action === 'approve') {
      toast.success(`已上架：${item.name}`)
      void loadPublished()
    } else {
      toast.success(`已拒绝并删除：${item.name}`)
    }
  } catch (err) {
    toast.error(`${action === 'approve' ? '上架' : '拒绝'}失败：${(err as Error).message}`)
  } finally {
    actingId.value = ''
  }
}

/** 试卡：把待审卡导入自己的卡库，先玩一遍再决定上不上架 */
async function tryPending(item: PendingItem) {
  const base = adminApi()
  actingId.value = `try:${item.id}`
  try {
    const resp = await fetch(`${base}review/${item.id}`, { headers: authHeaders() })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    const file = new File([blob], item.filename || 'pending-card', { type: item.filename?.endsWith('.png') ? 'image/png' : 'application/json' })
    const card = await importCardFile(file)
    await characters.put(card)
    toast.success(`已导入本地试玩：${card.name}`)
  } catch (err) {
    toast.error(`试卡失败：${(err as Error).message}`)
  } finally {
    actingId.value = ''
  }
}
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner" style="max-width: 900px">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap">
          <div class="section-title" style="margin-bottom: 0"><ShieldCheck /> 广场后台</div>
          <div style="flex: 1" />
          <button class="btn sm" :disabled="reviewBusy" @click="loadReview">刷新待审</button>
          <button class="btn sm" :disabled="publishedLoading" @click="loadPublished">刷新清单</button>
          <button class="btn sm primary" @click="emit('back')">返回广场</button>
        </div>

        <!-- 配置 -->
        <div class="card-panel" style="margin-bottom: 16px; padding: 12px 14px">
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
            <label style="font-size: 0.82rem; font-weight: 600; white-space: nowrap">广场索引地址</label>
            <input
              class="input mono"
              style="flex: 1; min-width: 240px; font-size: 0.8rem"
              :value="settings.settings.plazaUrl || ''"
              placeholder="https://dfzjb.site/plaza/index.json"
              @change="onPlazaUrlChange(($event.target as HTMLInputElement).value)"
            />
          </div>
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px">
            <label style="font-size: 0.82rem; font-weight: 600; white-space: nowrap">上传接口地址</label>
            <input
              class="input mono"
              style="flex: 1; min-width: 240px; font-size: 0.8rem"
              :value="settings.settings.plazaUploadUrl || ''"
              placeholder="https://dfzjb.site/plaza/api/cards"
              @change="onUploadUrlChange(($event.target as HTMLInputElement).value)"
            />
          </div>
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px">
            <label style="font-size: 0.82rem; font-weight: 600; white-space: nowrap">管理口令</label>
            <input
              class="input mono"
              type="password"
              style="flex: 1; min-width: 240px; font-size: 0.8rem"
              :value="settings.settings.plazaUploadToken || ''"
              placeholder="服务器 PLAZA_TOKEN（审核 / 下架用，只存本机）"
              @change="onUploadTokenChange(($event.target as HTMLInputElement).value)"
            />
            <span style="font-size: 0.72rem; color: var(--text-2)">只存在本机浏览器</span>
          </div>
        </div>

        <!-- 待审队列 -->
        <div class="card-panel" style="margin-bottom: 16px; padding: 12px 14px">
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px">
            <div style="font-weight: 700; font-size: 0.88rem">待审卡片（{{ pendingList.length }}）</div>
            <div style="flex: 1" />
          </div>
          <div v-if="!hasToken" class="chat-empty" style="padding: 20px 0; font-size: 0.85rem; color: var(--text-2)">
            填入上方「管理口令」后即可审核（陌生人上传的卡在这里排队，审核通过才上架）
          </div>
          <div v-else-if="reviewBusy" class="chat-empty" style="padding: 20px 0"><NSpin size="small" /></div>
          <div v-else-if="!pendingList.length" class="chat-empty" style="padding: 20px 0; font-size: 0.85rem; color: var(--text-2)">
            暂无待审卡片
          </div>
          <div v-else style="display: flex; flex-direction: column; gap: 8px">
            <div
              v-for="item in pendingList"
              :key="item.id"
              style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px"
            >
              <div style="min-width: 0; flex: 1">
                <div style="font-weight: 600; font-size: 0.86rem">
                  {{ item.name }}
                  <span class="mono" style="font-size: 0.7rem; color: var(--text-2); margin-left: 6px">{{ item.filename }}</span>
                </div>
                <div style="font-size: 0.74rem; color: var(--text-2); line-height: 1.5">
                  {{ item.description || '（无描述）' }} · {{ new Date(item.submittedAt || Date.now()).toLocaleString() }}
                </div>
                <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px">
                  <NTag v-for="tg in item.tags || []" :key="tg" size="tiny" round type="primary" :bordered="false">{{ tg }}</NTag>
                </div>
              </div>
              <div style="display: flex; gap: 6px; flex-wrap: wrap">
                <button class="btn sm ghost" :disabled="actingId === `try:${item.id}`" @click="tryPending(item)">试卡</button>
                <button class="btn sm" :disabled="actingId === `reject:${item.id}`" @click="actOnPending(item, 'reject')">拒绝</button>
                <button class="btn sm primary" :disabled="actingId === `approve:${item.id}`" @click="actOnPending(item, 'approve')">通过上架</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 已上架卡管理 -->
        <div class="card-panel" style="padding: 12px 14px">
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px">
            <div style="font-weight: 700; font-size: 0.88rem">已上架（{{ published.length }}）</div>
            <div style="flex: 1" />
          </div>
          <div v-if="publishedLoading" class="chat-empty" style="padding: 20px 0"><NSpin size="small" /></div>
          <div v-else-if="publishedError" class="danger-box">{{ publishedError }}</div>
          <div v-else-if="!published.length" class="chat-empty" style="padding: 20px 0; font-size: 0.85rem; color: var(--text-2)">
            清单为空
          </div>
          <div v-else style="display: flex; flex-direction: column; gap: 8px">
            <div
              v-for="item in published"
              :key="item.url"
              style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px"
            >
              <div style="min-width: 0; flex: 1">
                <div style="font-weight: 600; font-size: 0.86rem">{{ item.name || '未命名' }}</div>
                <div class="mono" style="font-size: 0.7rem; color: var(--text-2)">{{ item.url }}</div>
              </div>
              <button
                class="btn sm danger"
                :disabled="removingUrl === item.url"
                title="从服务器删除卡文件并移出清单"
                @click="takeDown(item)"
              >下架</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
