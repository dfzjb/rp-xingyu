<script setup lang="ts">
/**
 * 正则脚本编辑器（v-model:list）。
 * 内部模型：{name, pattern, replace, flags, affectsUser, affectsAI, applyOnDisplay, applyOnSend, disabled}
 * 兼容导入酒馆扩展格式与旧版格式（normalizeRegexScript）。
 */
import { computed } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import { NSwitch, NCheckbox } from 'naive-ui'

interface RScript {
  name?: string
  pattern?: string
  find?: string
  regex?: string
  replace?: string
  replacement?: string
  flags?: string
  affectsUser?: boolean
  affectsAI?: boolean
  applyOnDisplay?: boolean
  applyOnSend?: boolean
  disabled?: boolean
  [k: string]: unknown
}

const props = defineProps<{ list: unknown[] }>()
const emit = defineEmits<{ (e: 'update:list', v: unknown[]): void }>()

const items = computed<RScript[]>({
  get() {
    return (props.list || []) as RScript[]
  },
  set(v) {
    emit('update:list', v)
  },
})

function add() {
  items.value = [
    ...items.value,
    {
      name: `脚本 ${items.value.length + 1}`,
      pattern: '',
      replace: '',
      flags: 'g',
      affectsUser: true,
      affectsAI: true,
      applyOnDisplay: true,
      applyOnSend: true,
      disabled: false,
    },
  ]
}
function remove(i: number) {
  const next = [...items.value]
  next.splice(i, 1)
  items.value = next
}
function update(i: number, patch: Partial<RScript>) {
  const next = [...items.value]
  next[i] = { ...next[i], ...patch }
  items.value = next
}
function isEnabled(s: RScript): boolean {
  return s.disabled !== true
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 10px">
    <div v-for="(s, i) in items" :key="i" class="rx-entry" :style="isEnabled(s) ? '' : 'opacity: 0.55'">
      <div class="rx-head">
        <input
          class="input"
          style="flex: 1; padding: 6px 10px; font-size: 0.82rem"
          :value="s.name || ''"
          placeholder="脚本名称"
          @input="update(i, { name: ($event.target as HTMLInputElement).value })"
        />
        <n-switch size="small" :value="isEnabled(s)" @update:value="(v: boolean) => update(i, { disabled: !v })" />
        <button class="btn sm ghost danger" title="删除" @click="remove(i)"><Trash2 :size="13" /></button>
      </div>
      <div class="rx-grid">
        <label style="font-size: 0.74rem; color: var(--text-2)">查找（正则）
          <input
            class="input mono"
            style="margin-top: 3px; padding: 5px 9px; font-size: 0.78rem"
            :value="(s.pattern ?? s.regex ?? s.find ?? '')"
            placeholder="pattern"
            @input="update(i, { pattern: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label style="font-size: 0.74rem; color: var(--text-2)">替换为
          <input
            class="input mono"
            style="margin-top: 3px; padding: 5px 9px; font-size: 0.78rem"
            :value="(s.replace ?? s.replacement ?? '')"
            placeholder="replacement（支持 $1）"
            @input="update(i, { replace: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label style="font-size: 0.74rem; color: var(--text-2); max-width: 80px">标志
          <input
            class="input mono"
            style="margin-top: 3px; padding: 5px 9px; font-size: 0.78rem"
            :value="s.flags || 'g'"
            @input="update(i, { flags: ($event.target as HTMLInputElement).value })"
          />
        </label>
      </div>
      <div class="rx-flags">
        <span>作用：</span>
        <n-checkbox size="small" :checked="s.affectsUser !== false" @update:checked="(v: boolean) => update(i, { affectsUser: v })">
          用户输入
        </n-checkbox>
        <n-checkbox size="small" :checked="s.affectsAI !== false" @update:checked="(v: boolean) => update(i, { affectsAI: v })">
          AI 输出
        </n-checkbox>
        <span style="color: var(--text-2)">应用：</span>
        <n-checkbox size="small" :checked="s.applyOnDisplay !== false" @update:checked="(v: boolean) => update(i, { applyOnDisplay: v })">
          显示层
        </n-checkbox>
        <n-checkbox size="small" :checked="s.applyOnSend !== false" @update:checked="(v: boolean) => update(i, { applyOnSend: v })">
          发送层
        </n-checkbox>
      </div>
    </div>

    <button class="btn sm" style="align-self: flex-start" @click="add"><Plus :size="14" />新增脚本</button>
    <p v-if="!items.length" style="font-size: 0.78rem; color: var(--text-2)">
      正则脚本可对用户输入 / AI 输出做查找替换（美化排版、过滤词、自动格式化），随角色卡保存，兼容酒馆扩展脚本导入。
    </p>
  </div>
</template>

<style scoped>
.rx-entry {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(13, 18, 32, 0.45);
}
html[data-theme='light'] .rx-entry { background: #f6f8fd; }
.rx-head { display: flex; align-items: center; gap: 9px; }
.rx-grid { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; }
.rx-flags { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; font-size: 0.76rem; color: var(--text-1); }
</style>
