<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Dices, RefreshCw, Lock, LockOpen, Users, Plus, LogOut, Cpu, UserRound, ScrollText, Share2 } from 'lucide-vue-next'
import {
  hall, connectLobby, disconnectLobby, connect, leaveRoom, refreshCampaigns,
  buildInviteLink, consumeBootInvite,
  type Profile,
} from '../lib/hall/useHall'
import { DEFAULT_HALL_RELAY, type RoomMeta } from '../lib/hall/protocol'
import { PARTY_LINE } from '../lib/hall/protocol'
import { lineOf } from '../lib/hall/kp'
import { systemLabel } from '../lib/hall/rules'
import { usePersonasStore } from '../stores/personas'
import '../hall.css'
import HallStoryStream from '../components/hall/HallStoryStream.vue'
import HallComposer from '../components/hall/HallComposer.vue'
import HallMembersPanel from '../components/hall/HallMembersPanel.vue'
import HallDiceBar from '../components/hall/HallDiceBar.vue'
import HallSceneBar from '../components/hall/HallSceneBar.vue'
import HallStatePanel from '../components/hall/HallStatePanel.vue'
import HallProgressPanel from '../components/hall/HallProgressPanel.vue'
import HallWheelPanel from '../components/hall/HallWheelPanel.vue'
import HallAreaBar from '../components/hall/HallAreaBar.vue'
import HallSettingsModal from '../components/hall/HallSettingsModal.vue'
import HallPersonaModal from '../components/hall/HallPersonaModal.vue'
import HallCreateModal from '../components/hall/HallCreateModal.vue'
import HallBriefingModal from '../components/hall/HallBriefingModal.vue'
import HallCampaignsPanel from '../components/hall/HallCampaignsPanel.vue'

// ── 大厅 / 房间切换 ──
const inRoom = computed(() => hall.state.phase === 'room' || hall.state.phase === 'connecting')

// ── 分线视图：只显示当前线的剧情，KP 流式气泡也只落在它自己的线上 ──
const visibleEvents = computed(() => hall.state.events.filter((e) => lineOf(e) === hall.state.currentScene))
const visibleStreaming = computed(() =>
  hall.state.streaming && (hall.state.streaming.scene || PARTY_LINE) === hall.state.currentScene ? hall.state.streaming : null,
)
const lineEmptyHint = computed(() =>
  hall.state.currentScene === PARTY_LINE
    ? ''
    : hall.state.scenes.find((s) => s.id === hall.state.currentScene)?.closed
      ? '这条线已收线——剧情保留可回看，房主可在页签旁重开。'
      : '这条线还没有动静——在下方行动、掷骰，或点「让 KP 出手」开线。',
)
const showSettings = ref(false)
const showPersona = ref(false)
const showCreate = ref(false)
const showBriefing = ref(false)
/** 本机战役数：>0 时大厅右侧显示「我的团」面板 */
const campaignCount = ref(0)

async function recount() {
  await refreshCampaigns()
  campaignCount.value = hall.campaigns.length
}

onMounted(() => {
  connectLobby()
  void recount()
  // 邀请链接（?join=码&relay=中继&l=1）：私人房间/跨中继进房的唯一入口，直接弹进房窗
  const invite = consumeBootInvite()
  if (invite) {
    joinTarget.value = {
      code: invite.code, title: '邀请房间', desc: '', cover: '',
      players: 0, locked: invite.locked, relay: invite.relay,
    }
  }
})
onUnmounted(() => disconnectLobby())

function copyRoomCode() {
  if (hall.state.roomCode) void navigator.clipboard?.writeText(hall.state.roomCode.toUpperCase())
}

// 邀请链接：带上本房间实际使用的中继地址，成员点开即可进房（私人房间的唯一入口）
const inviteCopied = ref(false)
function copyInvite() {
  if (!hall.state.roomCode || !hall.state.roomRelay) return
  const link = buildInviteLink(location.origin, location.pathname, hall.state.roomCode, hall.state.roomRelay, hall.state.roomLocked)
  void navigator.clipboard?.writeText(link)
  inviteCopied.value = true
  setTimeout(() => (inviteCopied.value = false), 1500)
}

// ── 入场身份：来自用户人设（原「更多 → 人设」体系）──
const personas = usePersonasStore()
const activePersona = computed(() => personas.list.find((p) => p.uuid === personas.activeUuid) || null)

/** 人设 → 房间身份：人设名 = 角色名，人设描述 = 给 KP 的介绍 */
function personaProfile(): Profile | null {
  const p = activePersona.value
  if (!p) return null
  return { name: p.name, charName: p.name, persona: p.description }
}

/** 顶栏团设摘要：如「COC7th · 4 人 · 2 基调」 */
const briefLabel = computed(() => {
  const s = hall.state.setting
  if (!s) return ''
  const parts = [systemLabel(s)]
  if (s.players) parts.push(`${s.players} 人`)
  if (s.tones.length) parts.push(s.tones.slice(0, 2).join('·'))
  return parts.filter(Boolean).join(' · ')
})

// ── 加入房间（点击房间卡片 / 邀请链接）──
interface JoinTargetInfo {
  code: string
  title: string
  desc: string
  cover: string
  players: number
  locked: boolean
  /** 邀请链接携带的中继地址；空 = 用我的中继（共享房间场景） */
  relay: string
}
const joinTarget = ref<JoinTargetInfo | null>(null)
const joinPassword = ref('')
const joining = ref(false)
const joinError = ref('')

function openJoin(room: RoomMeta) {
  joinTarget.value = {
    code: room.code, title: room.title || '未命名房间', desc: room.desc,
    cover: room.cover, players: room.players, locked: room.locked, relay: '',
  }
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
  const profile = personaProfile()
  if (!profile) { joinError.value = '还没有人设：请先点「人设」创建你的身份'; return }
  if (room.locked && !joinPassword.value.trim()) { joinError.value = '该房间已上锁，请输入密码'; return }
  joining.value = true
  joinError.value = ''
  await connect({
    mode: 'join',
    code: room.code,
    profile,
    password: room.locked ? joinPassword.value.trim() : '',
    relayOverride: room.relay || undefined,
  })
  joining.value = false
  if (hall.state.phase === 'error' || hall.state.phase === 'closed') joinError.value = hall.state.error
  // 成功进入房间由 phase watch 统一收尾
}

// 连接是异步完成的：确认进房后关闭所有弹窗；回到大厅时刷新「我的团」计数
watch(() => hall.state.phase, (p) => {
  if (p === 'room') {
    joinTarget.value = null
    showCreate.value = false
    joinError.value = ''
  } else if (p === 'idle' || p === 'closed') {
    void recount()
  }
})

// 本地错误变化时同步到加入弹窗
watch(() => hall.state.error, (e) => {
  if (joinTarget.value && e) joinError.value = e
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
      <button v-if="hall.state.setting" class="hall-brief-chip" title="查看开团设定" @click="showBriefing = true">
        <ScrollText :size="13" />{{ briefLabel }}
      </button>
      <div class="hall-topbar-right">
        <button class="btn ghost sm" title="复制邀请链接：朋友点开直接进房（私人房间的唯一入口）" @click="copyInvite">
          <Share2 :size="13" />{{ inviteCopied ? '已复制' : '邀请' }}
        </button>
        <span class="hall-online">{{ hall.memberList.value.length }} 人在线</span>
        <span v-if="hall.state.isHost" class="hall-tag">房主</span>
        <button class="btn ghost sm" @click="leaveRoom()"><LogOut :size="13" />退出房间</button>
      </div>
    </header>

    <div v-if="hall.state.error" class="hall-err-banner">{{ hall.state.error }}</div>

    <main class="hall-layout">
      <section class="hall-stream-col">
        <HallSceneBar />
        <HallStoryStream :events="visibleEvents" :streaming="visibleStreaming" :empty-hint="lineEmptyHint" />
        <HallComposer />
      </section>
      <aside class="hall-side-col">
        <HallMembersPanel />
        <HallDiceBar />
        <HallWheelPanel v-if="hall.state.module?.tables.length" />
        <HallStatePanel />
        <HallProgressPanel v-if="hall.state.module" />
        <HallAreaBar />
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
          <span v-else-if="hall.lobby.status === 'off'" class="hall-sys-line">大厅离线——无法连接中继（默认 {{ DEFAULT_HALL_RELAY }}）</span>
          <button class="btn sm" title="KP 模型设置（只影响在线跑团，未配置时用「更多 → 语言模型」）" @click="showSettings = true"><Cpu :size="13" />模型</button>
          <button class="btn sm" title="刷新列表" @click="connectLobby()"><RefreshCw :size="13" />刷新</button>
          <button class="btn sm" title="管理你的人设（进房身份）" @click="showPersona = true"><UserRound :size="13" />人设</button>
          <button class="btn primary" @click="showCreate = true"><Plus :size="15" />创建房间</button>
        </div>

        <div v-if="hall.state.error" class="danger-box" style="margin-bottom: 12px">{{ hall.state.error }}</div>

        <!-- 大厅双栏：左 = 房间/空态，右 = 我的团（有战役时显示） -->
        <div class="hall-lobby-grid" :class="{ 'has-side': campaignCount > 0 }">
          <div class="hall-lobby-main">
            <!-- 当前入场身份 -->
            <div class="card-panel" style="margin-bottom: 14px; padding: 10px 14px; display: flex; align-items: center; gap: 12px">
              <template v-if="activePersona">
                <div class="hall-avatar hall-avatar-sm" style="width: 38px; height: 38px; border-radius: 10px; overflow: hidden">
                  <img v-if="activePersona.avatar" :src="activePersona.avatar" style="width: 100%; height: 100%; object-fit: cover" alt="" />
                  <template v-else>{{ activePersona.name.slice(0, 1) }}</template>
                </div>
                <div style="flex: 1; min-width: 0">
                  <div style="font-size: 0.84rem"><b>{{ activePersona.name }}</b> <span class="hall-sys-line" style="display: inline">· 你将以这个身份进入房间</span></div>
                  <div class="hall-sys-line" style="text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ activePersona.description || '（人设还没有描述）' }}</div>
                </div>
                <button class="btn sm ghost" @click="showPersona = true">更换</button>
              </template>
              <template v-else>
                <div class="hall-avatar hall-avatar-sm" style="width: 38px; height: 38px; border-radius: 10px">?</div>
                <div style="flex: 1; font-size: 0.82rem; color: var(--text-1)">还没有人设——创建后即可用它进入房间</div>
                <button class="btn sm primary" @click="showPersona = true"><UserRound :size="13" />去创建</button>
              </template>
            </div>

            <!-- 在线房间卡片 -->
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
              无法连接中继：房间列表不可用。默认使用共享中继（{{ DEFAULT_HALL_RELAY }}）；
              想用自己的，在「模型 → 高级」里填「我的中继」（本地开发可 <code>npm run server</code> 后填 <code>ws://127.0.0.1:8787/ws</code>）。点右上角「刷新」重试。
            </div>
          </div>

          <!-- 我的团：本机战役列表（红框位置），带「保留最近 N 场」自选 -->
          <aside v-if="campaignCount > 0" class="hall-lobby-side">
            <HallCampaignsPanel @changed="recount" />
          </aside>
        </div>
      </div>
    </div>

    <!-- 创建房间弹窗：简洁 / 详细双模式（HallCreateModal 内部自管表单与人设校验） -->
    <HallCreateModal v-if="showCreate" @close="showCreate = false" />

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
            <span v-if="joinTarget.players" class="chip"><Users :size="11" style="vertical-align: -1px" />{{ joinTarget.players }} 人在线</span>
            <span class="chip mono">{{ joinTarget.code.toUpperCase() }}</span>
          </div>
          <p style="font-size: 0.84rem; color: var(--text-1); line-height: 1.7; margin: 0 0 14px">
            {{ joinTarget.desc || '（房间主没有写简介）' }}
          </p>

          <!-- 入场身份：来自用户人设 -->
          <div class="card-panel" style="padding: 10px 12px; display: flex; align-items: center; gap: 10px; margin-bottom: 12px">
            <template v-if="activePersona">
              <div class="hall-avatar hall-avatar-sm" style="width: 38px; height: 38px; border-radius: 10px; overflow: hidden">
                <img v-if="activePersona.avatar" :src="activePersona.avatar" style="width: 100%; height: 100%; object-fit: cover" alt="" />
                <template v-else>{{ activePersona.name.slice(0, 1) }}</template>
              </div>
              <div style="flex: 1; min-width: 0">
                <div style="font-size: 0.84rem"><b>{{ activePersona.name }}</b> <span class="hall-sys-line" style="display: inline">· 你的入场身份</span></div>
                <div class="hall-sys-line" style="text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ activePersona.description || '（人设还没有描述）' }}</div>
              </div>
              <button class="btn sm ghost" @click="showPersona = true">更换</button>
            </template>
            <template v-else>
              <div style="flex: 1; font-size: 0.82rem; color: var(--text-1)">还没有人设，进房前先创建你的身份</div>
              <button class="btn sm primary" @click="showPersona = true">去创建</button>
            </template>
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
    <HallPersonaModal v-if="showPersona" style="z-index: 65" @close="showPersona = false" />
  </div>

  <!-- 全局弹窗：挂根层级，房间内/大厅都能弹出（如房间顶栏的团设） -->
  <HallBriefingModal v-if="showBriefing" @close="showBriefing = false" />
</template>
