<script setup lang="ts">
import { computed, ref } from 'vue'
import { Minus, Plus, RotateCcw, Trophy, X } from 'lucide-vue-next'
import { hall, resetProgress, setProgressChapter, setProgressDay, setProgressRoute, toggleProgressFlag } from '../../lib/hall/useHall'
import { endingKindLabel } from '../../lib/hall/module'

/** 剧情进度面板：当前章节/时间线/路线/旗标/结局图鉴（挂在战局状态上，全员实时同步；房主可手动微调） */
const isHost = computed(() => hall.state.isHost)
const mod = computed(() => hall.state.module)
const progress = computed(() => hall.state.gameState?.progress)

const chapterTitle = computed(() => mod.value?.chapters.find((c) => c.id === progress.value?.chapterId)?.title || '')
const routeName = computed(() => mod.value?.routes.find((r) => r.id === progress.value?.routeId)?.name || '')
const endingHit = computed(() => mod.value?.endings.find((e) => e.id === progress.value?.endingId) || null)
const day = computed(() => progress.value?.day ?? 0)

const flagText = ref('')
async function addFlag() {
  const t = flagText.value.trim()
  if (!t) return
  await toggleProgressFlag(t)
  flagText.value = ''
}

async function stepDay(delta: number) {
  await setProgressDay(day.value + delta)
}
</script>

<template>
  <div class="hall-panel">
    <div class="hall-panel-title">剧情 · {{ mod?.name || '模组进度' }}</div>

    <!-- 终局横幅：KP 触发结局后亮出，房主可开新周目 -->
    <div v-if="progress?.ended && endingHit" class="hall-progress-final">
      <b><Trophy :size="12" style="vertical-align: -1px" /> 达成结局「{{ endingHit.name }}」</b>
      <span class="hall-sys-line" style="display: block; text-align: left">{{ endingKindLabel(endingHit.kind) }} · {{ endingHit.epilogue || endingHit.condition }}</span>
      <button v-if="isHost" class="btn sm ghost" style="margin-top: 6px" title="清空章节/天数/路线/旗标，模组与剧情流保留" @click="resetProgress()"><RotateCcw :size="12" />开新周目</button>
    </div>

    <div class="hall-progress-rows">
      <div class="hall-progress-row">
        <span class="hall-progress-label">章节</span>
        <span v-if="chapterTitle" class="hall-progress-value"><b>{{ chapterTitle }}</b></span>
        <span v-else class="hall-progress-value hall-area-none">尚未开局</span>
        <select v-if="isHost && mod?.chapters.length" class="input" style="flex: none; width: 34px; padding: 2px 4px; font-size: 11px" title="手动指定当前章节"
          :value="progress?.chapterId || ''" @change="setProgressChapter(($event.target as HTMLSelectElement).value)">
          <option value="" disabled>选</option>
          <option v-for="c in mod!.chapters" :key="c.id" :value="c.id">{{ c.title.slice(0, 8) }}</option>
        </select>
      </div>
      <div class="hall-progress-row">
        <span class="hall-progress-label">时间线</span>
        <span class="hall-progress-value hall-progress-day">
          第 <b>{{ day }}</b> 天
          <template v-if="isHost">
            <button class="hall-progress-step" title="回退一天" @click="stepDay(-1)"><Minus :size="11" /></button>
            <button class="hall-progress-step" title="推进一天" @click="stepDay(1)"><Plus :size="11" /></button>
          </template>
        </span>
      </div>
      <div class="hall-progress-row">
        <span class="hall-progress-label">路线</span>
        <span v-if="routeName" class="hall-progress-value"><b>{{ routeName }}</b></span>
        <span v-else class="hall-progress-value hall-area-none">主线</span>
        <select v-if="isHost && mod?.routes.length" class="input" style="flex: none; width: 34px; padding: 2px 4px; font-size: 11px" title="手动切换路线"
          :value="progress?.routeId || ''" @change="setProgressRoute(($event.target as HTMLSelectElement).value)">
          <option value="">主</option>
          <option v-for="r in mod!.routes" :key="r.id" :value="r.id">{{ r.name.slice(0, 6) }}</option>
        </select>
      </div>
    </div>

    <div class="hall-progress-label" style="margin-bottom: 5px">关键旗标</div>
    <div class="hall-progress-flags" style="margin-bottom: 10px">
      <span v-for="f in progress?.flags || []" :key="f" class="hall-progress-flag">
        {{ f }}
        <button v-if="isHost" title="删除旗标" @click="toggleProgressFlag(f)"><X :size="10" /></button>
      </span>
      <span v-if="!progress?.flags.length" class="hall-sys-line" style="text-align: left">还没有——KP 推进剧情时会自动记下</span>
    </div>
    <div v-if="isHost" class="hall-row" style="margin-bottom: 10px">
      <input v-model="flagText" class="input" placeholder="手动记一个旗标，如「黑闪」" maxlength="40" @keyup.enter="addFlag" />
      <button class="btn sm" @click="addFlag"><Plus :size="13" /></button>
    </div>

    <div class="hall-progress-label" style="margin-bottom: 5px">结局图鉴</div>
    <div class="hall-progress-endings">
      <div v-for="e in mod?.endings || []" :key="e.id" class="hall-progress-ending" :class="{ hit: e.id === progress?.endingId }" :title="e.condition">
        <span class="hall-ending-badge">{{ endingKindLabel(e.kind) }}</span>
        <span>{{ e.name }}</span>
        <span v-if="e.id === progress?.endingId">← 已达成</span>
      </div>
      <span v-if="!mod?.endings.length" class="hall-sys-line" style="text-align: left">模组没有预设结局</span>
    </div>
    <p v-if="!isHost" class="hall-sys-line" style="margin: 8px 0 0">进度由 KP 台推进，这里实时同步</p>
  </div>
</template>
