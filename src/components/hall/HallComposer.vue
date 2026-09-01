<script setup lang="ts">
import { computed, ref } from 'vue'
import { generateKp, hall, isLineNarrator, sendChat, sendNarration, stopKp } from '../../lib/hall/useHall'
import { PARTY_LINE, sceneNameOf } from '../../lib/hall/protocol'

const text = ref('')
const narrationMode = ref(false)

/** 当前所在线：全体线不标注；自定义线在占位符里标明发言落点 */
const lineName = computed(() =>
  hall.state.currentScene === PARTY_LINE ? '' : sceneNameOf(hall.state.scenes, hall.state.currentScene),
)
/** 工具行（旁白模式/让 KP 出手）：房主，或当前线由我叙述时可见 */
const canNarrate = computed(() => hall.state.isHost || isLineNarrator())

async function submit() {
  const t = text.value.trim()
  if (!t) return
  text.value = ''
  if (narrationMode.value && canNarrate.value) {
    await sendNarration(t, hall.state.currentScene)
    return
  }
  await sendChat(t, hall.state.currentScene)
}

function onKpClick() {
  if (hall.state.kpBusy) stopKp()
  else void generateKp() // 默认给当前查看的线开口（由这条线的叙述者本机执行）
}
</script>

<template>
  <div class="hall-composer">
    <div v-if="canNarrate" class="hall-composer-tools">
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
        :placeholder="narrationMode && hall.state.isHost
          ? lineName ? `【${lineName}】写入旁白…` : '写入旁白…'
          : lineName ? `【${lineName}】以角色身份行动或说话…` : '以角色身份行动或说话…'"
        @keydown.enter.exact.prevent="submit"
      />
      <button class="btn primary" :disabled="!text.trim()" @click="submit">发送</button>
    </div>
  </div>
</template>
