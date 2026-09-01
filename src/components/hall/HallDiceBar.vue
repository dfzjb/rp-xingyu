<script setup lang="ts">
import { computed, ref } from 'vue'
import { sendRoll, hall } from '../../lib/hall/useHall'
import { rulePreset } from '../../lib/hall/rules'
import { parseDice } from '../../lib/hall/dice'

const expr = ref('')
const err = ref('')

const FALLBACK = ['1d20', '1d100', '2d6', '3d6', '1d4+1']

/** 快捷骰跟随房间规则系统（详细模式设定）；无设定用通用列表 */
const QUICK_EXPRS = computed(() => {
  const s = hall.state.setting
  if (!s || s.system === 'custom') return FALLBACK
  return rulePreset(s.system).quickDice
})

/** 给骰子表达式算一句人话：「1d100」→「结果 1~100」，「2d6+1d4-1」→「结果 2~15」 */
function describe(exprStr: string): string {
  try {
    const { groups, mod } = parseDice(exprStr)
    let min = mod
    let max = mod
    for (const g of groups) {
      if (g.sign > 0) { min += g.n; max += g.n * g.m }
      else { min -= g.n * g.m; max -= g.n }
    }
    return `结果 ${min}~${max}`
  } catch {
    return ''
  }
}

const QUICK = computed(() => QUICK_EXPRS.value.map((e) => ({ expr: e, desc: describe(e) })))

async function roll(e?: string) {
  const target = (e ?? expr.value).trim()
  if (!target) return
  // 掷骰落在当前查看的线上（检定记录跟着剧情走）
  err.value = (await sendRoll(target, hall.state.currentScene)) ?? ''
  if (!err.value && e) expr.value = ''
}
</script>

<template>
  <div class="hall-panel">
    <div class="hall-panel-title">骰子 · 掷出的结果所有人都能看到</div>
    <div class="hall-dice-chips">
      <button v-for="q in QUICK" :key="q.expr" class="hall-chip hall-dice-quick" :title="`点一下就掷 ${q.expr}`" @click="roll(q.expr)">
        <b>{{ q.expr }}</b>
        <span>{{ q.desc }}</span>
      </button>
    </div>
    <p class="hall-dice-hint">
      掷骰 = 让系统帮你出一个<b>随机数</b>，谁都改不了具体点数。上面按钮点了就掷；想掷别的骰子，在下面写下「几个几面骰」，如 <b>2d6</b> 就是掷两个六面骰、<b>1d20+3</b> 就是二十面骰再加 3。
    </p>
    <div class="hall-row">
      <input v-model="expr" class="input mono" placeholder="想掷的骰子，如 2d6、1d20+3" @keyup.enter="roll()" />
      <button class="btn sm" @click="roll()">掷</button>
    </div>
    <p v-if="err" style="color: var(--danger); font-size: 12px">{{ err }}</p>
  </div>
</template>
