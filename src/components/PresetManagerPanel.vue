<script setup lang="ts">
/** 提示词预设条目管理器（旧版 presets 模型：有序、可启停、带角色；含内置预设组） */
import { computed } from 'vue'
import { SlidersHorizontal } from 'lucide-vue-next'
import { NSwitch } from 'naive-ui'
import { applyPromptEntryPatch } from '../lib/builtinPresets'
import { uuid } from '../lib/id'
import { useSettingsStore } from '../stores/settings'
import type { PromptPreset } from '../types'

const settings = useSettingsStore()

type Entry = PromptPreset & { builtinKey?: string; builtin?: boolean }

const entries = computed<Entry[]>(() => (settings.settings.promptEntries || []) as Entry[])

async function addPromptEntry() {
  const list = [...(settings.settings.promptEntries || [])]
  list.push({ id: uuid(), name: `条目 ${list.length + 1}`, content: '', enabled: true, role: 'system' })
  await settings.patch({ promptEntries: list })
}
async function removePromptEntry(id: string) {
  await settings.patch({ promptEntries: (settings.settings.promptEntries || []).filter((p) => p.id !== id) })
}
async function updatePromptEntry(i: number, patch: Partial<PromptPreset>) {
  await settings.patch({ promptEntries: applyPromptEntryPatch(settings.settings.promptEntries || [], i, patch) })
}
async function movePromptEntry(i: number, dir: -1 | 1) {
  const list = [...(settings.settings.promptEntries || [])]
  const j = i + dir
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
  await settings.patch({ promptEntries: list })
}
function entryLabel(p: Entry): string {
  return p.name || '未命名'
}
async function onResetBuiltin() {
  if (!confirm('重置内置预设为出厂状态？\n\n将恢复内置条目原文与默认启停（few-shot 预注入默认停用），自建条目不受影响。')) return
  await settings.resetBuiltinPromptEntries()
}
</script>

<template>
  <div>
    <p style="font-size: 0.78rem; color: var(--text-2); line-height: 1.7; margin-bottom: 12px">
      每条是一个可独立启停的提示词条目。system 条目拼进系统提示末尾；user / assistant 条目作为消息追加在对话历史之后。核心组中仅破限默认启用，few-shot 预注入默认停用（防思考模型每轮元分析，可单独开启）；管理组按需开启。
    </p>

    <div v-for="(p, i) in entries" :key="p.id" class="preset-entry" :style="p.enabled ? '' : 'opacity:0.55'">
      <div class="entry-head">
        <span v-if="p.builtin" class="chip violet">内置</span>
        <input
          class="input"
          style="flex: 1; padding: 6px 10px; font-size: 0.82rem"
          :value="entryLabel(p)"
          placeholder="条目名称"
          @input="updatePromptEntry(i, { name: ($event.target as HTMLInputElement).value })"
        />
        <select class="input" style="width: 108px; padding: 6px 8px; font-size: 0.78rem" :value="p.role" @change="updatePromptEntry(i, { role: ($event.target as HTMLSelectElement).value as PromptPreset['role'] })">
          <option value="system">system</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
        </select>
        <n-switch size="small" :value="p.enabled" @update:value="(v: boolean) => updatePromptEntry(i, { enabled: v })" />
        <button class="btn sm ghost" title="上移" @click="movePromptEntry(i, -1)">▲</button>
        <button class="btn sm ghost" title="下移" @click="movePromptEntry(i, 1)">▼</button>
        <button class="btn sm ghost danger" title="删除" @click="removePromptEntry(p.id)">✕</button>
      </div>
      <textarea
        class="textarea"
        rows="3"
        style="font-size: 0.8rem; min-height: 52px"
        :value="p.content"
        placeholder="提示词内容…"
        @change="updatePromptEntry(i, { content: ($event.target as HTMLTextAreaElement).value })"
      />
    </div>

    <div style="margin-top: 10px; display: flex; gap: 8px">
      <button class="btn sm primary" @click="addPromptEntry">＋ 新增条目</button>
      <button class="btn sm ghost" title="内置条目恢复出厂原文与默认启停，自建条目保留" @click="onResetBuiltin">重置内置预设</button>
    </div>
    <p v-if="!(settings.settings.promptEntries || []).length" style="font-size: 0.78rem; color: var(--text-2); margin-top: 6px">
      暂无条目。内置组会在重启后自动补回。
    </p>
  </div>
</template>

<style scoped>
.preset-entry {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(13, 18, 32, 0.45);
  margin-bottom: 10px;
}
html[data-theme='light'] .preset-entry { background: #f6f8fd; }
.entry-head { display: flex; align-items: center; gap: 9px; }
</style>
