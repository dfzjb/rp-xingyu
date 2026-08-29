<script setup lang="ts">
import { ref } from 'vue'
import { hall, leaveRoom } from '../lib/hall/useHall'
import '../hall.css'
import HallJoinCard from '../components/hall/HallJoinCard.vue'
import HallStoryStream from '../components/hall/HallStoryStream.vue'
import HallComposer from '../components/hall/HallComposer.vue'
import HallMembersPanel from '../components/hall/HallMembersPanel.vue'
import HallDiceBar from '../components/hall/HallDiceBar.vue'
import HallSettingsModal from '../components/hall/HallSettingsModal.vue'

const showSettings = ref(false)

function copyRoomCode() {
  if (hall.state.roomCode) void navigator.clipboard?.writeText(hall.state.roomCode.toUpperCase())
}
</script>

<template>
  <div class="hall-root">
    <!-- 未进房 / 出错 -->
    <HallJoinCard v-if="hall.state.phase === 'idle' || hall.state.phase === 'error'" />

    <!-- 连接中 -->
    <div v-else-if="hall.state.phase === 'connecting'" class="hall-center-hint">
      <div class="hall-spinner" />
      <p style="color: var(--text-2)">正在进入房间…</p>
    </div>

    <!-- 连接断开 / 房间关闭 -->
    <div v-else-if="hall.state.phase === 'closed'" class="hall-center-hint">
      <h2 style="margin: 0">房间已结束</h2>
      <p style="color: var(--text-2); margin: 0">{{ hall.state.error }}</p>
      <button class="btn primary" @click="leaveRoom()">返回大厅</button>
    </div>

    <!-- 房间内 -->
    <template v-else>
      <header class="hall-topbar">
        <div class="hall-brand">星屿 · 跑团</div>
        <div class="hall-room-chip" title="点击复制房间码" @click="copyRoomCode">
          房间 <b>{{ hall.state.roomCode.toUpperCase() }}</b>
          <span class="hall-dot" />
        </div>
        <div class="hall-topbar-right">
          <span style="color: var(--text-2); font-size: 0.85rem">{{ hall.memberList.value.length }} 人在线</span>
          <span v-if="hall.state.isHost" class="hall-tag">房主</span>
          <button class="btn ghost sm" @click="showSettings = true">设置</button>
        </div>
      </header>

      <div v-if="hall.state.error" class="hall-err-banner">{{ hall.state.error }}</div>

      <main class="hall-layout">
        <section class="hall-stream-col">
          <HallStoryStream :events="hall.state.events" :streaming="hall.state.streaming" />
          <HallComposer />
        </section>
        <aside class="hall-side-col">
          <HallMembersPanel />
          <HallDiceBar />
        </aside>
      </main>
    </template>

    <HallSettingsModal v-if="showSettings" @close="showSettings = false" />
  </div>
</template>
