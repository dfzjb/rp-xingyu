<script setup lang="ts">
// 跑团「模型设置」：KP 专用模型配置，只对在线跑团生效。
// 未启用（或连接信息不完整）时，KP 自动回退「更多 → 语言模型」当前激活槽位。
// 高级折叠区保留中继地址与房主世界观备注（原有功能，非模型配置）。
import { computed, onMounted, reactive, ref } from 'vue'
import { NInput, NSelect, NSlider, NInputNumber, NButton } from 'naive-ui'
import { loadWorldNote, saveWorldNote } from '../../lib/hall/useHall'
import { DEFAULT_HALL_RELAY } from '../../lib/hall/protocol'
import { useSettingsStore } from '../../stores/settings'
import { fetchModels, groupedModelOptions } from '../../lib/api'
import { toast } from '../../lib/toast'

const emit = defineEmits<{ close: [] }>()

const settings = useSettingsStore()
const saved = ref(false)

const draft = reactive({
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.8,
  maxTokens: 2048,
  reasoningEffort: 'medium',
  relayUrl: '',
  worldNote: '',
})

onMounted(async () => {
  await settings.load()
  const s = settings.settings
  const h = s.hallModel
  draft.enabled = !!h?.enabled
  draft.baseUrl = h?.baseUrl || ''
  draft.apiKey = h?.apiKey || ''
  draft.model = h?.model || ''
  draft.temperature = h?.temperature ?? 0.8
  draft.maxTokens = h?.maxTokens ?? 2048
  draft.reasoningEffort = h?.reasoningEffort || 'medium'
  draft.relayUrl = s.hallWsUrl || ''
  draft.worldNote = loadWorldNote()
})

const mainModelName = computed(() => settings.settings.modelSlots?.[settings.settings.activeSlot]?.model || '')
const kpWillUse = computed(() =>
  draft.enabled && draft.baseUrl.trim() && draft.apiKey.trim() && draft.model.trim()
    ? `跑团专用模型：${draft.model.trim()}`
    : mainModelName.value
      ? `主站模型：${mainModelName.value}`
      : '（还没有可用模型）',
)

const hallModelsCache = ref<string[]>([])
const fetching = ref(false)

async function fetchHallModels() {
  if (!draft.baseUrl.trim() || !draft.apiKey.trim()) return
  fetching.value = true
  try {
    const list = await fetchModels({ baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim() })
    hallModelsCache.value = list
  } catch { /* 获取失败静默，可手动输入模型名 */ }
  finally { fetching.value = false }
}

async function save() {
  await settings.patch({ hallWsUrl: draft.relayUrl.trim() })
  await settings.patch({
    hallModel: {
      enabled: draft.enabled,
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim(),
      temperature: draft.temperature,
      maxTokens: Number(draft.maxTokens) || 2048,
      reasoningEffort: draft.reasoningEffort,
    },
  })
  await saveWorldNote(draft.worldNote.trim())
  saved.value = true
  toast.success('模型设置已保存')
  setTimeout(() => saved.value = false, 1200)
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal-box" style="max-width: 560px">
      <div class="modal-head">
        <h3>模型设置</h3>
        <button class="modal-close" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <p style="font-size: 0.78rem; color: var(--text-2); margin: 0 0 12px; line-height: 1.7">
          KP 与 AI 备团使用的模型。<b>只对在线跑团生效</b>，主站对话不受影响；不配置时自动使用「更多 → 语言模型」的当前模型。
        </p>

        <div class="mode-cards">
          <button type="button" class="mode-card" :class="{ on: !draft.enabled }" @click="draft.enabled = false">
            <b>跟随主站（默认）</b>
            <span>使用「更多 → 语言模型」当前激活槽位</span>
          </button>
          <button type="button" class="mode-card" :class="{ on: draft.enabled }" @click="draft.enabled = true">
            <b>跑团专用</b>
            <span>为 KP 单独配一套 API，只在这些跑团房间生效</span>
          </button>
        </div>

        <template v-if="draft.enabled">
          <div class="field">
            <label>Base URL</label>
            <NInput v-model:value="draft.baseUrl" placeholder="https://api.example.com/v1（OpenAI 兼容端点）" round size="small" />
          </div>
          <div class="field">
            <label>API Key</label>
            <NInput
              v-model:value="draft.apiKey" type="password" show-password-on="click"
              placeholder="sk-..." round size="small"
            />
            <div class="hint">仅存于本机浏览器，不会上传</div>
          </div>
          <div class="field">
            <label>模型</label>
            <div style="display: flex; gap: 8px">
              <NSelect
                v-model:value="draft.model"
                placeholder="选择或输入模型名"
                :options="groupedModelOptions(hallModelsCache, 'text')"
                filterable tag size="small" style="flex: 1"
              />
              <NButton size="small" round :loading="fetching" :disabled="!draft.baseUrl.trim() || !draft.apiKey.trim()" @click="fetchHallModels">获取</NButton>
            </div>
          </div>

          <div class="param-row">
            <span class="param-label">温度</span>
            <NSlider v-model:value="draft.temperature" :min="0" :max="2" :step="0.05" style="flex: 1" />
            <span class="param-val">{{ draft.temperature.toFixed(2) }}</span>
          </div>
          <div class="param-row">
            <span class="param-label">最大 token</span>
            <NInputNumber v-model:value="draft.maxTokens" size="small" :min="64" :max="128000" style="flex: 1" />
          </div>
          <div class="param-row">
            <span class="param-label">推理强度</span>
            <NSelect
              v-model:value="draft.reasoningEffort"
              size="small" style="flex: 1"
              :options="[
                { label: 'minimal（最快，部分渠道自动按 low）', value: 'minimal' },
                { label: 'low', value: 'low' },
                { label: 'medium', value: 'medium' },
                { label: 'high', value: 'high' },
                { label: 'xhigh', value: 'xhigh' },
                { label: 'max（最深思考）', value: 'max' },
              ]"
            />
          </div>
        </template>

        <div class="kp-use-line">KP 将使用：<b>{{ kpWillUse }}</b></div>

        <details class="adv">
          <summary>高级（中继地址与世界观备注）</summary>
          <div class="field" style="margin-top: 10px">
            <label>我的中继（私人中继）</label>
            <NInput v-model:value="draft.relayUrl" :placeholder="`留空 = 共享大厅（${DEFAULT_HALL_RELAY}）`" round size="small" />
            <div class="hint">填了就用自己的中继：大厅列表、建「私人」房间都走这里；需要自行部署仓库内 server/。共享房间永远开在公共共享中继，与此处无关</div>
          </div>
          <div class="field">
            <label>世界观 / 团规备注（房主，随战役保存）</label>
            <textarea v-model="draft.worldNote" class="textarea" rows="3" style="width: 100%; resize: vertical" placeholder="跑团背景、规则约定、KP 风格要求…" />
          </div>
        </details>
      </div>

      <div class="modal-foot">
        <span v-if="saved" style="color: var(--ok); font-size: 12px">已保存</span>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mode-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
.mode-card {
  display: flex; flex-direction: column; gap: 4px; text-align: left;
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 12px;
  padding: 10px 12px; cursor: pointer; font: inherit; color: var(--text-1);
  transition: all 0.15s;
}
.mode-card span { font-size: 0.72rem; color: var(--text-2); line-height: 1.5; }
.mode-card.on { border-color: rgba(139, 92, 246, 0.55); background: rgba(139, 92, 246, 0.08); }
.mode-card.on b { color: var(--accent-soft); }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 13px; }
.field label { font-size: 0.8rem; color: var(--text-1); font-weight: 600; }
.hint { font-size: 0.72rem; color: var(--text-2); line-height: 1.5; }
.param-row { display: flex; gap: 14px; align-items: center; margin-bottom: 12px; }
.param-label { min-width: 76px; font-size: 0.78rem; color: var(--text-1); font-weight: 600; flex-shrink: 0; }
.param-val { min-width: 36px; text-align: right; font-size: 0.78rem; color: var(--accent); font-weight: 700; font-variant-numeric: tabular-nums; }
.kp-use-line {
  font-size: 0.76rem; color: var(--text-2);
  background: rgba(139, 92, 246, 0.07); border: 1px solid rgba(139, 92, 246, 0.18);
  border-radius: 10px; padding: 7px 10px; margin: 4px 0 12px;
}
.kp-use-line b { color: var(--accent-soft); }
.adv { border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; }
.adv summary { font-size: 0.78rem; color: var(--text-2); cursor: pointer; user-select: none; }
@media (max-width: 560px) { .mode-cards { grid-template-columns: 1fr; } }
</style>
