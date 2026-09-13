<script setup lang="ts">
/** API 配置 + 记忆/正则参数面板（Naive UI 组件版） */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { NSelect, NInput, NInputNumber, NSlider, NButton, NDivider } from 'naive-ui'
import { useSettingsStore } from '../stores/settings'
import { groupedModelOptions } from '../lib/api'

const settings = useSettingsStore()

const draft = reactive({
  apiBaseUrl: '',
  apiKey: '',
  slotModels: ['', '', ''],
  activeSlot: 0,
  temperature: 0.8,
  maxTokens: 2048,
  reasoningEffort: 'medium',
  contextMessages: 50,
  imageApiBaseUrl: '',
  imageApiKey: '',
  imageModel: '',
  videoApiBaseUrl: '',
  videoApiKey: '',
  videoModel: '',
})

onMounted(async () => {
  await settings.load()
  syncFromStore()
})

function syncFromStore() {
  const s = settings.settings
  draft.apiBaseUrl = s.apiBaseUrl
  draft.apiKey = s.apiKey
  draft.slotModels = s.modelSlots.map((m) => m.model)
  draft.activeSlot = s.activeSlot
  draft.temperature = s.temperature
  draft.maxTokens = s.maxTokens
  draft.reasoningEffort = s.reasoningEffort
  draft.contextMessages = s.contextMessages
  draft.imageApiBaseUrl = s.imageApiBaseUrl || ''
  draft.imageApiKey = s.imageApiKey || ''
  draft.imageModel = s.imageModel || ''
  draft.videoApiBaseUrl = s.videoApiBaseUrl || ''
  draft.videoApiKey = s.videoApiKey || ''
  draft.videoModel = s.videoModel || ''
}

let timer: ReturnType<typeof setTimeout> | null = null
watch(draft, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(commit, 350)
}, { deep: true })

function commit() {
  settings.patch({
    apiBaseUrl: draft.apiBaseUrl.trim(),
    apiKey: draft.apiKey.trim(),
    modelSlots: settings.settings.modelSlots.map((m, i) => ({ ...m, model: (draft.slotModels[i] || '').trim() })),
    activeSlot: draft.activeSlot,
    temperature: draft.temperature,
    maxTokens: Number(draft.maxTokens) || 2048,
    reasoningEffort: draft.reasoningEffort,
    contextMessages: Number(draft.contextMessages) || 50,
    imageApiBaseUrl: draft.imageApiBaseUrl.trim(),
    imageApiKey: draft.imageApiKey.trim(),
    imageModel: draft.imageModel.trim(),
    videoApiBaseUrl: draft.videoApiBaseUrl.trim(),
    videoApiKey: draft.videoApiKey.trim(),
    videoModel: draft.videoModel.trim(),
  })
}

const testMsg = ref('')
const testing = ref(false)

async function refreshModels() {
  testMsg.value = ''
  testing.value = true
  commit()
  await new Promise((r) => setTimeout(r, 420))
  try {
    const list = await settings.refreshModels()
    testMsg.value = list.length ? `已获取 ${list.length} 个模型` : '未获取到模型'
  } catch (err) {
    testMsg.value = '获取失败'
  } finally {
    testing.value = false
  }
}

const SLOT_LABELS = ['主对话', '备用 A', '备用 B']

const imgMsg = ref('')
const vidMsg = ref('')

async function refreshImageModels() {
  imgMsg.value = ''
  commit()
  await new Promise((r) => setTimeout(r, 420))
  try {
    const list = await settings.refreshImageModels()
    imgMsg.value = list.length ? `已获取 ${list.length} 个模型` : '未获取到模型'
  } catch {
    imgMsg.value = '获取失败'
  }
}

async function refreshVideoModels() {
  vidMsg.value = ''
  commit()
  await new Promise((r) => setTimeout(r, 420))
  try {
    const list = await settings.refreshVideoModels()
    vidMsg.value = list.length ? `已获取 ${list.length} 个模型` : '未获取到模型'
  } catch {
    vidMsg.value = '获取失败'
  }
}
</script>

<template>
  <div>
    <n-divider id="sec-api" title-placement="left"><span style="font-size: 0.85rem; font-weight: 700">语言模型</span></n-divider>

    <div class="field">
      <label>Base URL</label>
      <NInput v-model:value="draft.apiBaseUrl" placeholder="https://api.example.com/v1（OpenAI 兼容端点）" round />
    </div>

    <div class="field">
      <label>API Key</label>
      <NInput v-model:value="draft.apiKey" type="password" show-password-on="click" placeholder="sk-..." round />
      <div class="hint">仅存于本机浏览器，不会上传</div>
    </div>

    <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 20px">
      <NButton size="small" :loading="testing || settings.fetchingModels" @click="refreshModels" round>
        {{ settings.modelsCache.length ? `刷新模型列表（${settings.modelsCache.length}）` : '获取模型列表' }}
      </NButton>
      <span v-if="testMsg" style="font-size: 0.76rem; color: var(--text-2)">{{ testMsg }}</span>
      <span v-else-if="settings.fetchingModels" style="font-size: 0.76rem; color: var(--text-2)">正在从 API Key 获取模型…</span>
      <span v-else-if="settings.modelsCache.length" style="font-size: 0.76rem; color: var(--text-2)">已自动获取 {{ settings.modelsCache.length }} 个模型，可直接选择或手动输入</span>
    </div>

    <!-- 模型选择 -->
    <n-divider id="sec-slots" title-placement="left"><span style="font-size: 0.85rem; font-weight: 700">模型槽位</span></n-divider>

    <div class="slot-row" v-for="(label, i) in SLOT_LABELS" :key="i">
      <div class="slot-radio" :class="{ active: draft.activeSlot === i }" @click="() => { draft.activeSlot = i; commit() }">
        {{ label }}
      </div>
      <NSelect
        v-model:value="draft.slotModels[i]"
        placeholder="选择模型"
        :options="groupedModelOptions(settings.modelsCache, 'text')"
        filterable
        tag
        size="small"
        @update:value="commit()"
      />
    </div>
    <div class="hint" style="margin-bottom: 20px">高亮槽位为当前对话使用的模型</div>

    <!-- 图片模型 -->
    <n-divider id="sec-image" title-placement="left"><span style="font-size: 0.85rem; font-weight: 700">图片生成模型</span></n-divider>
    <div class="field">
      <label>Base URL</label>
      <NInput v-model:value="draft.imageApiBaseUrl" placeholder="留空则复用对话 API 地址" round />
    </div>
    <div class="field">
      <label>API Key</label>
      <NInput v-model:value="draft.imageApiKey" type="password" show-password-on="click" placeholder="留空则复用对话 API Key" round />
    </div>
    <div class="field">
      <label>图片模型</label>
      <div style="display: flex; gap: 8px">
        <NSelect
          v-model:value="draft.imageModel"
          placeholder="选择或输入图片模型"
          :options="groupedModelOptions(settings.imageModelsCache, 'image')"
          filterable tag size="small" style="flex: 1" @update:value="commit()"
        />
        <NButton size="small" @click="refreshImageModels" round>获取</NButton>
      </div>
      <div class="hint">{{ imgMsg || '配置独立的图片生成接口，用于后续对话内配图、头像生成等功能' }}</div>
    </div>

    <!-- 视频模型 -->
    <n-divider id="sec-video" title-placement="left"><span style="font-size: 0.85rem; font-weight: 700">视频生成模型</span></n-divider>
    <div class="field">
      <label>Base URL</label>
      <NInput v-model:value="draft.videoApiBaseUrl" placeholder="留空则复用对话 API 地址" round />
    </div>
    <div class="field">
      <label>API Key</label>
      <NInput v-model:value="draft.videoApiKey" type="password" show-password-on="click" placeholder="留空则复用对话 API Key" round />
    </div>
    <div class="field">
      <label>视频模型</label>
      <div style="display: flex; gap: 8px">
        <NSelect
          v-model:value="draft.videoModel"
          placeholder="选择或输入视频模型"
          :options="groupedModelOptions(settings.videoModelsCache, 'video')"
          filterable tag size="small" style="flex: 1" @update:value="commit()"
        />
        <NButton size="small" @click="refreshVideoModels" round>获取</NButton>
      </div>
      <div class="hint">{{ vidMsg || '配置独立的视频生成接口，用于后续文生视频/图生视频功能' }}</div>
    </div>

    <!-- 生成参数 -->
    <n-divider id="sec-params" title-placement="left"><span style="font-size: 0.85rem; font-weight: 700">生成参数</span></n-divider>

    <div class="param-row">
      <span class="param-label">温度</span>
      <NSlider v-model:value="draft.temperature" :min="0" :max="2" :step="0.05" style="flex: 1" @update:value="commit()" />
      <span class="param-val">{{ draft.temperature.toFixed(2) }}</span>
    </div>

    <div class="param-row">
      <span class="param-label">最大 token</span>
      <NInputNumber v-model:value="draft.maxTokens" size="small" :min="64" :max="128000" style="flex: 1" @update:value="commit()" />
    </div>
    <div class="hint" style="margin: -4px 0 12px 102px">思考类模型（Gemini 2.5 Pro 等）的「思考 token」也占用此上限，过小会截断正文和面板变量更新，建议 ≥4096。</div>

    <div class="param-row">
      <span class="param-label">上下文条数</span>
      <NInputNumber v-model:value="draft.contextMessages" size="small" :min="2" :max="200" style="flex: 1" @update:value="commit()" />
    </div>

    <div class="param-row">
      <span class="param-label">推理强度</span>
      <NSelect
        v-model:value="draft.reasoningEffort"
        size="small"
        style="flex: 1"
        :options="[
          { label: 'minimal（最快，部分渠道自动按 low）', value: 'minimal' },
          { label: 'low', value: 'low' },
          { label: 'medium', value: 'medium' },
          { label: 'high', value: 'high' },
          { label: 'xhigh', value: 'xhigh' },
          { label: 'max（最深思考）', value: 'max' },
        ]"
        @update:value="commit()"
      />
    </div>

    <n-divider />

    <!-- 聊天背景 -->
    <n-divider id="sec-cover" title-placement="left"><span style="font-size: 0.85rem; font-weight: 700">聊天背景</span></n-divider>

    <div class="param-row">
      <span class="param-label">封面浓度</span>
      <NSlider
        :value="settings.settings.chatCoverOpacity ?? 30"
        :min="0" :max="100" :step="1"
        :format-tooltip="(v: number) => v + '%'"
        style="flex: 1"
        @update:value="(v: number) => settings.patch({ chatCoverOpacity: Math.round(v) })"
      />
      <span class="param-val">{{ settings.settings.chatCoverOpacity ?? 30 }}%</span>
    </div>
    <div class="param-row">
      <span class="param-label">背景模糊</span>
      <NSlider
        :value="settings.settings.chatCoverBlur ?? 6"
        :min="0" :max="40" :step="1"
        :format-tooltip="(v: number) => v + 'px'"
        style="flex: 1"
        @update:value="(v: number) => settings.patch({ chatCoverBlur: Math.round(v) })"
      />
      <span class="param-val">{{ settings.settings.chatCoverBlur ?? 6 }}px</span>
    </div>
    <div class="hint" style="margin-bottom: 16px">聊天区以当前角色卡的封面作为氛围背景，拖动立即生效；浓度 0 = 关闭背景。</div>
  </div>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.field label { font-size: 0.82rem; color: var(--text-1); font-weight: 600; }
.hint { font-size: 0.73rem; color: var(--text-2); line-height: 1.5; }

.slot-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
}
.slot-radio {
  min-width: 72px;
  text-align: center;
  padding: 7px 10px;
  border-radius: 9px;
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-2);
  background: var(--bg-2);
  border: 1px solid var(--line);
  transition: all 0.15s;
  user-select: none;
}
.slot-radio.active {
  color: #fff;
  background: var(--accent-grad);
  border-color: transparent;
  box-shadow: 0 3px 12px rgba(139, 92, 246, 0.3);
}
.param-row {
  display: flex;
  gap: 14px;
  align-items: center;
  margin-bottom: 12px;
}
.param-label {
  min-width: 88px;
  font-size: 0.8rem;
  color: var(--text-1);
  font-weight: 600;
  flex-shrink: 0;
}
.param-val {
  min-width: 36px;
  text-align: right;
  font-size: 0.8rem;
  color: var(--accent);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.toggle-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 7px 0;
  font-size: 0.84rem;
  color: var(--text-1);
}
</style>
