<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { connect, hall, leaveRoom, refreshCampaigns, type Profile } from '../../lib/hall/useHall'
import { genRoomCode } from '../../lib/hall/crypto'

const mode = ref<'create' | 'join'>('create')
const code = ref('')
const submitting = ref(false)
const profile = reactive<Profile>({ ...hall.profile })
const campaigns = ref<{ id: string; name: string; roomCode: string }[]>([])

onMounted(async () => {
  await refreshCampaigns()
  campaigns.value = hall.campaigns.map((c) => ({ id: c.id, name: c.name, roomCode: c.roomCode }))
})

async function start(optsMode: 'create' | 'join', resumeCode?: string, campaignId?: string) {
  if (submitting.value) return
  submitting.value = true
  await connect({ mode: optsMode, code: resumeCode ?? code.value, profile: { ...profile }, campaignId })
  submitting.value = false
  if (hall.state.phase === 'error') leaveRoom()
}

function resume(id: string, roomCode: string) {
  void start('create', roomCode, id)
}

const suggest = ref(genRoomCode())
</script>

<template>
  <div class="hall-join-wrap">
    <div class="hall-join-card">
      <h1 class="gradient-text" style="font-size: 1.4rem; margin: 0 0 4px">星屿 · 跑团</h1>
      <p class="hall-sys-line" style="text-align: left; margin: 0 0 8px">
        多人在线跑团 · 剧情只存房主浏览器 · 中继全程密文转发
      </p>

      <div class="hall-mode-tabs">
        <button :class="{ active: mode === 'create' }" @click="mode = 'create'">创建房间</button>
        <button :class="{ active: mode === 'join' }" @click="mode = 'join'">加入房间</button>
      </div>

      <label class="hall-field">
        <span>房间昵称 *</span>
        <input v-model="profile.name" class="input" maxlength="16" placeholder="大家怎么称呼你" />
      </label>
      <label class="hall-field">
        <span>角色名</span>
        <input v-model="profile.charName" class="input" maxlength="24" placeholder="你在故事里是谁（可与昵称相同）" />
      </label>
      <label class="hall-field">
        <span>一句话人设</span>
        <input v-model="profile.persona" class="input" maxlength="60" placeholder="如：好奇心过剩的医学生，怕黑" />
      </label>

      <template v-if="mode === 'create'">
        <label class="hall-field">
          <span>房间码（可自定义或用建议码）</span>
          <div class="hall-row">
            <input v-model="suggest" class="input mono" maxlength="6" />
            <button class="btn ghost sm" style="white-space: nowrap" @click="suggest = genRoomCode()">换一个</button>
          </div>
        </label>
        <button class="btn primary block" style="width: 100%" :disabled="submitting" @click="start('create', suggest)">
          {{ submitting ? '进入中…' : '创建并进入' }}
        </button>
      </template>
      <template v-else>
        <label class="hall-field">
          <span>6 位房间码</span>
          <input v-model="code" class="input mono" style="text-transform: uppercase" maxlength="6" placeholder="如 ab2c9k" @keyup.enter="start('join')" />
        </label>
        <button class="btn primary" style="width: 100%" :disabled="submitting" @click="start('join')">
          {{ submitting ? '进入中…' : '加入房间' }}
        </button>
      </template>

      <p v-if="hall.state.error" style="color: var(--danger); font-size: 0.8rem">{{ hall.state.error }}</p>

      <div v-if="campaigns.length && mode === 'create'" class="hall-resume">
        <div class="section-title" style="margin-top: 0">恢复战役（房主）</div>
        <button v-for="c in campaigns.slice(0, 4)" :key="c.id" class="hall-resume-item" @click="resume(c.id, c.roomCode)">
          <b>{{ c.name }}</b>
          <span style="color: var(--text-2); font-family: monospace">{{ c.roomCode.toUpperCase() }}</span>
        </button>
        <p class="hall-sys-line" style="text-align: left">恢复会沿用历史房间码；想开新团就改房间码再创建</p>
      </div>
    </div>
  </div>
</template>
