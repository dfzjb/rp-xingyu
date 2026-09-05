<script setup lang="ts">
/**
 * 会话记忆抽屉：本会话 + 全局记忆条目管理，支持手动添加与 AI 提炼最近剧情。
 */
import { computed, ref, watch } from 'vue'
import { BrainCircuit, Plus, Sparkles, Trash2, Download, Eraser } from 'lucide-vue-next'
import { NDrawer, NDrawerContent, NSwitch, NButton } from 'naive-ui'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { listMemories, addMemory, updateMemory, removeMemory, distillMemoriesFromChat, SUMMARY_STYLES } from '../lib/memories'
import type { MemoryEntry } from '../types'
import { toast } from '../lib/toast'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const chat = useChatStore()
const settings = useSettingsStore()

const items = ref<MemoryEntry[]>([])
const newContent = ref('')
const distilling = ref(false)

const sessionId = computed(() => chat.currentSession?.id || '')

// 窄屏抽屉不超过视口宽，否则内容会被屏幕裁掉
const drawerWidth = Math.min(420, window.innerWidth)

async function reload() {
  if (!sessionId.value) return
  items.value = await listMemories(sessionId.value)
}

watch(() => [props.show, sessionId.value], ([v]) => { if (v) void reload() }, { immediate: true })

async function addManual() {
  const c = newContent.value.trim()
  if (!c || !sessionId.value) return
  await addMemory(sessionId.value, c, { source: 'manual' })
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

async function distill() {
  if (!sessionId.value || distilling.value) return
  const cfg = {
    baseUrl: settings.settings.apiBaseUrl,
    apiKey: settings.settings.apiKey,
    model: settings.activeModel,
    temperature: 0.3,
    maxTokens: 1024,
    reasoningEffort: 'minimal',
  }
  if (!cfg.apiKey || !cfg.model) {
    toast.warning('请先在设置中配置 API Key 与模型')
    return
  }
  distilling.value = true
  try {
    const style = settings.settings.memorySummaryStyle || 'balanced'
    const n = await distillMemoriesFromChat(cfg, chat.chain, sessionId.value, 30, style)
    toast.success(n ? `已提炼 ${n} 条新记忆` : '没有可提炼的新内容')
    await reload()
  } catch (err) {
    toast.error(`提炼失败：${(err as Error).message}`)
  } finally {
    distilling.value = false
  }
}

/** 按日期分组（每日剧情摘要展示） */
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

function exportMemories() {
  const blob = new Blob([JSON.stringify(items.value)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `memories-${sessionId.value.slice(0, 8)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

async function clearAll() {
  if (!items.value.length) return
  if (!confirm(`清空本会话全部 ${items.value.length} 条记忆？不可恢复。`)) return
  for (const m of items.value) await removeMemory(m.id)
  await reload()
}
</script>

<template>
  <n-drawer :show="props.show" :width="drawerWidth" placement="right" @update:show="emit('update:show', $event)">
    <n-drawer-content title="会话记忆" closable>
      <div style="display: flex; flex-direction: column; gap: 12px">
        <p style="font-size: 0.78rem; color: var(--text-2); line-height: 1.7">
          记忆要点会注入系统提示词，帮助 AI 保持长期剧情连贯（总字数上限可在设置中调整）。
          本会话记忆与全局记忆同时生效。
        </p>

        <div style="display: flex; gap: 8px">
          <input
            class="input"
            style="flex: 1"
            placeholder="手动添加一条记忆…"
            v-model="newContent"
            @keydown.enter="addManual"
          />
          <n-button size="small" type="primary" @click="addManual"><Plus :size="14" /></n-button>
        </div>

        <div style="display: flex; gap: 8px; align-items: center">
          <n-button size="small" :loading="distilling" @click="distill">
            <template #icon><Sparkles /></template>
            {{ distilling ? '提炼中…' : 'AI 提炼最近剧情' }}
          </n-button>
          <div style="flex: 1" />
          <button class="btn sm ghost" title="导出记忆 JSON" @click="exportMemories"><Download :size="14" /></button>
          <button class="btn sm ghost danger" title="清空本会话记忆" @click="clearAll"><Eraser :size="14" /></button>
        </div>
        <p style="font-size: 0.72rem; color: var(--text-2); margin: 0">
          提炼详略 / 记忆模式 / 副模型等引擎设置在侧边栏「记忆系统」页统一调整。
        </p>

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
            <button class="btn sm ghost" style="padding: 4px 7px" @click="removeOne(m.id)">
              <Trash2 :size="13" />
            </button>
          </div>
        </div>
        </template>

        <div v-if="!items.length" class="chat-empty" style="padding: 40px 0">
          <div class="empty-glyph" style="width: 60px; height: 60px"><BrainCircuit :size="26" /></div>
          <div style="font-size: 0.84rem">暂无记忆——手动添加或让 AI 提炼剧情</div>
        </div>

        <div v-if="distilling" class="shiny-text" style="text-align: center">正在阅读最近剧情…</div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.mem-date {
  font-size: 0.7rem;
  color: var(--text-2);
  letter-spacing: 1px;
  margin-top: 6px;
}
.mem-item {
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 9px;
  background: rgba(13, 18, 32, 0.5);
}
.mem-content { min-height: 44px; font-size: 0.82rem; margin-bottom: 7px; }
.mem-foot { display: flex; align-items: center; gap: 8px; }
</style>
