<script setup lang="ts">
import { computed, ref } from 'vue'
import { hall, sendWheel } from '../../lib/hall/useHall'

/** 命运转盘面板：模组随机表加权抽取。转动动画只在本机，结果以 wheel 事件明牌广播（进剧情流，KP 会读到） */
const tables = computed(() => hall.state.module?.tables ?? [])
const activeId = ref('')
const active = computed(() => tables.value.find((t) => t.id === activeId.value) || tables.value[0] || null)

const usageLabel = (u: string) => (u === 'create' ? '出身' : u === 'action' ? '行动' : '')

const spinning = ref(false)
const rotation = ref(0)
const err = ref('')

/** 转盘盘面：按条目权重画扇区（紫色系深浅交替；全 0 权重均分） */
const discStyle = computed(() => {
  const t = active.value
  if (!t || !t.entries.length) return ''
  const weights = t.entries.map((e) => (Math.max(0, e.weight) > 0 ? Math.max(0, e.weight) : 1))
  const total = weights.reduce((a, b) => a + b, 0)
  const stops: string[] = []
  let acc = 0
  for (let i = 0; i < t.entries.length; i++) {
    const start = (acc / total) * 360
    acc += weights[i]
    const end = (acc / total) * 360
    stops.push(`hsl(262 60% ${28 + (i % 4) * 10}%) ${start}deg ${end}deg`)
  }
  return `conic-gradient(${stops.join(', ')})`
})

/** 最近一次转盘结果（全员可见的同一个事件） */
const lastResult = computed(() => [...hall.state.events].reverse().find((e) => e.k === 'wheel') || null)

async function spin() {
  if (spinning.value || !active.value) return
  spinning.value = true
  err.value = ''
  rotation.value += 4 * 360 + Math.floor(Math.random() * 360)
  // 转动动画纯属本机气氛：真正的抽取在 sendWheel 里完成，结果对全员一致
  setTimeout(async () => {
    err.value = (await sendWheel(active.value!.id, hall.state.currentScene)) ?? ''
    spinning.value = false
  }, 1400)
}
</script>

<template>
  <div class="hall-panel">
    <div class="hall-panel-title">命运转盘 · 结果所有人可见</div>

    <div v-if="tables.length > 1" class="hall-wheel-tabs">
      <button
        v-for="t in tables" :key="t.id" class="hall-wheel-tab" :class="{ active: active?.id === t.id }"
        :title="t.entries.map((e) => e.label).join(' / ')"
        @click="activeId = t.id"
      >
        <b>{{ t.name }}</b>
        <span v-if="usageLabel(t.usage)">{{ usageLabel(t.usage) }}</span>
      </button>
    </div>

    <div class="hall-wheel-stage">
      <div class="hall-wheel-poser">
        <div class="hall-wheel-disc" :class="{ spinning }" :style="{ background: discStyle, transform: `rotate(${rotation}deg)` }" />
        <div class="hall-wheel-pointer" />
      </div>
      <div class="hall-wheel-side">
        <button class="btn primary hall-wheel-go" :disabled="spinning" @click="spin">{{ spinning ? '转动中…' : '转' }}</button>
        <p class="hall-wheel-hint">
          「{{ active?.name || '转盘' }}」共 {{ active?.entries.length || 0 }} 格，权重说了算。抽中的结果会明牌进入剧情流——出身的加成、行动的遭遇，KP 都会写进剧情。
        </p>
      </div>
    </div>

    <div v-if="lastResult" class="hall-wheel-result">
      <b>{{ lastResult.charName || lastResult.name }}</b> 转动「{{ lastResult.tableName }}」→
      <b>{{ lastResult.label }}</b>
      <span v-if="lastResult.note" class="hall-sys-line" style="display: inline">{{ lastResult.note }}</span>
    </div>
    <p v-if="err" style="color: var(--danger); font-size: 12px">{{ err }}</p>
  </div>
</template>
