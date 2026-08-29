<script setup lang="ts">
import { ref } from 'vue'
import { generateKp, hall, sendChat, sendNarration, stopKp } from '../../lib/hall/useHall'

const text = ref('')
const narrationMode = ref(false)

async function submit() {
  const t = text.value.trim()
  if (!t) return
  text.value = ''
  if (narrationMode.value && hall.state.isHost) {
    await sendNarration(t)
    return
  }
  await sendChat(t)
}

function onKpClick() {
  if (hall.state.kpBusy) stopKp()
  else void generateKp()
}
</script>

<template>
  <div class="hall-composer">
    <div v-if="hall.state.isHost" class="hall-composer-tools">
      <label class="hall-check">
        <input v-model="narrationMode" type="checkbox" />
        旁白模式（以叙事者身份发送）
      </label>
      <button class="btn ghost sm" @click="onKpClick">
        {{ hall.state.kpBusy ? '停止生成' : '让 KP 出手' }}
      </button>
    </div>
    <div class="hall-composer-row">
      <textarea
        v-model="text"
        rows="1"
        :placeholder="narrationMode && hall.state.isHost ? '写入旁白…' : '以角色身份行动或说话…'"
        @keydown.enter.exact.prevent="submit"
      />
      <button class="btn primary" :disabled="!text.trim()" @click="submit">发送</button>
    </div>
  </div>
</template>
