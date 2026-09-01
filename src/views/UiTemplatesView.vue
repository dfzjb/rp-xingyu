<script setup lang="ts">
/**
 * UI 模板管理：选择角色卡 → 查看其 uiTemplates 条目（沙箱 iframe 预览 + JSON 编辑）。
 * 数据随角色卡保存（旧版 uiTemplates 字段兼容）。
 * 附：变量回写规则（state-sync）——正则驱动的更新指令方言，让其他生态角色卡也能回写面板变量。
 */
import { computed, ref, watch } from 'vue'
import { LayoutTemplate, Save, Workflow } from 'lucide-vue-next'
import { NSwitch } from 'naive-ui'
import { useCharactersStore } from '../stores/characters'
import { buildHtmlDocument, normalizeUiTemplates, renderUiTemplateHtml, type UiTemplate } from '../lib/uitemplate'
import {
  builtinStateSyncRules, normalizeStateSyncRule, normalizeStateSyncRules,
  type StateSyncRule,
} from '../lib/state-sync'

const characters = useCharactersStore()

const selectedUuid = ref('')
const editing = ref(false)
const editJson = ref('[]')
const editError = ref('')
const previewIdx = ref(0)

// ── 变量回写规则 ──
const rulesEditing = ref(false)
const rulesJson = ref('[]')
const rulesError = ref('')

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
  rulesEditing.value = false
  rulesError.value = ''
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

// ── 变量回写规则：列表 / JSON 编辑 / 预设 ──
const builtins = builtinStateSyncRules()
const cardRules = computed(() => normalizeStateSyncRules(card.value?.stateSyncRules))

function startRulesEdit() {
  if (!card.value) return
  rulesJson.value = JSON.stringify(card.value.stateSyncRules || [], null, 2)
  rulesEditing.value = true
  rulesError.value = ''
}

async function saveRulesEdit() {
  if (!card.value) return
  try {
    const parsed = JSON.parse(rulesJson.value)
    if (!Array.isArray(parsed)) throw new Error('必须是数组')
    const invalid = parsed.filter((r) => !normalizeStateSyncRule(r))
    if (invalid.length) throw new Error(`有 ${invalid.length} 条规则无效（缺 pattern 或正则编译失败）`)
    card.value.stateSyncRules = parsed
    await characters.put(card.value)
    rulesEditing.value = false
    rulesError.value = ''
  } catch (err) {
    rulesError.value = `${(err as Error).message}`
  }
}

const RULE_PRESETS: Record<string, StateSyncRule> = {
  updateVariable: {
    name: '酒馆变量块 <UpdateVariable>',
    pattern: '<UpdateVariable\\b[^>]*>([\\s\\S]*?)</UpdateVariable>',
    flags: 'gi',
    dialect: 'json_block',
  },
  setvar: {
    name: '酒馆宏 {{setvar}}',
    pattern: '\\{\\{set(?:global)?var::(?<path>[^:{}]+)::(?<value>[\\s\\S]*?)\\}\\}',
    flags: 'g',
    dialect: 'macro_setvar',
  },
  customTag: {
    name: '自定义更新块 <状态>',
    pattern: '<状态(?=[\\s>/])[^>]*>([\\s\\S]*?)</状态>',
    flags: 'gi',
    dialect: 'json_block',
  },
  rpHub: {
    name: '旧版 更新块 <ui_template_updates>',
    pattern: '<ui_template_updates\\b[^>]*>([\\s\\S]*?)</ui_template_updates>',
    flags: 'gi',
    dialect: 'legacy_json',
  },
}

async function addRulePreset(kind: keyof typeof RULE_PRESETS) {
  if (!card.value) return
  const list = Array.isArray(card.value.stateSyncRules) ? [...(card.value.stateSyncRules as unknown[])] : []
  list.push({ ...RULE_PRESETS[kind] })
  card.value.stateSyncRules = list
  await characters.put(card.value)
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

          <!-- 变量回写规则（state-sync）：正则驱动的更新指令方言 -->
          <div class="section-title" style="font-size: 0.98rem; margin-top: 22px"><Workflow /> 变量回写规则</div>
          <p style="font-size: 0.78rem; color: var(--text-2); margin-bottom: 10px; line-height: 1.7">
            从 AI 回复中提取面板变量更新指令的正则规则（三步闭环的"解析"端，格式不限于 旧版 方言）。
            内置规则全局生效；酒馆 <code v-pre>{{setvar}}</code> 宏默认关闭，需要时从下方预设添加为卡级规则。
          </p>

          <div class="tpl-list">
            <div v-for="b in builtins" :key="b.id" class="tpl-row" style="cursor: default; opacity: 0.9">
              <span>内置 · {{ b.name }}</span>
              <span style="font-size: 0.72rem" :style="{ color: b.disabled ? 'var(--text-2)' : 'var(--accent, #8b5cf6)' }">
                {{ b.disabled ? '默认关闭（可从预设启用）' : '默认启用' }}
              </span>
            </div>
            <div v-for="(r, i) in cardRules" :key="i" class="tpl-row" style="cursor: default">
              <span>卡级 · {{ r.name }}</span>
              <span style="font-size: 0.72rem; color: var(--text-2)">方言 {{ r.dialect }}</span>
            </div>
            <div v-if="!cardRules.length" style="font-size: 0.76rem; color: var(--text-2); padding: 2px 13px">
              该卡暂无自定义规则
            </div>
          </div>

          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px">
            <button class="btn sm" @click="addRulePreset('updateVariable')">＋ 酒馆 &lt;UpdateVariable&gt;</button>
            <button class="btn sm" @click="addRulePreset('setvar')">＋ 酒馆 <span v-pre>{{setvar}}</span> 宏</button>
            <button class="btn sm" @click="addRulePreset('customTag')">＋ 自定义标签块</button>
            <button class="btn sm" @click="addRulePreset('rpHub')">＋ 旧版 更新块</button>
            <button class="btn sm" style="margin-left: auto" @click="rulesEditing ? saveRulesEdit() : startRulesEdit()">
              <Save :size="13" />{{ rulesEditing ? '保存规则' : '编辑 JSON' }}
            </button>
          </div>

          <div v-if="rulesEditing" class="card-panel" style="padding: 12px">
            <textarea v-model="rulesJson" class="textarea mono" rows="10" />
            <div v-if="rulesError" class="danger-box">{{ rulesError }}</div>
            <div style="font-size: 0.74rem; color: var(--text-2); line-height: 1.7; margin-top: 6px">
              字段：name（名称）、pattern（正则源码，捕获组 1 = JSON 载荷；macro_setvar 用命名组 &lt;path&gt;/&lt;value&gt;）、
              flags（默认 g）、dialect（legacy_json / json_block / macro_setvar）、template（固定目标模板 id 或名称，可选）、disabled。
            </div>
          </div>
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
