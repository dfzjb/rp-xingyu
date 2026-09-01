<script setup lang="ts">
import { computed } from 'vue'
import { hall } from '../../lib/hall/useHall'
import { PARTY_LINE, type MemberInfo } from '../../lib/hall/protocol'
import { lineOf } from '../../lib/hall/kp'

/** 谁最近在干什么：每个角色最后一次发言所在线（「谁干了什么」速查） */
const lastLineByChar = computed(() => {
  const map = new Map<string, string>()
  for (const e of hall.state.events) {
    if (e.k !== 'chat') continue
    const char = e.charName || e.name
    if (char) map.set(char, lineOf(e))
  }
  return map
})

function lineLabel(m: MemberInfo): string {
  const id = lastLineByChar.value.get(m.charName || m.name)
  if (!id || id === PARTY_LINE) return ''
  const name = hall.state.scenes.find((s) => s.id === id)?.name
  return name ? ` · 在「${name}」` : ''
}
</script>

<template>
  <div class="hall-panel">
    <div class="hall-panel-title">成员（{{ hall.memberList.value.length }}）</div>
    <div v-for="m in hall.memberList.value" :key="m.peerId" class="hall-member">
      <div class="hall-avatar hall-avatar-sm">{{ (m.charName || m.name).slice(0, 1) }}</div>
      <div style="min-width: 0">
        <div class="hall-member-name">
          {{ m.charName || m.name }}
          <span v-if="m.role === 'host'" class="hall-tag" title="房主（KP 台）">KP台</span>
        </div>
        <div class="hall-sys-line" style="text-align: left">
          {{ m.persona || '（还没填人设）' }}
          <template v-if="m.charName"> · 玩家 {{ m.name }}</template><span v-if="lineLabel(m)">{{ lineLabel(m) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
