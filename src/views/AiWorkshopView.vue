<script setup lang="ts">
/**
 * AI 工作台：全屏留边的独立页面，支持角色卡 / 世界书 / 正则 / UI 模板的 AI 辅助创建。
 */
import { computed, ref } from 'vue'
import {
  Wand2, User, BookOpen, Regex, LayoutTemplate, Sparkles, Save, Plus, Check,
} from 'lucide-vue-next'
import { NSelect, NButton } from 'naive-ui'
import { useSettingsStore } from '../stores/settings'
import { useCharactersStore } from '../stores/characters'
import { chatOnce, groupedModelOptions } from '../lib/api'
import { uuid } from '../lib/id'
import { normalizeUiTemplates, type UiTemplate } from '../lib/uitemplate'
import { toast } from '../lib/toast'
import type { CharacterCard } from '../types'

const emit = defineEmits<{ (e: 'close'): void; (e: 'goto', v: string): void }>()

const settings = useSettingsStore()
const characters = useCharactersStore()

type Tab = 'card' | 'worldbook' | 'regex' | 'uitpl'
const tab = ref<Tab>('card')

const TABS: { key: Tab; label: string; desc: string; icon: typeof Wand2 }[] = [
  { key: 'card', label: '角色卡', desc: '人设与开场白', icon: User },
  { key: 'worldbook', label: '世界书', desc: '世界观设定', icon: BookOpen },
  { key: 'regex', label: '正则脚本', desc: '文本转换规则', icon: Regex },
  { key: 'uitpl', label: 'UI 模板', desc: '交互面板', icon: LayoutTemplate },
]

/** 每个页签的输入区文案与示例 */
const TAB_META: Record<Tab, { title: string; desc: string; placeholder: string; action: string; examples: string[] }> = {
  card: {
    title: '描述你想要的角色', action: '生成角色卡',
    desc: '一句话人设即可，AI 会补全描述、性格、场景与开场白',
    placeholder: '例如：一个来自赛博朋克未来的黑客少女，外表冷淡但内心善良，擅长入侵企业系统，在霓虹雨夜的城市中行动…',
    examples: ['赛博朋克世界的黑客少女，外冷内热', '古风仙侠世界的剑客，背负血仇', '海滨小城的咖啡馆老板娘，温柔健谈'],
  },
  worldbook: {
    title: '描述需要的世界书条目', action: '生成世界书条目',
    desc: '生成 3-8 个条目，支持关键词触发或常驻注入',
    placeholder: '例如：为这个魔法世界生成魔法体系、学院制度、等级划分、禁忌魔法等核心设定…',
    examples: ['完整的魔法体系与等级划分', '主要势力与政治格局', '重要地点与传说'],
  },
  regex: {
    title: '描述需要的正则转换', action: '生成正则脚本',
    desc: '作用于 AI 输出的显示层或发送前的文本',
    placeholder: '例如：把星号包裹的动作描写转为斜体；把英文引号替换为中文引号…',
    examples: ['星号动作描写转斜体', '统一中文引号', '删除回复末尾的闲聊'],
  },
  uitpl: {
    title: '描述需要的 UI 模板', action: '生成 UI 模板',
    desc: '自包含 HTML 面板，支持 {{变量}} 插值与 {{#each}} 循环',
    placeholder: '例如：一个角色状态面板，显示 HP/MP 条、金币数量和背包物品列表，深色赛博朋克风格…',
    examples: ['HP/MP 状态条 + 金币面板', '五维好感度进度条', '背包物品列表（深色风）'],
  },
}
const meta = computed(() => TAB_META[tab.value])

const busy = ref(false)
const error = ref('')

// 目标角色卡（世界书/正则/UI 模板需要挂载到某张卡）
const targetCharUuid = ref('')
const charOptions = computed(() => [
  ...characters.list.map((c) => ({ label: c.name, value: c.uuid })),
])

function targetCard(): CharacterCard | null {
  return characters.list.find((c) => c.uuid === targetCharUuid.value) || null
}

// ── 通用模型选择 ──
const modelOptions = computed(() => {
  const ids = settings.modelsCache.length
    ? settings.modelsCache
    : settings.activeModel
      ? [settings.activeModel]
      : []
  return groupedModelOptions(ids, 'text')
})
const selectedModel = ref('')
const effectiveModel = computed(() => selectedModel.value || settings.activeModel)
// 选择器默认显示实际生效的模型（未手动选择时 = 当前对话模型）；空用 null 让占位符可见
const modelSelectValue = computed<string | null>(() => selectedModel.value || settings.activeModel || null)

async function callAi(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!settings.settings.apiKey || !effectiveModel.value) {
    throw new Error('请先在「设置」中配置 API Key 和模型')
  }
  return chatOnce({
    baseUrl: settings.settings.apiBaseUrl,
    apiKey: settings.settings.apiKey,
    model: effectiveModel.value,
    temperature: 0.85,
    maxTokens: 4096,
    reasoningEffort: 'minimal',
  }, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ])
}

function extractJson(raw: string): unknown {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  return JSON.parse(s)
}

// ── 1. 角色卡 ──
const cardInput = ref('')
const cardResult = ref<{
  name: string; description: string; personality: string
  scenario: string; first_mes: string; creator_notes: string
} | null>(null)

async function genCard() {
  error.value = ''
  if (!cardInput.value.trim()) { error.value = '请输入角色描述'; return }
  busy.value = true
  try {
    const sys = `你是角色卡设计助手。根据用户给的描述，生成角色扮演 AI 用的角色卡字段。
只输出 JSON，不要任何解释或代码围栏。JSON 字段：
{
  "name": "角色名",
  "description": "人设主体（外貌、身份、核心设定，200-500字）",
  "personality": "性格特征（简洁要点）",
  "scenario": "初始场景/世界观背景",
  "first_mes": "开场白（角色视角第一段对话/描写，150-400字，带场景感）",
  "creator_notes": "给使用者的备注（可选）"
}`
    const raw = await callAi(sys, `角色描述：${cardInput.value.trim()}`)
    cardResult.value = extractJson(raw) as typeof cardResult.value
    toast.success('角色卡字段已生成，可编辑后保存')
  } catch (err) {
    error.value = `生成失败：${(err as Error).message}`
  } finally {
    busy.value = false
  }
}

async function saveCard() {
  if (!cardResult.value?.name) { toast.error('角色名不能为空'); return }
  const card = characters.emptyCard()
  card.name = cardResult.value.name
  card.description = cardResult.value.description || ''
  card.personality = cardResult.value.personality || ''
  card.scenario = cardResult.value.scenario || ''
  card.first_mes = cardResult.value.first_mes || ''
  card.creator_notes = cardResult.value.creator_notes || ''
  await characters.put(card)
  toast.success(`角色卡「${card.name}」已保存`)
  cardResult.value = null
  cardInput.value = ''
  emit('goto', 'characters')
}

// ── 2. 世界书 ──
const wbInput = ref('')
const wbResult = ref<{ comment: string; keys: string[]; content: string; constant?: boolean }[]>([])

async function genWorldbook() {
  error.value = ''
  if (!wbInput.value.trim()) { error.value = '请描述需要的世界书条目'; return }
  if (!targetCard()) { error.value = '请先选择目标角色卡'; return }
  busy.value = true
  try {
    const sys = `你是角色扮演世界书（Lorebook）设计助手。根据用户描述生成世界书条目。
只输出 JSON 数组，不要解释或代码围栏。每个条目：
{
  "comment": "条目标题/注释",
  "keys": ["触发词1", "触发词2"],
  "content": "条目正文（设定细节，100-300字）",
  "constant": false
}
constant=true 表示常驻条目（无需触发词，始终注入），否则需要 keys 触发。生成 3-8 个条目。`
    const card = targetCard()!
    const raw = await callAi(sys, `角色：${card.name}\n已有设定：${(card.description || '').slice(0, 500)}\n\n需要：${wbInput.value.trim()}`)
    const parsed = extractJson(raw)
    wbResult.value = Array.isArray(parsed) ? parsed : []
    toast.success(`已生成 ${wbResult.value.length} 条世界书条目`)
  } catch (err) {
    error.value = `生成失败：${(err as Error).message}`
  } finally {
    busy.value = false
  }
}

async function applyWorldbook() {
  const card = targetCard()
  if (!card || !wbResult.value.length) return
  const existing = (card.worldInfo || []) as Record<string, unknown>[]
  const maxOrder = existing.reduce((m, e) => Math.max(m, Number(e.order) || 0), 0)
  for (const [i, e] of wbResult.value.entries()) {
    existing.push({
      comment: e.comment || 'AI 生成',
      keys: e.keys || [],
      content: e.content || '',
      constant: !!e.constant,
      enabled: true,
      order: maxOrder + i + 1,
    })
  }
  card.worldInfo = existing
  await characters.put(card)
  toast.success(`已添加 ${wbResult.value.length} 条到「${card.name}」`)
  wbResult.value = []
  wbInput.value = ''
}

// ── 3. 正则脚本 ──
const rxInput = ref('')
const rxResult = ref<{ name: string; pattern: string; replace: string; flags: string; applyOnDisplay: boolean; applyOnSend: boolean }[]>([])

async function genRegex() {
  error.value = ''
  if (!rxInput.value.trim()) { error.value = '请描述需要的正则转换'; return }
  if (!targetCard()) { error.value = '请先选择目标角色卡'; return }
  busy.value = true
  try {
    const sys = `你是角色扮演正则脚本设计助手。根据用户描述生成正则替换脚本。
只输出 JSON 数组，不要解释或代码围栏。每个脚本：
{
  "name": "脚本名称",
  "pattern": "正则表达式（JavaScript 语法）",
  "replace": "替换文本（可用 $1 $2 等捕获组）",
  "flags": "g",
  "applyOnDisplay": true,
  "applyOnSend": false
}
applyOnDisplay=true 表示处理 AI 输出（显示层），applyOnSend=true 表示处理用户输入（发送层）。生成 1-5 个脚本。`
    const raw = await callAi(sys, `需要：${rxInput.value.trim()}`)
    const parsed = extractJson(raw)
    rxResult.value = Array.isArray(parsed) ? parsed : []
    toast.success(`已生成 ${rxResult.value.length} 个正则脚本`)
  } catch (err) {
    error.value = `生成失败：${(err as Error).message}`
  } finally {
    busy.value = false
  }
}

async function applyRegex() {
  const card = targetCard()
  if (!card || !rxResult.value.length) return
  const existing = (card.regexScripts || []) as Record<string, unknown>[]
  for (const e of rxResult.value) {
    // 酒馆 placement 数组：1=用户输入(发送层) 2=AI输出(显示层)；并保留两个层开关，
    // 否则 normalizeRegexScript 会按默认值全开，编辑器里的勾选形同虚设
    const placement = [e.applyOnSend ? 1 : 0, e.applyOnDisplay ? 2 : 0].filter(Boolean)
    existing.push({
      name: e.name || 'AI 生成',
      findRegex: `/${e.pattern || ''}/${e.flags || 'g'}`,
      replaceString: e.replace || '',
      trimStrings: [],
      placement,
      disabled: false,
      markdownOnly: e.applyOnDisplay === true && e.applyOnSend !== true,
      promptOnly: e.applyOnSend === true && e.applyOnDisplay !== true,
      runOnEdit: true,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
    })
  }
  card.regexScripts = existing
  await characters.put(card)
  toast.success(`已添加 ${rxResult.value.length} 个正则到「${card.name}」`)
  rxResult.value = []
  rxInput.value = ''
}

// ── 4. UI 模板 ──
const uiInput = ref('')
const uiResult = ref<{ name: string; htmlTemplate: string; placement: string; initialVariableState?: Record<string, unknown> } | null>(null)

async function genUiTemplate() {
  error.value = ''
  if (!uiInput.value.trim()) { error.value = '请描述需要的 UI 模板'; return }
  busy.value = true
  try {
    const sys = `你是角色扮演 UI 模板设计助手。根据用户描述生成一个交互式 HTML UI 模板。
只输出 JSON，不要解释或代码围栏。JSON 字段：
{
  "name": "模板名称",
  "htmlTemplate": "完整的 HTML 代码（可含 CSS <style> 和 JS <script>，用 {{变量名}} 作为占位符，用 {{#each items}}...{{/each}} 做循环）",
  "placement": "top",
  "initialVariableState": { "变量名": "初始值" }
}
placement 为 "top"（消息上方）或 "bottom"（消息下方）。
HTML 模板要求：自包含（内联 CSS）、移动端友好、深色主题适配、不要引用外部资源。
变量用 {{p_name}} 这类双花括号语法；循环用 {{#each list}}{{this}}{{/each}}。`
    const card = targetCard()
    const ctx = card ? `角色：${card.name}\n设定：${(card.description || '').slice(0, 300)}` : ''
    const raw = await callAi(sys, `${ctx}\n\n需要：${uiInput.value.trim()}`)
    uiResult.value = extractJson(raw) as typeof uiResult.value
    toast.success('UI 模板已生成')
  } catch (err) {
    error.value = `生成失败：${(err as Error).message}`
  } finally {
    busy.value = false
  }
}

async function applyUiTemplate() {
  if (!uiResult.value?.htmlTemplate) { toast.error('模板内容为空'); return }
  if (!targetCard()) { error.value = '请先选择目标角色卡'; return }
  const card = targetCard()!
  const tpl: UiTemplate = {
    id: uuid(),
    name: uiResult.value.name || 'AI 生成模板',
    enabled: true,
    order: (card.uiTemplates || []).length + 1,
    placement: (uiResult.value.placement === 'top' ? 'top' : 'bottom') as UiTemplate['placement'],
    htmlTemplate: uiResult.value.htmlTemplate,
    initialVariableState: uiResult.value.initialVariableState || {},
  }
  const normalized = normalizeUiTemplates([...(card.uiTemplates || []), tpl])
  card.uiTemplates = normalized
  await characters.put(card)
  toast.success(`UI 模板已添加到「${card.name}」`)
  uiResult.value = null
  uiInput.value = ''
}

/** 四个页签共用一个输入作曲台：随页签切换读写各自的输入 */
const activeInput = computed<string>({
  get: () =>
    tab.value === 'card' ? cardInput.value
    : tab.value === 'worldbook' ? wbInput.value
    : tab.value === 'regex' ? rxInput.value
    : uiInput.value,
  set: (v) => {
    if (tab.value === 'card') cardInput.value = v
    else if (tab.value === 'worldbook') wbInput.value = v
    else if (tab.value === 'regex') rxInput.value = v
    else uiInput.value = v
  },
})

function runGenerate() {
  if (tab.value === 'card') genCard()
  else if (tab.value === 'worldbook') genWorldbook()
  else if (tab.value === 'regex') genRegex()
  else genUiTemplate()
}
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner" style="max-width: none; display: flex; flex-direction: column; min-height: 100%">
        <!-- 头部 -->
        <div class="page-toolbar" style="margin-bottom: 10px">
          <div class="section-title" style="margin-bottom: 0">
            <Wand2 /> AI 工作台
          </div>
          <div style="flex: 1" />
          <NSelect
            :value="modelSelectValue"
            size="small"
            filterable
            tag
            clearable
            :options="modelOptions"
            placeholder="未选择模型（先到设置中配置）"
            style="width: 320px"
            @update:value="(v: string | null) => selectedModel = v || ''"
          />
        </div>
        <p style="font-size: 0.95rem; color: var(--text-2); margin: 0 0 16px; line-height: 1.7">
          用自然语言描述，AI 帮你生成角色卡、世界书、正则脚本和 UI 模板。生成后可编辑再保存。
        </p>

        <div class="aiw-card" style="flex: 1; display: flex; flex-direction: column; min-height: 0">
          <div class="aiw-body" style="flex: 1; min-height: 0">
        <!-- 左侧 Tab -->
        <nav class="aiw-nav">
          <button
            v-for="t in TABS"
            :key="t.key"
            class="aiw-nav-item"
            :class="{ active: tab === t.key }"
            @click="tab = t.key"
          >
            <span class="aiw-nav-icon"><component :is="t.icon" :size="18" /></span>
            <span class="aiw-nav-text">
              <b>{{ t.label }}</b>
              <i>{{ t.desc }}</i>
            </span>
          </button>
        </nav>

        <!-- 主内容 -->
        <main class="aiw-main">
          <!-- 目标角色卡选择（世界书/正则/UI模板需要） -->
          <div v-if="tab !== 'card'" class="aiw-target">
            <label>生成对象</label>
            <NSelect
              v-model:value="targetCharUuid"
              size="small"
              filterable
              :options="charOptions"
              placeholder="选择要添加到的角色卡…"
              style="max-width: 420px"
            />
          </div>

          <!-- 输入作曲台 -->
          <div class="composer">
            <div class="composer-head">
              <span class="composer-title">{{ meta.title }}</span>
              <span class="composer-desc">{{ meta.desc }}</span>
            </div>
            <textarea v-model="activeInput" class="composer-input" rows="8" :placeholder="meta.placeholder" />
            <div class="composer-foot">
              <button v-for="ex in meta.examples" :key="ex" class="ex-chip" :title="'填入示例：' + ex" @click="activeInput = ex">{{ ex }}</button>
              <button class="ex-chip ghost" @click="activeInput = ''">清空</button>
              <div style="flex: 1" />
              <NButton type="primary" size="large" :loading="busy" @click="runGenerate">
                <template #icon><Sparkles /></template>{{ meta.action }}
              </NButton>
            </div>
          </div>

          <div v-if="error" class="danger-box" style="margin-top: 14px">{{ error }}</div>

          <!-- 角色卡结果 -->
          <div v-if="tab === 'card' && cardResult" class="aiw-result">
            <div class="aiw-result-head"><Check :size="16" /><span>生成完成 · 可编辑后保存</span></div>
            <div class="field"><label>角色名</label><input v-model="cardResult.name" class="input" /></div>
            <div class="field"><label>人设描述</label><textarea v-model="cardResult.description" class="textarea" rows="6" /></div>
            <div class="grid-2">
              <div class="field"><label>性格</label><textarea v-model="cardResult.personality" class="textarea" rows="3" /></div>
              <div class="field"><label>场景</label><textarea v-model="cardResult.scenario" class="textarea" rows="3" /></div>
            </div>
            <div class="field"><label>开场白</label><textarea v-model="cardResult.first_mes" class="textarea" rows="6" /></div>
            <div class="field"><label>作者备注</label><textarea v-model="cardResult.creator_notes" class="textarea" rows="2" /></div>
            <div class="aiw-actions">
              <NButton type="primary" size="large" @click="saveCard"><template #icon><Save /></template>保存为新角色卡</NButton>
            </div>
          </div>

          <!-- 世界书结果 -->
          <div v-if="tab === 'worldbook' && wbResult.length" class="aiw-result">
            <div class="aiw-result-head"><Check :size="16" /><span>已生成 {{ wbResult.length }} 条 · 可编辑后添加</span></div>
            <div v-for="(e, i) in wbResult" :key="i" class="aiw-item">
              <div class="aiw-item-head">
                <span class="aiw-idx">{{ i + 1 }}</span>
                <input v-model="e.comment" class="input" placeholder="条目标题" />
              </div>
              <input :value="e.keys.join(', ')" class="input" placeholder="触发词（逗号分隔）" style="margin-top: 8px" @change="e.keys = ($event.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)" />
              <textarea v-model="e.content" class="textarea" rows="4" placeholder="条目正文" style="margin-top: 8px" />
            </div>
            <div class="aiw-actions">
              <NButton type="primary" size="large" @click="applyWorldbook"><template #icon><Plus /></template>全部添加到角色卡</NButton>
            </div>
          </div>

          <!-- 正则结果 -->
          <div v-if="tab === 'regex' && rxResult.length" class="aiw-result">
            <div class="aiw-result-head"><Check :size="16" /><span>已生成 {{ rxResult.length }} 个脚本 · 可编辑后添加</span></div>
            <div v-for="(e, i) in rxResult" :key="i" class="aiw-item">
              <div class="aiw-item-head">
                <span class="aiw-idx">{{ i + 1 }}</span>
                <input v-model="e.name" class="input" placeholder="脚本名称" />
              </div>
              <div class="grid-2" style="margin-top: 8px">
                <div class="field" style="margin-bottom: 0"><label>正则表达式</label><input v-model="e.pattern" class="input mono" /></div>
                <div class="field" style="margin-bottom: 0"><label>替换为</label><input v-model="e.replace" class="input mono" /></div>
              </div>
              <div class="rx-toggles">
                <label><input type="checkbox" v-model="e.applyOnDisplay" /> 显示层（AI 输出）</label>
                <label><input type="checkbox" v-model="e.applyOnSend" /> 发送层（用户输入）</label>
              </div>
            </div>
            <div class="aiw-actions">
              <NButton type="primary" size="large" @click="applyRegex"><template #icon><Plus /></template>全部添加到角色卡</NButton>
            </div>
          </div>

          <!-- UI 模板结果 -->
          <div v-if="tab === 'uitpl' && uiResult" class="aiw-result">
            <div class="aiw-result-head"><Check :size="16" /><span>生成完成 · 可编辑后添加</span></div>
            <div class="grid-2">
              <div class="field">
                <label>模板名称</label>
                <input v-model="uiResult.name" class="input" />
              </div>
              <div class="field">
                <label>挂载位置</label>
                <select v-model="uiResult.placement" class="input">
                  <option value="top">消息上方（top）</option>
                  <option value="bottom">消息下方（bottom）</option>
                </select>
              </div>
            </div>
            <div class="field"><label>HTML 模板</label><textarea v-model="uiResult.htmlTemplate" class="textarea mono" rows="16" /></div>
            <div class="aiw-actions">
              <NButton type="primary" size="large" @click="applyUiTemplate"><template #icon><Plus /></template>添加到角色卡</NButton>
            </div>
          </div>
        </main>
        </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aiw-card {
  background: linear-gradient(180deg, rgba(22, 29, 51, 0.55), rgba(15, 21, 37, 0.75));
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  backdrop-filter: blur(8px);
  overflow: hidden;
}
html[data-theme='light'] .aiw-card {
  background: linear-gradient(180deg, #ffffff, #fbfcff);
}

.aiw-body { display: flex; min-height: 480px; }
.aiw-nav {
  width: 216px; flex-shrink: 0;
  border-right: 1px solid var(--line);
  padding: 20px 14px;
  display: flex; flex-direction: column; gap: 6px;
}
.aiw-nav-item {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px; border-radius: 12px;
  border: none; background: none; cursor: pointer;
  color: var(--text-2);
  transition: all 0.15s; text-align: left; width: 100%;
}
.aiw-nav-item:hover { background: var(--bg-2); color: var(--text-1); }
.aiw-nav-item.active {
  background: var(--accent-grad); color: #fff;
  box-shadow: 0 4px 14px rgba(139, 92, 246, 0.3);
}
.aiw-nav-icon {
  width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-2); color: var(--text-2);
  transition: all 0.15s;
}
.aiw-nav-item.active .aiw-nav-icon { background: rgba(255, 255, 255, 0.18); color: #fff; }
.aiw-nav-text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.35; }
.aiw-nav-text b { font-size: 0.95rem; font-weight: 700; }
.aiw-nav-text i { font-style: normal; font-size: 0.72rem; color: var(--text-2); }
.aiw-nav-item.active .aiw-nav-text i { color: rgba(255, 255, 255, 0.75); }

/* 输入作曲台 */
.composer {
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: var(--bg-1);
  transition: border-color 0.15s, box-shadow 0.15s;
  margin-bottom: 16px;
}
.composer:focus-within {
  border-color: rgba(139, 92, 246, 0.55);
  box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.12);
}
.composer-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; padding: 15px 18px 0; }
.composer-title { font-size: 1.08rem; font-weight: 800; color: var(--text-0); }
.composer-desc { font-size: 0.8rem; color: var(--text-2); }
.composer-input {
  display: block; width: 100%; border: none; outline: none; background: transparent;
  min-height: 150px; resize: vertical; padding: 12px 18px;
  font: inherit; font-size: 0.98rem; line-height: 1.75; color: var(--text-0);
}
.composer-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 12px 12px; }
.ex-chip {
  border: 1px dashed var(--line-strong); background: transparent; color: var(--text-2);
  border-radius: 999px; padding: 6px 13px; font-size: 0.78rem; cursor: pointer; transition: all 0.15s;
}
.ex-chip:hover { color: var(--accent); border-color: rgba(139, 92, 246, 0.5); background: rgba(139, 92, 246, 0.07); }
.ex-chip.ghost { border-style: solid; }

.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 860px) { .grid-2 { grid-template-columns: 1fr; } }

/* 手机：左侧目标导航改为顶部横向滑动条，主内容交给外层页面滚动 */
@media (max-width: 768px) {
  .aiw-body { flex-direction: column; min-height: 0; }
  .aiw-nav {
    width: 100%;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid var(--line);
    padding: 10px 12px;
  }
  .aiw-nav-item { width: auto; flex-shrink: 0; padding: 8px 12px; }
  .aiw-nav-icon { width: 28px; height: 28px; }
  .aiw-nav-text i { display: none; }
  .aiw-main { overflow-y: visible; padding: 16px 14px 24px; }
  .aiw-target { flex-direction: column; align-items: stretch; gap: 8px; }
  .aiw-target label { white-space: normal; }
}

.aiw-main { flex: 1; overflow-y: auto; padding: 28px 36px; }
/* 放大工作台内的输入内容 */
.aiw-main .textarea, .aiw-main .input { font-size: 0.95rem; }
.aiw-main .field label { font-size: 0.95rem; }
.aiw-target {
  display: flex; align-items: center; gap: 14px; margin-bottom: 18px;
  padding: 13px 18px; border-radius: 12px;
  background: var(--bg-2); border: 1px solid var(--line);
}
.aiw-target label { font-size: 0.92rem; font-weight: 700; white-space: nowrap; }

.aiw-section { margin-bottom: 22px; }
.aiw-section label { display: block; font-size: 0.98rem; font-weight: 700; margin-bottom: 10px; }
.aiw-section .textarea { margin-bottom: 16px; }

.aiw-result {
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  padding: 20px 24px;
  background: rgba(13, 18, 32, 0.4);
}
html[data-theme='light'] .aiw-result { background: #f6f8fd; }
.aiw-result-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 0.95rem; font-weight: 700; margin-bottom: 16px;
  color: var(--text-1);
}
.aiw-result-head svg { color: var(--success); }
.aiw-item {
  padding: 16px; border-radius: 12px;
  background: var(--bg-2); border: 1px solid var(--line);
  margin-bottom: 12px;
}
.aiw-item-head { display: flex; align-items: center; gap: 10px; }
.aiw-idx {
  width: 26px; height: 26px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-grad); color: #fff; font-size: 0.78rem; font-weight: 700;
}
.rx-toggles { display: flex; gap: 16px; margin-top: 10px; font-size: 0.82rem; color: var(--text-1); }
.rx-toggles label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.aiw-actions { margin-top: 16px; display: flex; gap: 10px; }
</style>

