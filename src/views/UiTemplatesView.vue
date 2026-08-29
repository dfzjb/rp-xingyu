<script setup lang="ts">
/**
 * UI 模板管理：选择角色卡 → 查看其 uiTemplates 条目（沙箱 iframe 预览 + JSON 编辑）。
 * 数据随角色卡保存（旧版 uiTemplates 字段兼容）。
 */
import { computed, ref, watch } from 'vue'
import { LayoutTemplate, Save } from 'lucide-vue-next'
import { NSwitch } from 'naive-ui'
import { useCharactersStore } from '../stores/characters'
import { buildHtmlDocument, normalizeUiTemplates, renderUiTemplateHtml, type UiTemplate } from '../lib/uitemplate'

const characters = useCharactersStore()

const selectedUuid = ref('')
const editing = ref(false)
const editJson = ref('[]')
const editError = ref('')
const previewIdx = ref(0)

interface UiTpl {
  id?: string
  name?: string
  enabled?: boolean | string
  htmlTemplate?: string
  [k: string]: unknown
}

const card = computed(() => characters.list.find((c) => c.uuid === selectedUuid.value) || null)

function tplList(c: { uiTemplates?: unknown[] } | null | undefined): UiTpl[] {
  return (c?.uiTemplates || []) as UiTpl[]
}

const templates = computed(() => tplList(card.value))
const current = computed(() => templates.value[previewIdx.value] || null)
/** 预览：变量填充后的真实渲染效果（与对话内一致） */
const previewDoc = computed(() => {
  if (!current.value?.htmlTemplate) return ''
  const [tpl] = normalizeUiTemplates([current.value])
  return tpl ? buildHtmlDocument(renderUiTemplateHtml(tpl)) : ''
})

watch(selectedUuid, () => {
  previewIdx.value = 0
  editing.value = false
})

function isEnabled(t: UiTpl): boolean {
  return t.enabled !== false && t.enabled !== 'False' && t.enabled !== 'false'
}

function toggleTpl(i: number, v: boolean) {
  if (!card.value) return
  const list = JSON.parse(JSON.stringify(templates.value)) as UiTpl[]
  list[i].enabled = v
  card.value.uiTemplates = normalizeUiTemplates(list)
  void characters.put(card.value)
}

function startEdit() {
  if (!card.value) return
  editJson.value = JSON.stringify(card.value.uiTemplates || [], null, 2)
  editing.value = true
  editError.value = ''
}

async function saveEdit() {
  if (!card.value) return
  try {
    const parsed = JSON.parse(editJson.value)
    if (!Array.isArray(parsed)) throw new Error('必须是数组')
    card.value.uiTemplates = normalizeUiTemplates(parsed)
    await characters.put(card.value)
    editing.value = false
    editError.value = ''
  } catch (err) {
    editError.value = `JSON 解析失败：${(err as Error).message}`
  }
}
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner" style="max-width: 900px">
        <div class="section-title" style="font-size: 1.12rem"><LayoutTemplate /> UI 模板</div>

        <div class="field" style="max-width: 360px">
          <label>选择角色卡</label>
          <select v-model="selectedUuid" class="input">
            <option value="">— 选择 —</option>
            <option v-for="c in characters.list" :key="c.uuid" :value="c.uuid">{{ c.name }}</option>
          </select>
        </div>

        <template v-if="card">
          <p style="font-size: 0.78rem; color: var(--text-2); margin-bottom: 12px; line-height: 1.7">
            交互式 HTML 模板。启用后会在对话中随最后一条 AI 消息渲染（开场白即可见），
            预览即为变量填充后的真实效果；数据随角色卡保存，导出卡时一并带走。
          </p>

          <div v-if="!templates.length" class="chat-empty" style="padding: 50px 0">
            <div class="empty-glyph"><LayoutTemplate /></div>
            <div style="font-size: 0.88rem">该角色卡没有 UI 模板</div>
          </div>

          <template v-else>
            <div class="tpl-list">
              <button
                v-for="(t, i) in templates"
                :key="i"
                class="tpl-row"
                :class="{ active: previewIdx === i }"
                @click="previewIdx = i"
              >
                <span>{{ t.name || `模板 ${i + 1}` }}</span>
                <NSwitch size="small" :value="isEnabled(t)" @click.stop @update:value="(v: boolean) => toggleTpl(i, v)" />
              </button>
            </div>

            <div v-if="current" class="card-panel" style="padding: 12px">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px">
                <b style="font-size: 0.85rem">{{ current.name || '模板预览' }}</b>
                <button class="btn sm" @click="editing ? saveEdit() : startEdit()">
                  <Save :size="13" />{{ editing ? '保存' : '编辑 JSON' }}
                </button>
              </div>

              <template v-if="!editing">
                <iframe
                  v-if="previewDoc"
                  class="html-frame"
                  style="height: 50vh"
                  sandbox="allow-scripts"
                  :srcdoc="previewDoc"
                  title="模板预览（已沙箱隔离）"
                />
                <div v-else style="color: var(--text-2); font-size: 0.78rem">该条目没有 htmlTemplate 内容。</div>
              </template>
              <template v-else>
                <textarea v-model="editJson" class="textarea mono" rows="14" />
                <div v-if="editError" class="danger-box">{{ editError }}</div>
              </template>
            </div>
          </template>
        </template>

        <div v-else-if="characters.list.length" class="chat-empty" style="padding: 40px 0">
          <div>↑ 请先选择一张角色卡</div>
        </div>
        <div v-else class="chat-empty" style="padding: 60px 0">
          <div class="empty-glyph"><LayoutTemplate /></div>
          <div style="font-size: 0.9rem">还没有角色卡——先到「角色卡管理」导入</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tpl-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.tpl-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 13px;
  border-radius: 11px;
  border: 1px solid var(--line);
  background: var(--bg-1);
  color: var(--text-0);
  cursor: pointer;
  font-size: 0.85rem;
}
.tpl-row.active { border-color: rgba(139, 92, 246, 0.55); background: rgba(139, 92, 246, 0.1); }
html[data-theme='light'] .tpl-row { background: #ffffff; }
</style>
