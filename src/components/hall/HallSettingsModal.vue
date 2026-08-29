<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { loadWorldNote, relayUrlOf, saveWorldNote } from '../../lib/hall/useHall'
import { useSettingsStore } from '../../stores/settings'
import { toast } from '../../lib/toast'

const emit = defineEmits<{ close: [] }>()

const settings = useSettingsStore()
const relayUrl = ref(settings.settings.hallWsUrl || '')
const worldNote = ref(loadWorldNote())
const saved = ref(false)

onMounted(() => {
  if (!relayUrl.value) relayUrl.value = relayUrlOf('')
})

async function save() {
  const u = relayUrl.value.trim()
  if (u === relayUrlOf('')) await settings.patch({ hallWsUrl: '' })
  else await settings.patch({ hallWsUrl: u })
  await saveWorldNote(worldNote.value.trim())
  saved.value = true
  toast.success('跑团设置已保存')
  setTimeout(() => saved.value = false, 1200)
}
</script>

<template>
  <div class="hall-modal-mask" @click.self="emit('close')">
    <div class="hall-modal">
      <div class="hall-modal-head">
        <h3>跑团设置</h3>
        <button class="btn ghost sm" @click="emit('close')">关闭</button>
      </div>

      <div class="section-title" style="margin-top: 14px">KP 模型</div>
      <p class="hall-sys-line" style="text-align: left; margin: 0">
        KP 直接使用「更多 → 语言模型」里当前激活的模型与参数，无需在这里重复配置。
      </p>

      <div class="section-title">中继地址</div>
      <label class="hall-field">
        <span>WebSocket 地址（留空 = 默认同源 /ws，需要自行部署仓库内 server/）</span>
        <input v-model="relayUrl" class="input mono" placeholder="wss://your.server/ws" />
      </label>

      <div class="section-title">世界观 / 团规备注（房主，随战役保存）</div>
      <textarea v-model="worldNote" class="input" rows="3" style="width: 100%; resize: vertical" placeholder="跑团背景、规则约定、KP 风格要求…" />

      <div class="hall-modal-foot">
        <span v-if="saved" style="color: var(--ok); font-size: 12px">已保存</span>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>
