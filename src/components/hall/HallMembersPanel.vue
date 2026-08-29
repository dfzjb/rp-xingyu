<script setup lang="ts">
import { hall } from '../../lib/hall/useHall'
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
          <template v-if="m.charName"> · 玩家 {{ m.name }}</template>
        </div>
      </div>
    </div>
  </div>
</template>
