<script setup lang="ts">
// 团设查看弹窗：展示本房间的开团设定（房主来自战役，成员来自 E2EE 快照同步）。全员只读。
import { computed } from 'vue'
import { hall } from '../../lib/hall/useHall'
import { KP_STYLES, rulePreset } from '../../lib/hall/rules'

const emit = defineEmits<{ close: [] }>()

const setting = computed(() => hall.state.setting)
const ruleName = computed(() => {
  const s = setting.value
  if (!s) return ''
  if (s.system === 'custom') return s.systemCustom.trim() || '自定义规则'
  return rulePreset(s.system).name
})
const styleName = computed(() => KP_STYLES.find((k) => k.id === setting.value?.kpStyle)?.name || '')
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal-box" style="max-width: 560px">
      <div class="modal-head">
        <h3>开团设定</h3>
        <button class="modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body" v-if="setting">
        <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px">
          <span class="chip violet">{{ ruleName }}</span>
          <span v-if="setting.era" class="chip">{{ setting.era }}</span>
          <span v-if="setting.players" class="chip">{{ setting.players }} 人</span>
          <span v-for="t in setting.tones" :key="t" class="chip on">{{ t }}</span>
          <span class="chip">{{ styleName }}</span>
        </div>

        <template v-for="sec in [
          { label: '世界观与舞台', text: setting.world },
          { label: '模组 / 剧情梗概', text: setting.module },
          { label: '开场场景', text: setting.opening },
          { label: '开场白', text: setting.openingNarration },
          { label: '关键 NPC', text: setting.npcs },
          { label: '房规', text: setting.houseRules },
          { label: '内容红线', text: setting.redlines },
          { label: '场景 / 地图备注', text: setting.sceneNotes },
        ]" :key="sec.label">
          <div v-if="sec.text.trim()" class="brief-sec">
            <div class="brief-label">{{ sec.label }}</div>
            <div class="brief-text">{{ sec.text }}</div>
          </div>
        </template>
      </div>
      <div class="modal-body" v-else>
        <p style="font-size: 0.82rem; color: var(--text-2)">本房间没有开团设定（房主以简洁模式创建）。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.brief-sec { margin-bottom: 12px; }
.brief-label {
  font-size: 0.72rem;
  font-weight: 800;
  color: var(--accent);
  margin-bottom: 4px;
  padding-left: 8px;
  border-left: 3px solid var(--accent);
}
.brief-text {
  font-size: 0.82rem;
  color: var(--text-1);
  line-height: 1.75;
  white-space: pre-wrap;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 8px 12px;
}
</style>
