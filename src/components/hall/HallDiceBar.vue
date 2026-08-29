<script setup lang="ts">
import { ref } from 'vue'
import { sendRoll } from '../../lib/hall/useHall'

const expr = ref('')
const err = ref('')

const QUICK = ['1d20', '1d100', '2d6', '3d6', '1d4+1']

async function roll(e?: string) {
  const target = (e ?? expr.value).trim()
  if (!target) return
  err.value = (await sendRoll(target)) ?? ''
  if (!err.value && e) expr.value = ''
}
</script>

<template>
  <div class="hall-panel">
    <div class="hall-panel-title">骰子（明骰，全员可见）</div>
    <div class="hall-dice-chips">
      <button v-for="q in QUICK" :key="q" class="hall-chip" @click="roll(q)">{{ q }}</button>
    </div>
    <div class="hall-row">
      <input v-model="expr" class="input mono" placeholder="自定义：2d6+1d4-1" @keyup.enter="roll()" />
      <button class="btn sm" @click="roll()">掷</button>
    </div>
    <p v-if="err" style="color: var(--danger); font-size: 12px">{{ err }}</p>
  </div>
</template>
