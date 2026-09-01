<script setup lang="ts">
// 我的团面板（大厅右侧常驻）：本机 IndexedDB 的全部战役，可恢复/删除；
// 「保留」数字自选（− N ＋，0 = 全部保留），超出自动清理最旧的战役。
import { computed, onMounted, ref } from 'vue'
import { History, Trash2, LogIn, Minus, Plus } from 'lucide-vue-next'
import { hall, connect, refreshCampaigns, deleteCampaign, pruneCampaigns, type Profile } from '../../lib/hall/useHall'
import type { HallCampaign } from '../../lib/hall/protocol'
import { useSettingsStore } from '../../stores/settings'
import { usePersonasStore } from '../../stores/personas'

const emit = defineEmits<{ changed: [] }>()

const settings = useSettingsStore()
const personas = usePersonasStore()
const activePersona = computed(() => personas.list.find((p) => p.uuid === personas.activeUuid) || null)

const list = ref<HallCampaign[]>([])
const enteringId = ref('')
const error = ref('')
const keep = ref(0)
const pruning = ref(false)

onMounted(async () => {
  await settings.load()
  keep.value = settings.settings.hallKeepCampaigns || 0
  await reload()
})

async function reload() {
  await refreshCampaigns()
  list.value = [...hall.campaigns]
}

function personaProfile(): Profile | null {
  const p = activePersona.value
  if (!p) return null
  return { name: p.name, charName: p.name, persona: p.description }
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function resume(c: HallCampaign) {
  const profile = personaProfile()
  if (!profile) { error.value = '还没有人设：请先点工具栏「人设」创建身份'; return }
  error.value = ''
  enteringId.value = c.id
  await connect({
    mode: 'create',
    code: c.roomCode,
    profile,
    campaignId: c.id,
    meta: { title: c.name, desc: c.desc, cover: c.cover, locked: c.locked, setting: c.setting },
    password: c.password,
  })
  enteringId.value = ''
  if (hall.state.phase === 'error' || hall.state.phase === 'closed') error.value = hall.state.error
}

async function remove(c: HallCampaign) {
  if (!confirm(`删除战役「${c.name}」？全部剧情记录不可恢复。`)) return
  await deleteCampaign(c.id)
  await reload()
  emit('changed')
}

/** 保留数自选：−/+ 调整（0 = 全部），立即持久化并清理超出部分 */
async function bump(delta: number) {
  const next = Math.min(99, Math.max(0, keep.value + delta))
  if (next === keep.value) return
  keep.value = next
  await settings.patch({ hallKeepCampaigns: next })
  pruning.value = true
  const removed = await pruneCampaigns(next)
  await reload()
  pruning.value = false
  if (removed > 0) emit('changed')
}
</script>

<template>
  <div class="hall-panel camp-panel">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px">
      <div class="hall-panel-title" style="margin-bottom: 0"><History :size="13" style="vertical-align: -2px" /> 我的团（{{ list.length }}）</div>
      <div class="keep-ctl" title="保留最近几场战役；0 = 全部保留。超出自动删除最旧的">
        <button class="keep-btn" :disabled="keep === 0" @click="bump(-1)"><Minus :size="12" /></button>
        <b class="keep-num">{{ keep === 0 ? '全部' : keep }}</b>
        <button class="keep-btn" :disabled="keep >= 99" @click="bump(1)"><Plus :size="12" /></button>
      </div>
    </div>
    <div class="hall-dice-hint" style="margin-bottom: 10px">
      {{ keep === 0 ? '全部保留在本机浏览器，退出不丢' : `只保留最近 ${keep} 场，更旧的会在开新团时清理` }}
    </div>

    <div v-for="c in list" :key="c.id" class="camp-row">
      <div class="hall-avatar hall-avatar-sm" style="width: 38px; height: 38px; border-radius: 10px; overflow: hidden; flex-shrink: 0">
        <img v-if="c.cover" :src="c.cover" style="width: 100%; height: 100%; object-fit: cover" alt="" />
        <template v-else>{{ (c.name || '?').slice(0, 2) }}</template>
      </div>
      <div style="flex: 1; min-width: 0">
        <div style="display: flex; align-items: center; gap: 6px">
          <b class="camp-name">{{ c.name || '未命名战役' }}</b>
          <span v-if="c.locked" class="hall-tag">🔒</span>
        </div>
        <div style="font-size: 0.7rem; color: var(--text-2); margin-top: 2px">
          <span class="mono">{{ c.roomCode.toUpperCase() }}</span> · {{ fmtTime(c.updatedAt) }} · {{ c.events.length }} 条剧情
        </div>
      </div>
      <div style="display: flex; gap: 5px; flex-shrink: 0">
        <button class="btn sm primary" style="padding: 4px 9px" :disabled="enteringId === c.id" @click="resume(c)">
          <LogIn :size="12" />{{ enteringId === c.id ? '…' : '恢复' }}
        </button>
        <button class="btn sm danger" style="padding: 4px 7px" title="删除战役" @click="remove(c)"><Trash2 :size="12" /></button>
      </div>
    </div>

    <div v-if="pruning" class="hall-sys-line" style="margin-top: 8px">正在按保留数清理旧团…</div>
    <div v-if="!activePersona && list.length" class="hall-sys-line" style="margin-top: 8px">
      还没有人设——先在工具栏「人设」里创建身份才能恢复。
    </div>
    <div v-if="error" class="danger-box" style="margin-top: 8px">{{ error }}</div>
  </div>
</template>

<style scoped>
.camp-panel { position: sticky; top: 12px; }
.camp-row {
  display: flex; gap: 9px; align-items: center;
  padding: 7px 8px; margin: 0 -4px 6px; border-radius: 10px;
  transition: background 0.15s;
}
.camp-row:hover { background: var(--bg-2); }
.camp-name {
  font-size: 0.8rem; max-width: 150px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.keep-ctl {
  display: flex; align-items: center; gap: 6px;
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 999px;
  padding: 2px 8px;
}
.keep-btn {
  background: none; border: none; color: var(--text-2); cursor: pointer;
  display: flex; align-items: center; padding: 2px; border-radius: 6px;
}
.keep-btn:hover:not(:disabled) { color: var(--accent-soft); background: var(--bg-3); }
.keep-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.keep-num { font-size: 0.76rem; color: var(--accent-soft); min-width: 26px; text-align: center; font-variant-numeric: tabular-nums; }
</style>
