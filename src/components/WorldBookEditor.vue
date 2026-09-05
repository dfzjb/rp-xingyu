<script setup lang="ts">
/**
 * 世界书条目可视化编辑器（v-model:list）。
 * 条目形状与旧版/SillyTavern 兼容：{comment, keys, constant, enabled, order, content}
 */
import { computed } from 'vue'
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-vue-next'
import { NSwitch, NCheckbox } from 'naive-ui'
import type { WILogic } from '../lib/worldinfo'

interface WEntry {
  comment?: string
  content?: string
  enabled?: boolean
  keys?: string[]
  constant?: boolean
  order?: number
  [k: string]: unknown
}

const props = defineProps<{ list: unknown[] }>()
const emit = defineEmits<{ (e: 'update:list', v: unknown[]): void }>()

const items = computed<WEntry[]>({
  get() {
    return (props.list || []) as WEntry[]
  },
  set(v) {
    emit('update:list', v)
  },
})

function add() {
  items.value = [
    ...items.value,
    { comment: '', content: '', keys: [], constant: false, enabled: true, order: 100 },
  ]
}
function remove(i: number) {
  const next = [...items.value]
  next.splice(i, 1)
  items.value = next
}
function move(i: number, dir: -1 | 1) {
  const j = i + dir
  if (j < 0 || j >= items.value.length) return
  const next = [...items.value]
  ;[next[i], next[j]] = [next[j], next[i]]
  items.value = next
}
function update(i: number, patch: Partial<WEntry>) {
  const next = [...items.value]
  next[i] = { ...next[i], ...patch }
  items.value = next
}
function keysText(e: WEntry): string {
  return Array.isArray(e.keys) ? e.keys.join(', ') : ''
}
function setKeys(i: number, text: string) {
  // 只按逗号/中文逗号/换行切分：按空白切会拆坏含空格的正则关键词（如 /a b/）（回归 R5）
  update(i, { keys: text.split(/[,，\n]/).map((k) => k.trim()).filter(Boolean) })
}
function setScanDepth(i: number, raw: string) {
  const t = raw.trim()
  if (t === '' || Number.isNaN(Number(t))) {
    // 清空 = 恢复"未设置"（引擎走默认 2），而不是 0（0 = 不扫描，仅常驻可激活）（回归 R4）
    const next = [...items.value]
    const copy = { ...next[i] } as Record<string, unknown>
    delete copy.scanDepth
    next[i] = copy as WEntry
    items.value = next
    return
  }
  update(i, { scanDepth: Math.max(0, Number(t)) })
}
function secText(e: WEntry): string {
  const sec = Array.isArray(e.secondaryKeys) ? e.secondaryKeys : Array.isArray(e.filter) ? e.filter : []
  return sec.join(', ')
}
function setSec(i: number, text: string) {
  update(i, { secondaryKeys: text.split(/[,，\s]+/).map((k) => k.trim()).filter(Boolean) })
}
function logicOf(e: WEntry): string {
  return String(e.selectiveLogic || 'AND_ANY')
}
function positionOf(e: WEntry): string {
  const p = e.position
  // 对齐旧版七位置（编辑器内以 '@D' 表示 at_depth）
  const named = ['system_top', 'global_note', 'before_char', 'after_char', 'user_top', 'assistant_top', '@D']
  if (typeof p === 'string') {
    if (named.includes(p)) return p
    if (p.startsWith('@') || /depth/.test(p)) return '@D'
    return 'after_char'
  }
  if (typeof p === 'number') {
    if (p === 0) return 'before_char'
    if (p === 1) return 'after_char'
    if (p === 2 || p === 3) return 'global_note'
    return '@D'
  }
  return 'after_char'
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 10px">
    <div v-for="(e, i) in items" :key="i" class="wb-entry">
      <div class="wb-head">
        <input
          class="input"
          style="flex: 1; padding: 6px 10px; font-size: 0.82rem"
          :value="e.comment || ''"
          placeholder="条目备注（如：世界观总设定）"
          @input="update(i, { comment: ($event.target as HTMLInputElement).value })"
        />
        <n-switch size="small" :value="e.enabled !== false" @update:value="(v: boolean) => update(i, { enabled: v })" />
        <div class="wb-ops">
          <button class="btn sm ghost" title="上移" @click="move(i, -1)"><ArrowUp :size="13" /></button>
          <button class="btn sm ghost" title="下移" @click="move(i, 1)"><ArrowDown :size="13" /></button>
          <button class="btn sm ghost danger" title="删除" @click="remove(i)"><Trash2 :size="13" /></button>
        </div>
      </div>
      <div class="wb-row">
        <input
          class="input"
          style="flex: 1; padding: 5px 10px; font-size: 0.78rem"
          :value="keysText(e)"
          placeholder="触发关键词（逗号分隔，支持 /正则/flags；留空且非常驻则不生效）"
          @input="setKeys(i, ($event.target as HTMLInputElement).value)"
        />
        <label class="switch-line" style="font-size: 0.76rem">
          <n-switch size="small" :value="!!e.constant" @update:value="(v: boolean) => update(i, { constant: v })" />
          常驻
        </label>
        <label class="switch-line" style="font-size: 0.76rem; gap: 4px">
          优先级
          <input
            class="input wb-order"
            type="number"
            :value="e.order ?? 100"
            @change="update(i, { order: Number(($event.target as HTMLInputElement).value) || 100 })"
          />
        </label>
      </div>

      <!-- 高级选项 -->
      <details class="wb-adv">
        <summary>高级选项</summary>
        <div style="display: flex; flex-direction: column; gap: 8px; padding-top: 8px">
          <div class="wb-row">
            <input
              class="input"
              style="flex: 1; padding: 5px 10px; font-size: 0.76rem"
              :value="secText(e)"
              placeholder="次要过滤词（配合逻辑使用，可空）"
              @input="setSec(i, ($event.target as HTMLInputElement).value)"
            />
            <select class="input wb-sel" :value="logicOf(e)" @change="update(i, { selectiveLogic: ($event.target as HTMLSelectElement).value as WILogic })">
              <option value="AND_ANY">且任一命中</option>
              <option value="AND_ALL">且全部命中</option>
              <option value="NOT_ANY">且无任一命中</option>
              <option value="NOT_ALL">非全部命中</option>
            </select>
          </div>
          <div class="wb-row">
            <label class="switch-line" style="font-size: 0.76rem">
              注入位置
              <select class="input wb-sel" :value="positionOf(e)" @change="update(i, { position: ($event.target as HTMLSelectElement).value as unknown })">
                <option value="system_top">系统顶部</option>
                <option value="global_note">全局注释</option>
                <option value="before_char">角色定义前</option>
                <option value="after_char">角色定义后</option>
                <option value="@D">@深度</option>
                <option value="user_top">用户消息顶</option>
                <option value="assistant_top">助手消息顶</option>
              </select>
            </label>
            <label v-if="positionOf(e) === '@D'" class="switch-line" style="font-size: 0.76rem; gap: 4px">
              深度
              <input class="input wb-order" type="number" min="0" :value="e.depth ?? 4" @change="update(i, { depth: Math.max(0, Number(($event.target as HTMLInputElement).value) || 4) })" />
            </label>
            <label v-if="positionOf(e) === '@D'" class="switch-line" style="font-size: 0.76rem">
              角色
              <select class="input wb-sel" :value="e.depthRole || 'user'" @change="update(i, { depthRole: ($event.target as HTMLSelectElement).value as 'system' | 'user' | 'assistant' })">
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
            </label>
            <label class="switch-line" style="font-size: 0.76rem; gap: 4px">
              触发概率 %
              <input class="input wb-order" type="number" min="0" max="100" :value="typeof e.probability === 'number' ? e.probability : 100" @change="update(i, { probability: Math.max(0, Math.min(100, Number(($event.target as HTMLInputElement).value))), useProbability: true })" />
            </label>
            <label class="switch-line" style="font-size: 0.76rem; gap: 4px">
              扫描深度
              <input class="input wb-order" type="number" min="0" title="留空=默认 2；0=不扫描（仅常驻可激活）" :value="e.scanDepth ?? 2" @change="setScanDepth(i, ($event.target as HTMLInputElement).value)" />
            </label>
          </div>
          <div class="wb-row" style="gap: 16px">
            <n-checkbox size="small" :checked="!!e.caseSensitive" @update:checked="(v: boolean) => update(i, { caseSensitive: v })">
              区分大小写
            </n-checkbox>
            <n-checkbox size="small" :checked="!!e.matchWholeWords" @update:checked="(v: boolean) => update(i, { matchWholeWords: v })">
              整词匹配
            </n-checkbox>
            <span class="chip">key 支持 /正则/flags 写法</span>
          </div>
        </div>
      </details>
      <textarea
        class="textarea"
        rows="3"
        style="font-size: 0.8rem; min-height: 60px"
        :value="e.content || ''"
        placeholder="条目内容（命中时注入提示词）"
        @input="update(i, { content: ($event.target as HTMLTextAreaElement).value })"
      />
    </div>

    <button class="btn sm" style="align-self: flex-start" @click="add"><Plus :size="14" />新增条目</button>
    <p v-if="!items.length" style="font-size: 0.78rem; color: var(--text-2)">
      世界书为空。条目分两类：<b>常驻</b>条目每次对话都注入；<b>关键词</b>条目在最近消息命中关键词时注入。
    </p>
  </div>
</template>

<style scoped>
.wb-entry {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(13, 18, 32, 0.45);
}
html[data-theme='light'] .wb-entry { background: #f6f8fd; }
.wb-head { display: flex; align-items: center; gap: 9px; }
.wb-ops { display: flex; gap: 2px; }
.wb-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.wb-order { width: 70px; padding: 4px 8px !important; font-size: 0.78rem; }
</style>
<style scoped>
.wb-adv summary { cursor: pointer; font-size: 0.74rem; color: var(--text-2); user-select: none; }
.wb-adv[open] summary { margin-bottom: 4px; }
.wb-sel { width: auto; padding: 4px 8px !important; font-size: 0.76rem; }
</style>
