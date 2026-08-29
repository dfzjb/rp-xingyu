<script setup lang="ts">
/**
 * 好感度 Behavior Engine 页面（多 NPC 版）：
 * NPC 卡片网格 + 详情编辑 + AI 自主评估。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { Heart, Loader2, Plus, Trash2, Users } from 'lucide-vue-next'
import { NButton, NSlider, NSelect, NSwitch } from 'naive-ui'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import {
  AFFINITY_AXES, CONFLICT_LEVELS, listNpcAffinities, saveNpcAffinity, removeNpcAffinity,
  evaluateNpcsAutonomously, deriveStage, deriveConflict, conflictInfo,
  defaultNpcAffinity, affinityScore,
  type AffinityDimKey,
} from '../lib/affinity'
import type { NpcAffinity } from '../lib/affinity'
import { toast } from '../lib/toast'
import AffinityRadar from '../components/AffinityRadar.vue'

const chat = useChatStore()
const settings = useSettingsStore()

const items = ref<NpcAffinity[]>([])
const evaluating = ref(false)
const evalReason = ref('')
const editing = ref<NpcAffinity | null>(null)

const sessionId = computed(() => chat.currentSession?.id || '')

async function reload() {
  if (!sessionId.value) return
  items.value = await listNpcAffinities(sessionId.value)
}

watch(sessionId, () => void reload())
onMounted(async () => {
  if (!chat.loaded) await chat.load()
  if (!settings.loaded) await settings.load()
  await reload()
})

async function evaluate() {
  const s = chat.currentSession
  if (!s || evaluating.value) return
  const cfg = {
    baseUrl: settings.settings.apiBaseUrl,
    apiKey: settings.settings.apiKey,
    model: settings.settings.memoryAuxModel || settings.activeModel,
    temperature: 0.2,
    maxTokens: 800,
    reasoningEffort: 'minimal',
  }
  if (!cfg.apiKey || !cfg.model) {
    toast.warning('请先在设置中配置 API Key 与模型')
    return
  }
  evaluating.value = true
  evalReason.value = ''
  try {
    const updated = await evaluateNpcsAutonomously(cfg, chat.chain, s.id, 24)
    toast.success(`已更新 ${updated.length} 个 NPC 档案`)
    await reload()
  } catch (err) {
    toast.error(`评估失败：${(err as Error).message}`)
  } finally {
    evaluating.value = false
  }
}

function stageOf(a: NpcAffinity) { return deriveStage(a) }
function scoreOf(a: NpcAffinity) { return affinityScore(a) }
function conflictLvOf(a: NpcAffinity) { return deriveConflict(a) }
function conflictDefOf(a: NpcAffinity) { return conflictInfo(deriveConflict(a)) }

const showAddModal = ref(false)
const newNpcName = ref('')

function addNpc() {
  if (!newNpcName.value.trim() || !sessionId.value) return
  const a = defaultNpcAffinity(sessionId.value, newNpcName.value.trim())
  saveNpcAffinity(a).then(() => {
    showAddModal.value = false
    newNpcName.value = ''
    reload()
  })
}

/** 六个维度互相独立（与 LLM 自主评判同一规则：允许「爱恨交加」的矛盾组合，不做联动） */
async function onDimSlider(key: AffinityDimKey, v: number) {
  if (!editing.value) return
  ;(editing.value as unknown as Record<string, number>)[key] = v
  await saveNpcAffinity(editing.value)
}
async function onConflictOverride(v: number) {
  if (!editing.value) return
  // 下拉的 -1 表示「自动推导」，存 null 而不是 -1（-1 会被推导逻辑当成 0 无冲突）
  ;(editing.value as unknown as Record<string, number | null>).conflictOverride = v < 0 ? null : v
  await saveNpcAffinity(editing.value)
}
async function removeOne() {
  if (!editing.value || !confirm(`删除「${editing.value.npcName}」的好感度档案？`)) return
  await removeNpcAffinity(editing.value.id)
  editing.value = null
  await reload()
}
/** 编辑弹窗的分组行：每组对轴一根标题 + 正反两根滑条 */
const axisRows = AFFINITY_AXES.map((ax) => ({
  name: ax.name,
  dims: [
    { key: ax.pos as AffinityDimKey, label: ax.posLabel },
    { key: ax.neg as AffinityDimKey, label: ax.negLabel },
  ],
}))
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner" style="max-width: 860px">
        <div class="section-title" style="font-size: 1.12rem"><Users /> 好感度 Behavior Engine</div>

        <p style="font-size: 0.78rem; color: var(--text-2); line-height: 1.7; margin-bottom: 14px">
          AI 每轮回复后自主评估剧情中出现的 NPC 对用户的关系变化（三组相对属性轴 + 冲突等级），并在此建档追踪。
          状态摘要自动注入提示词影响角色言行。
        </p>

        <div style="display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap">
          <n-button size="small" type="primary" :loading="evaluating" @click="evaluate">
            <template #icon><Loader2 v-if="evaluating" /><Heart v-else /></template>
            {{ evaluating ? 'AI 阅读最近剧情…' : 'AI 自主评估最近剧情' }}
          </n-button>
          <button class="btn sm" @click="showAddModal = true"><Plus :size="14" />手动新增</button>
          <span v-if="evalReason" style="font-size: 0.74rem; color: var(--text-2); align-self: center">{{ evalReason }}</span>
        </div>

        <!-- NPC 网格 -->
        <div v-if="items.length" class="npc-grid">
          <div v-for="a in items" :key="a.id" class="card-panel npc-card spotlight-card" @click="editing = a">
            <div class="npc-head"><Heart :size="16" style="color: #f9a8d4" /><b>{{ a.npcName }}</b></div>
            <div class="npc-radar"><AffinityRadar :row="a" :size="92" :show-labels="false" /></div>
            <div class="npc-stage">{{ stageOf(a) }}</div>
            <div class="npc-score">综合 {{ scoreOf(a) }} 分 · 冲突 Lv.{{ conflictLvOf(a) }}</div>
          </div>
        </div>

        <!-- 详情弹窗 -->
        <div v-if="editing" class="modal-mask" @click.self="editing = null">
          <div class="modal-box">
            <div class="modal-head">
              <h3>❤️ {{ editing.npcName }} · {{ stageOf(editing) }}</h3>
              <button class="modal-close" @click="editing = null">✕</button>
            </div>
            <div class="modal-body">
              <div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start">
                <AffinityRadar :row="editing" :size="228" style="flex-shrink: 0" />
                <div style="flex: 1; min-width: 230px">
                  <div v-for="ax in axisRows" :key="ax.name" style="margin-bottom: 18px">
                    <div class="axis-caption">{{ ax.name }}</div>
                    <div v-for="d in ax.dims" :key="d.key" style="margin-bottom: 12px">
                      <div style="display: flex; justify-content: space-between; font-size: 0.82rem; color: var(--text-1); margin-bottom: 5px">
                        <span>{{ d.label }}</span><span class="dim-val">{{ editing[d.key] }}</span>
                      </div>
                      <NSlider :value="editing[d.key]" :min="0" :max="100" :step="1" @update:value="(v: number) => onDimSlider(d.key, v)" />
                    </div>
                  </div>
                  <div class="field" style="margin-top: 14px">
                    <label>冲突等级（手动覆盖）</label>
                    <NSelect
                      size="small"
                      :value="typeof editing.conflictOverride === 'number' ? editing.conflictOverride : -1"
                      :options="[
                        { label: '自动推导', value: -1 },
                        ...CONFLICT_LEVELS.map((c) => ({ label: `Lv.${c.level} ${c.name}`, value: c.level })),
                      ]"
                      @update:value="(v: number) => onConflictOverride(v)"
                    />
                  </div>
                </div>
              </div>
              <div style="font-size: 0.82rem; margin-top: 10px">
                <b>Lv.{{ conflictLvOf(editing) }} {{ conflictDefOf(editing).name }}</b>
                <span style="color: var(--text-1)"> — {{ conflictDefOf(editing).desc }}</span>
              </div>
              <div style="margin-top: 18px; text-align: right">
                <button class="btn sm" style="color: #fca5a5" @click="removeOne">
                  <Trash2 :size="14" /> 删除档案
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="!items.length" class="chat-empty" style="padding: 50px 0">
          <div class="empty-glyph"><Users /></div>
          <div style="font-size: 0.9rem">暂无 NPC 档案——点上方按钮让 AI 自主评估，或手动新增</div>
        </div>
      </div>
    </div>
  </div>

    <!-- 新增 NPC -->
    <div v-if="showAddModal" class="modal-mask" @click.self="showAddModal = false">
      <div class="modal-box" style="max-width: 400px">
        <div class="modal-head"><h3>新增 NPC</h3><button class="modal-close" @click="showAddModal = false">✕</button></div>
        <div class="modal-body">
          <div class="field">
            <label>NPC 名称</label>
            <input v-model="newNpcName" class="input" placeholder="角色名…" @keydown.enter="addNpc" />
          </div>
          <n-button size="small" type="primary" @click="addNpc">确定</n-button>
        </div>
      </div>
    </div>
</template>

<style scoped>
.stage-hero {
  display: flex; align-items: center; gap: 18px; padding: 22px;
  border-radius: 18px; margin-bottom: 16px;
  background:
    radial-gradient(600px 200px at 90% -50%, rgba(244,114,182,0.25), transparent 60%),
    linear-gradient(135deg, rgba(139,92,246,0.2), rgba(34,211,238,0.1));
  border: 1px solid rgba(139,92,246,0.35);
}
.stage-heart { color: #f9a8d4; flex-shrink: 0; }
.stage-name { font-size: 1.9rem; font-weight: 900; line-height: 1.15; }
.stage-meta { font-size: 0.74rem; color: var(--text-2); margin-top: 3px; }
.conflict-badge {
  align-self: flex-start; font-size: 0.72rem; padding: 4px 11px;
  border-radius: 999px; border: 1px solid var(--line-strong); background: var(--bg-2); white-space: nowrap;
}
.conflict-badge.lv3, .conflict-badge.lv4 { border-color: rgba(248,113,113,0.55); color: #fca5a5; }
.conflict-badge.lv2 { border-color: rgba(251,191,36,0.5); color: #fcd34d; }
.dim-row { margin-bottom: 14px; }
.dim-label { display: flex; justify-content: space-between; font-size: 0.82rem; color: var(--text-1); margin-bottom: 5px; }
.dim-val { font-variant-numeric: tabular-nums; color: var(--text-2); }
.axis-caption {
  text-align: center; font-size: 0.7rem; color: var(--text-2); letter-spacing: 0.14em;
  opacity: 0.85; margin-bottom: 10px;
}
.reason { margin-top: 10px; font-size: 0.78rem; color: var(--text-1); background: var(--bg-2); border-radius: 9px; padding: 8px 12px; }

.npc-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px;
}
.npc-card { cursor: pointer; padding: 14px; border-radius: 14px; }
.npc-head { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
.npc-radar { display: flex; justify-content: center; margin: 2px 0 6px; }
.npc-stage { font-size: 1.15rem; font-weight: 800; color: #f9a8d4; }
.npc-score { font-size: 0.72rem; color: var(--text-2); margin-top: 3px; }
.conflict-current { line-height: 1.7; }
</style>
