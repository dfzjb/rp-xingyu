<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Dices, RefreshCw, Lock, LockOpen, Users, Plus, LogOut, Settings2 } from 'lucide-vue-next'
import {
  hall, connectLobby, disconnectLobby, connect, leaveRoom, refreshCampaigns,
  type CreateMeta, type Profile,
} from '../lib/hall/useHall'
import { genRoomCode } from '../lib/hall/crypto'
import type { RoomMeta } from '../lib/hall/protocol'
import HallStoryStream from '../components/hall/HallStoryStream.vue'
import HallComposer from '../components/hall/HallComposer.vue'
import HallMembersPanel from '../components/hall/HallMembersPanel.vue'
import HallDiceBar from '../components/hall/HallDiceBar.vue'
import HallSettingsModal from '../components/hall/HallSettingsModal.vue'

// ── 大厅 / 房间切换 ──
const inRoom = computed(() => hall.state.phase === 'room' || hall.state.phase === 'connecting')
const showLobby = computed(() => !inRoom.value)
const showSettings = ref(false)

onMounted(() => {
  void refreshCampaigns()
  connectLobby()
})
onUnmounted(() => disconnectLobby())

function copyRoomCode() {
  if (hall.state.roomCode) void navigator.clipboard?.writeText(hall.state.roomCode.toUpperCase())
}

// ── 入场资料（昵称必填，只在没填过时出现）──
const profileForm = reactive<Profile>({ ...hall.profile })
const profileReady = computed(() => !!profileForm.name.trim())

// ── 创建房间 ──
const showCreate = ref(false)
const creating = ref(false)
const createForm = reactive({ title: '', desc: '', cover: '', locked: false, password: '' })
const suggestCode = ref(genRoomCode())
const createError = ref('')
const campaigns = ref<{ id: string; name: string; roomCode: string; locked: boolean; hasPassword: boolean }[]>([])
const coverInput = ref<HTMLInputElement | null>(null)

async function openCreate() {
  createError.value = ''
  createForm.title = ''
  createForm.desc = ''
  createForm.cover = ''
  createForm.locked = false
  createForm.password = ''
  suggestCode.value = genRoomCode()
  await refreshCampaigns()
  campaigns.value = hall.campaigns.map((c) => ({
    id: c.id, name: c.name, roomCode: c.roomCode, locked: c.locked, hasPassword: !!c.password,
  }))
  showCreate.value = true
}

function pickCover() { coverInput.value?.click() }

async function onCoverPicked(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  if (f.size > 150 * 1024) {
    createError.value = '封面图片请小于 150KB'
    ;(e.target as HTMLInputElement).value = ''
    return
  }
  createForm.cover = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(f)
  })
  ;(e.target as HTMLInputElement).value = ''
}

async function submitCreate() {
  if (creating.value) return
  if (!profileReady.value) { createError.value = '请先填房间昵称'; return }
  if (createForm.locked && !createForm.password.trim()) { createError.value = '已选择上锁，请输入房间密码'; return }
  creating.value = true
  createError.value = ''
  const meta: CreateMeta = {
    title: createForm.title.trim() || '未命名房间',
    desc: createForm.desc.trim(),
    cover: createForm.cover,
    locked: createForm.locked,
  }
  await connect({
    mode: 'create',
    code: suggestCode.value,
    profile: { ...profileForm },
    meta,
    password: createForm.locked ? createForm.password.trim() : '',
  })
  creating.value = false
  if (hall.state.phase === 'error' || hall.state.phase === 'closed') createError.value = hall.state.error
  // 成功进入房间由 phase watch 统一收尾（连接是异步完成的）
}

async function resumeCampaign(c: { id: string; name: string; roomCode: string; locked: boolean; hasPassword: boolean }) {
  const camp = hall.campaigns.find((x) => x.id === c.id)
  if (!camp) return
  creating.value = true
  createError.value = ''
  await connect({
    mode: 'create',
    code: camp.roomCode,
    profile: { ...profileForm },
    campaignId: camp.id,
    meta: { title: camp.name, desc: camp.desc, cover: camp.cover, locked: camp.locked },
    password: camp.password,
  })
  creating.value = false
  if (hall.state.phase === 'error' || hall.state.phase === 'closed') createError.value = hall.state.error
  // 成功进入房间由 phase watch 统一收尾（连接是异步完成的）
}

// ── 加入房间（点击房间卡片）──
const joinTarget = ref<RoomMeta | null>(null)
const joinPassword = ref('')
const joining = ref(false)
const joinError = ref('')

function openJoin(room: RoomMeta) {
  joinTarget.value = room
  joinPassword.value = ''
  joinError.value = ''
}

function closeJoin() {
  joinTarget.value = null
  leaveRoom() // 若 connect 已把 phase 置 error，重置回大厅
}

async function submitJoin() {
  const room = joinTarget.value
  if (!room || joining.value) return
  if (!profileReady.value) { joinError.value = '请先填房间昵称'; return }
  if (room.locked && !joinPassword.value.trim()) { joinError.value = '该房间已上锁，请输入密码'; return }
  joining.value = true
  joinError.value = ''
  await connect({
    mode: 'join',
    code: room.code,
    profile: { ...profileForm },
    password: room.locked ? joinPassword.value.trim() : '',
  })
  joining.value = false
  if (hall.state.phase === 'error' || hall.state.phase === 'closed') joinError.value = hall.state.error
  // 成功进入房间由 phase watch 统一收尾
}

// 连接是异步完成的：确认进房后关闭所有弹窗
watch(() => hall.state.phase, (p) => {
  if (p === 'room') {
    joinTarget.value = null
    showCreate.value = false
    joinError.value = ''
    createError.value = ''
  }
})

// 大厅实时刷新（rooms-changed 由 lobby socket 处理）；本地错误变化时同步到弹窗
watch(() => hall.state.error, (e) => {
  if (joinTarget.value && e) joinError.value = e
  if (showCreate.value && e) createError.value = e
})
</script>

<template>
  <!-- 房间内：沉浸式房间界面 -->
  <div v-if="inRoom" class="hall-root">
    <header class="hall-topbar">
      <div class="hall-brand">{{ hall.state.campaignName || '星屿 · 跑团' }}</div>
      <div class="hall-room-chip" title="点击复制房间码" @click="copyRoomCode">
        房间 <b>{{ hall.state.roomCode.toUpperCase() }}</b>
        <span class="hall-dot" />
      </div>
      <div class="hall-topbar-right">
        <span class="hall-online">{{ hall.memberList.value.length }} 人在线</span>
        <span v-if="hall.state.isHost" class="hall-tag">房主</span>
        <button class="btn ghost sm" @click="leaveRoom()"><LogOut :size="13" />退出房间</button>
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
  </div>

  <!-- 大厅：与角色卡工坊同款页面框架 + 卡片网格 -->
  <div v-else class="view-page">
    <div class="page-scroll">
      <div class="page-inner">
        <div class="page-toolbar">
          <div class="section-title" style="margin-bottom: 0">
            <Dices /> 在线跑团
            <span class="chip violet" style="margin-left: 4px">{{ hall.lobby.rooms.length }}</span>
          </div>
          <div style="flex: 1" />
          <span v-if="hall.lobby.status === 'connecting'" class="hall-sys-line">正在连接大厅…</span>
          <span v-else-if="hall.lobby.status === 'off'" class="hall-sys-line">大厅离线——请确认中继已启动</span>
          <button class="btn sm" title="跑团设置（中继地址）" @click="showSettings = true"><Settings2 :size="13" />设置</button>
          <button class="btn sm" title="刷新列表" @click="connectLobby()"><RefreshCw :size="13" />刷新</button>
          <button class="btn primary" @click="openCreate"><Plus :size="15" />创建房间</button>
        </div>

        <div v-if="hall.state.error" class="danger-box" style="margin-bottom: 12px">{{ hall.state.error }}</div>

        <!-- 上锁房间需要先补密码；开放房间点击即入 -->
        <div v-if="hall.lobby.rooms.length" class="char-grid">
          <div
            v-for="room in hall.lobby.rooms"
            :key="room.code"
            class="char-card spotlight-card"
            @click="openJoin(room)"
          >
            <div class="cover">
              <img v-if="room.cover" :src="room.cover" alt="" loading="lazy" />
              <template v-else>{{ (room.title || '?').slice(0, 2) }}</template>
              <div class="cover-chips">
                <span class="chip" :class="room.locked ? 'violet' : 'on'">
                  <Lock v-if="room.locked" :size="11" style="vertical-align: -1px" />
                  <LockOpen v-else :size="11" style="vertical-align: -1px" />
                  {{ room.locked ? '已上锁' : '直接进入' }}
                </span>
                <span class="chip"><Users :size="11" style="vertical-align: -1px" />{{ room.players }} 人</span>
              </div>
              <div class="cover-title">{{ room.title || '未命名房间' }}</div>
            </div>
            <div class="info">
              <div class="desc">{{ room.desc || '（房间主没有写简介）' }}</div>
            </div>
          </div>
        </div>

        <div v-else class="chat-empty" style="padding: 70px 0">
          <div class="empty-glyph"><Dices /></div>
          <div style="font-size: 1rem; font-weight: 700; color: var(--text-1)">当前没有在线的房间</div>
          <div>点右上角「创建房间」开一桌——开放房间 anyone 可进，上锁房间凭密码进入</div>
        </div>

        <!-- 大厅离线提示 -->
        <div v-if="hall.lobby.status === 'off'" class="card-panel" style="margin-top: 16px; padding: 12px 14px; font-size: 0.8rem; color: var(--text-2)">
          无法连接中继服务器：房间列表不可用。请确认 <code>npm run server</code> 已启动；
          远程中继可在房间内「设置」里配置。点此页右上角「刷新」重试。
        </div>
      </div>
    </div>

    <!-- 创建房间弹窗 -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal-box">
        <div class="modal-head">
          <h3>创建房间</h3>
          <button class="modal-close" @click="showCreate = false">✕</button>
        </div>
        <div class="modal-body">
          <div v-if="!profileReady" class="danger-box" style="margin-bottom: 12px">先填好入场资料（房间昵称必填），才会出现在成员列表里</div>
          <div class="field">
            <label>房间昵称 *</label>
            <input v-model="profileForm.name" class="input" maxlength="16" placeholder="大家怎么称呼你" />
          </div>
          <div class="field">
            <label>角色名</label>
            <input v-model="profileForm.charName" class="input" maxlength="24" placeholder="你在故事里是谁（可与昵称相同）" />
          </div>
          <div class="field">
            <label>一句话人设</label>
            <input v-model="profileForm.persona" class="input" maxlength="60" placeholder="如：好奇心过剩的医学生，怕黑" />
          </div>
          <div class="field">
            <label>房间名（会显示在大厅列表）</label>
            <input v-model="createForm.title" class="input" maxlength="40" placeholder="如：周五夜 · 万智宅邸" />
          </div>
          <div class="field">
            <label>房间简介</label>
            <textarea v-model="createForm.desc" class="textarea" rows="2" maxlength="200" placeholder="题材、规则、人数预期…" />
          </div>
          <div class="field">
            <label>封面（可选，≤150KB）</label>
            <div style="display: flex; gap: 10px; align-items: center">
              <div
                style="width: 64px; height: 64px; border-radius: 12px; overflow: hidden; background: var(--bg-3); display: flex; align-items: center; justify-content: center; cursor: pointer; border: 1px dashed var(--line-strong)"
                @click="pickCover"
              >
                <img v-if="createForm.cover" :src="createForm.cover" style="width: 100%; height: 100%; object-fit: cover" alt="" />
                <template v-else>＋</template>
              </div>
              <input ref="coverInput" type="file" accept="image/*" hidden @change="onCoverPicked" />
              <button v-if="createForm.cover" class="btn sm" @click="createForm.cover = ''">移除封面</button>
            </div>
          </div>
          <div class="field">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer">
              <input v-model="createForm.locked" type="checkbox" style="width: auto" />
              上锁房间（大厅展示为「已上锁」，凭密码进入）
            </label>
            <input v-if="createForm.locked" v-model="createForm.password" class="input" type="password" maxlength="40" placeholder="房间密码（只存在你本机，服务器只存校验散列）" />
          </div>
          <div class="field" v-if="campaigns.length">
            <label>恢复我的战役（沿用原房间码与密码）</label>
            <button v-for="c in campaigns.slice(0, 4)" :key="c.id" class="btn sm" style="width: 100%; justify-content: flex-start; margin-bottom: 6px" @click="resumeCampaign(c)">
              {{ c.name }} · {{ c.roomCode.toUpperCase() }} <span v-if="c.locked" class="hall-tag" style="margin-left: auto">🔒</span>
            </button>
          </div>

          <div v-if="createError" class="danger-box">{{ createError }}</div>
          <div style="display: flex; justify-content: flex-end; gap: 10px">
            <button class="btn" @click="showCreate = false">取消</button>
            <button class="btn primary" :disabled="creating" @click="submitCreate">{{ creating ? '进入中…' : `创建并进入（${suggestCode.toUpperCase()}）` }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 房间详情 / 加入弹窗 -->
    <div v-if="joinTarget" class="modal-mask" @click.self="closeJoin">
      <div class="modal-box">
        <div class="modal-head">
          <h3>{{ joinTarget.title || '未命名房间' }}</h3>
          <button class="modal-close" @click="closeJoin">✕</button>
        </div>
        <div class="modal-body">
          <div
            style="height: 180px; border-radius: 14px; overflow: hidden; background: var(--bg-3); display: flex; align-items: center; justify-content: center; margin-bottom: 12px; font-size: 2rem; color: var(--text-2)"
          >
            <img v-if="joinTarget.cover" :src="joinTarget.cover" style="width: 100%; height: 100%; object-fit: cover" alt="" />
            <template v-else>{{ (joinTarget.title || '?').slice(0, 2) }}</template>
          </div>
          <div style="display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap">
            <span class="chip" :class="joinTarget.locked ? 'violet' : 'on'">
              <Lock v-if="joinTarget.locked" :size="11" style="vertical-align: -1px" />
              <LockOpen v-else :size="11" style="vertical-align: -1px" />
              {{ joinTarget.locked ? '已上锁 · 凭密码进入' : '开放房间 · 直接进入' }}
            </span>
            <span class="chip"><Users :size="11" style="vertical-align: -1px" />{{ joinTarget.players }} 人在线</span>
            <span class="chip mono">{{ joinTarget.code.toUpperCase() }}</span>
          </div>
          <p style="font-size: 0.84rem; color: var(--text-1); line-height: 1.7; margin: 0 0 14px">
            {{ joinTarget.desc || '（房间主没有写简介）' }}
          </p>

          <div class="field">
            <label>房间昵称 *</label>
            <input v-model="profileForm.name" class="input" maxlength="16" placeholder="大家怎么称呼你" />
          </div>
          <div class="field">
            <label>角色名</label>
            <input v-model="profileForm.charName" class="input" maxlength="24" placeholder="你在故事里是谁" />
          </div>
          <div class="field">
            <label>一句话人设</label>
            <input v-model="profileForm.persona" class="input" maxlength="60" placeholder="让 KP 知道怎么安排你的戏份" />
          </div>
          <div v-if="joinTarget.locked" class="field">
            <label>房间密码 *</label>
            <input v-model="joinPassword" class="input" type="password" maxlength="40" placeholder="问房间主要密码" @keyup.enter="submitJoin" />
          </div>

          <div v-if="joinError" class="danger-box">{{ joinError }}</div>
          <div style="display: flex; justify-content: flex-end; gap: 10px">
            <button class="btn" @click="closeJoin">取消</button>
            <button class="btn primary" :disabled="joining" @click="submitJoin">{{ joining ? '进入中…' : (joinTarget.locked ? '验证密码并进入' : '直接进入') }}</button>
          </div>
        </div>
      </div>
    </div>

    <HallSettingsModal v-if="showSettings" @close="showSettings = false" />
  </div>
</template>
