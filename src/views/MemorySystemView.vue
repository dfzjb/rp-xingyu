<script setup lang="ts">
/**
 * 记忆系统管理页：本会话 + 全局记忆的完整管理（抽屉的页面版）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { BrainCircuit, Plus, Trash2, Download, Eraser } from 'lucide-vue-next'
import { NButton, NSwitch, NSelect } from 'naive-ui'
import { useChatStore } from '../stores/chat'
import { useCharactersStore } from '../stores/characters'
import { useSettingsStore } from '../stores/settings'
import { listMemories, addMemory, updateMemory, removeMemory, backfillMemories } from '../lib/memories'
import { groupedModelOptions } from '../lib/api'
import { toast } from '../lib/toast'
import type { MemoryEntry } from '../types'

const chat = useChatStore()
const characters = useCharactersStore()
const settings = useSettingsStore()

const items = ref<MemoryEntry[]>([])
const newContent = ref('')

/** 会话选择：各会话（按角色名分组展示）+ 全局 */
const sessionOptions = computed(() => {
  const nameOf = new Map(characters.list.map((c) => [c.uuid, c.name]))
  return [
    ...chat.sessions.map((s) => ({
      value: s.id,
      label: `${nameOf.get(s.charUuid) || '未知角色'} · ${s.name}`,
    })),
    { value: 'global', label: '🌐 全局记忆' },
  ]
})
const activeScope = ref('')

watch(() => [chat.currentSessionId], () => {
  if (!activeScope.value || (activeScope.value !== 'global' && !chat.sessions.some((s) => s.id === activeScope.value))) {
    activeScope.value = chat.currentSessionId || 'global'
  }
}, { immediate: false })

async function reload() {
  if (!activeScope.value) return
  items.value = await listMemories(activeScope.value)
}

watch(activeScope, reload)
onMounted(async () => {
  if (!chat.loaded) await chat.load()
  if (!settings.loaded) await settings.load()
  activeScope.value = chat.currentSessionId || 'global'
  await reload()
})

async function addManual() {
  const c = newContent.value.trim()
  if (!c || !activeScope.value) return
  await addMemory(activeScope.value, c, { source: 'manual' })
  newContent.value = ''
  await reload()
}

async function toggleEnabled(m: MemoryEntry, v: boolean) {
  m.enabled = v
  await updateMemory(m)
}

async function removeOne(id: string) {
  await removeMemory(id)
  await reload()
}

function exportMemories() {
  const blob = new Blob([JSON.stringify(items.value)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `memories-${activeScope.value.slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

async function clearAll() {
  if (!items.value.length) return
  if (!confirm(`清空当前范围 ${items.value.length} 条记忆？不可恢复。`)) return
  for (const m of items.value) await removeMemory(m.id)
  await reload()
}

// ── 记忆引擎：补录 ──
const backfilling = ref(false)
const backfillProgress = ref<{ done: number; total: number } | null>(null)

function auxCfg() {
  const cfg = {
    baseUrl: settings.settings.apiBaseUrl,
    apiKey: settings.settings.apiKey,
    model: settings.settings.memoryAuxModel,
    temperature: 0.3,
    maxTokens: 1024,
    reasoningEffort: 'minimal',
  }
  if (!cfg.apiKey || !cfg.model) return null
  return cfg
}

async function startBackfill() {
  if (backfilling.value) return
  const s = chat.sessions.find((x) => x.id === (activeScope.value === 'global' ? chat.currentSessionId : activeScope.value))
  if (!s || !s.activeNodeId) { toast.warning('请先选择一个会话'); return }
  // 副模型未配置时不回退主模型
  if (!settings.settings.memoryAuxModel) { toast.warning('请先配置「总结模式副模型」（未配置时不再默认使用主模型）'); return }
  const cfg = auxCfg()
  if (!cfg) { toast.warning('请先在设置中配置 API Key'); return }
  // 沿链路取全部节点
  const path: import('../types').MsgNode[] = []
  let cur: import('../types').MsgNode | undefined = s.nodes[s.activeNodeId]
  while (cur) { path.unshift(cur); cur = cur.parentId ? s.nodes[cur.parentId] : undefined }
  backfilling.value = true
  try {
    const n = await backfillMemories(cfg, path, s.id, {
      keepFloors: settings.settings.memoryKeepFloors || 32,
      concurrency: Math.max(1, settings.settings.memoryConcurrency || 10),
      style: settings.settings.memorySummaryStyle || 'balanced',
      onProgress: (done: number, total: number) => { backfillProgress.value = { done, total } },
    })
    toast.success(n ? `补录完成：新增 ${n} 条记忆` : '没有需要补录的内容')
    await reload()
  } catch (err) {
    toast.error(`补录失败：${(err as Error).message}`)
  } finally {
    backfilling.value = false
    backfillProgress.value = null
  }
}

const groupedByDate = computed(() => {
  const groups = new Map<string, MemoryEntry[]>()
  for (const m of [...items.value].sort((a, b) => b.createdAt - a.createdAt)) {
    const d = new Date(m.createdAt)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const arr = groups.get(key) || []
    arr.push(m)
    groups.set(key, arr)
  }
  return [...groups.entries()]
})

// embedding 模型候选：全量模型列表（分组显示，嵌入类排前）+ 常用预设
const embeddingModelOptions = computed(() => {
  const defaults = ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002', 'bge-m3', 'embedding-v1']
  const all = [...new Set([...defaults, ...settings.modelsCache])]
  return groupedModelOptions(all, 'embedding')
})
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner" style="max-width: 760px">
        <div class="section-title" style="font-size: 1.12rem"><BrainCircuit /> 记忆系统</div>

        <!-- 记忆引擎面板 -->
        <div class="card-panel" style="margin-bottom: 14px">
          <div class="section-title" style="font-size: 0.95rem; margin-bottom: 10px">记忆引擎</div>

          <div style="display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px">
            <label class="switch-line" style="font-size: 0.84rem">
              <NSwitch size="small" :value="settings.settings.memoryEngineOn !== false" @update:value="(v: boolean) => settings.patch({ memoryEngineOn: v })" />
              {{ settings.settings.memoryEngineOn === false ? '已关闭' : '已开启' }}
            </label>
            <label class="switch-line" style="font-size: 0.84rem">
              <NSwitch size="small" :value="settings.settings.memoryAutoPatrol !== false" @update:value="(v: boolean) => settings.patch({ memoryAutoPatrol: v })" />
              自动巡逻（按楼数自动提炼）
            </label>
          </div>

          <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px">
            <div class="field" style="width: 220px; margin-bottom: 0">
              <label>记忆模式</label>
              <n-select
                size="small"
                :value="settings.settings.memoryMode || 'summary'"
                :options="[
                  { label: '总结模式（全量注入）', value: 'summary' },
                  { label: '向量模式（语义检索）', value: 'vector' },
                ]"
                @update:value="(v: string) => settings.patch({ memoryMode: v as never })"
              />
            </div>
            <div class="field" style="width: 130px; margin-bottom: 0">
              <label>提炼详略</label>
              <n-select
                size="small"
                :value="settings.settings.memorySummaryStyle || 'balanced'"
                :options="[
                  { label: '精简', value: 'brief' },
                  { label: '均衡', value: 'balanced' },
                  { label: '详细', value: 'detailed' },
                ]"
                @update:value="(v: string) => settings.patch({ memorySummaryStyle: v as never })"
              />
            </div>
            <div class="field" style="flex: 1; min-width: 220px; margin-bottom: 0">
              <label>总结模式副模型（未配置 = 不自动提炼/评判，不再回退主模型）</label>
              <NSelect
                size="small"
                filterable
                tag
                clearable
                :value="settings.settings.memoryAuxModel || null"
                placeholder="用主模型，或选择/输入模型名"
                :options="groupedModelOptions(settings.modelsCache, 'text')"
                @update:value="(v: string | null) => settings.patch({ memoryAuxModel: v || '' })"
              />
            </div>
          </div>

          <div v-if="settings.settings.memoryMode === 'vector'" style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px">
            <div class="field" style="flex: 1; min-width: 220px; margin-bottom: 0">
              <label>Embedding 模型</label>
              <NSelect
                size="small"
                filterable
                tag
                :value="settings.settings.memoryEmbeddingModel || 'text-embedding-3-small'"
                placeholder="输入 embedding 模型名"
                :options="embeddingModelOptions"
                @update:value="(v: string) => settings.patch({ memoryEmbeddingModel: v })"
              />
            </div>
            <div class="field" style="width: 130px; margin-bottom: 0">
              <label>检索条数</label>
              <input class="input" type="number" min="1" max="30" :value="settings.settings.memoryVectorTopK || 8" @change="settings.patch({ memoryVectorTopK: Number(($event.target as HTMLInputElement).value) || 8 })" />
            </div>
          </div>

          <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end">
            <div class="field" style="width: 96px; margin-bottom: 0">
              <label>补录并发</label>
              <input class="input" type="number" min="1" max="20" :value="settings.settings.memoryConcurrency || 10" @change="settings.patch({ memoryConcurrency: Number(($event.target as HTMLInputElement).value) || 10 })" />
            </div>
            <div class="field" style="width: 116px; margin-bottom: 0">
              <label>保留最近楼层</label>
              <input class="input" type="number" min="0" :value="settings.settings.memoryKeepFloors || 32" @change="settings.patch({ memoryKeepFloors: Number(($event.target as HTMLInputElement).value) || 32 })" />
            </div>
            <div class="field" style="width: 116px; margin-bottom: 0">
              <label>巡逻触发楼数</label>
              <input class="input" type="number" min="5" max="200" :value="settings.settings.memoryPatrolFloors || 20" @change="settings.patch({ memoryPatrolFloors: Number(($event.target as HTMLInputElement).value) || 20 })" />
            </div>
            <div class="field" style="width: 116px; margin-bottom: 0">
              <label>记忆注入上限</label>
              <input class="input" type="number" min="200" max="8000" step="100" :value="settings.settings.memoryCharLimit || 1500" @change="settings.patch({ memoryCharLimit: Number(($event.target as HTMLInputElement).value) || 1500 })" />
            </div>
            <button class="btn sm primary" style="flex-shrink: 0; margin-bottom: 2px" :disabled="backfilling || !!backfillProgress && backfillProgress.done < (backfillProgress.total || 1)" @click="startBackfill">
              {{ backfilling ? '补录中…' : '补录记忆' }}
            </button>
          </div>
          <div v-if="backfillProgress" style="margin-top: 10px; font-size: 0.76rem; color: var(--text-1)">
            补录进度：{{ backfillProgress.done }} / {{ backfillProgress.total }} 块
          </div>
        </div>

        <!-- 记忆条目 -->
        <div class="card-panel">
          <div class="section-title" style="font-size: 0.95rem; margin-bottom: 10px">记忆条目</div>
          <div class="field" style="margin-bottom: 10px">
            <label>记忆范围</label>
            <n-select v-model:value="activeScope" :options="sessionOptions" size="small" />
          </div>
          <div style="display: flex; gap: 8px; align-items: center">
            <input
              class="input"
              style="flex: 1"
              placeholder="手动添加一条记忆…"
              v-model="newContent"
              @keydown.enter="addManual"
            />
            <NButton size="small" type="primary" @click="addManual"><Plus :size="14" /></NButton>
            <div style="flex: 1" />
            <button class="btn sm ghost" title="导出 JSON" @click="exportMemories"><Download :size="14" /></button>
            <button class="btn sm ghost danger" title="清空当前范围" @click="clearAll"><Eraser :size="14" /></button>
          </div>
        </div>

        <template v-for="([date, list]) in groupedByDate" :key="date">
          <div class="mem-date">{{ date }}（{{ list.length }}）</div>
          <div v-for="m in list" :key="m.id" class="mem-item">
            <textarea
              class="textarea mem-content"
              rows="2"
              :value="m.summary"
              @change="updateMemory({ ...m, summary: ($event.target as HTMLTextAreaElement).value })"
            />
            <div class="mem-foot">
              <span class="chip" :class="{ on: m.source === 'ai' }">{{ m.source === 'ai' ? 'AI 提炼' : '手动' }}</span>
              <span v-if="m.sessionId === 'global'" class="chip violet">全局</span>
              <div style="flex: 1" />
              <NSwitch size="small" :value="m.enabled" @update:value="(v: boolean) => toggleEnabled(m, v)" />
              <button class="btn sm ghost danger" @click="removeOne(m.id)"><Trash2 :size="13" /></button>
            </div>
          </div>
        </template>

        <div v-if="!items.length" class="chat-empty" style="padding: 60px 0">
          <div class="empty-glyph"><BrainCircuit /></div>
          <div style="font-size: 0.9rem">当前范围暂无记忆</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mem-date { font-size: 0.7rem; color: var(--text-2); letter-spacing: 1px; margin-top: 14px; }
.mem-item {
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 9px;
  background: rgba(13, 18, 32, 0.5);
  margin-top: 8px;
}
html[data-theme='light'] .mem-item { background: #f6f8fd; }
.mem-content { min-height: 44px; font-size: 0.82rem; margin-bottom: 7px; }
.mem-foot { display: flex; align-items: center; gap: 8px; }
</style>
