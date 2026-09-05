<script setup lang="ts">
// 创建房间弹窗：简洁 / 详细双模式（滑块切换，选择记在本机）。
// 简洁 = 房间名 + 简介 + 封面 + 上锁；详细 = 追加完整开团设定（规则系统/时代/基调/世界观/模组/NPC/房规/红线…），
// 设定只进 KP 提示词与战役存档（E2EE 同步给成员），不发中继。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Wand2, Lock, Info, Sparkles } from 'lucide-vue-next'
import {
  hall, connect, refreshCampaigns, aiAssistRoom, aiAssistCampaign, kpApiConfig,
  type CreateMeta, type Profile,
} from '../../lib/hall/useHall'
import { genRoomCode } from '../../lib/hall/crypto'
import { DEFAULT_HALL_RELAY, type HallRelayMode } from '../../lib/hall/protocol'
import { useSettingsStore } from '../../stores/settings'
import { RULE_PRESETS, TONE_OPTIONS, KP_STYLES, emptySetting, isEmptySetting, type RoomSetting } from '../../lib/hall/rules'
import { normalizeModule, type GameModule, type ModuleAiConfig } from '../../lib/hall/module'
import { db } from '../../db'
import AiModuleForge from '../AiModuleForge.vue'
import { usePersonasStore } from '../../stores/personas'

const emit = defineEmits<{ close: [] }>()

// ── 模式滑块（记住上次选择）──
const MODE_KEY = 'hall.createMode'
const mode = ref<'simple' | 'pro'>((localStorage.getItem(MODE_KEY) as 'pro') === 'pro' ? 'pro' : 'simple')
watch(mode, (m) => localStorage.setItem(MODE_KEY, m))

// ── 中继模式：共享（公共大厅） / 私人（自己的中继，邀请链接进房）；记住上次选择 ──
const RELAY_KEY = 'hall.relayMode'
const relayMode = ref<HallRelayMode>((localStorage.getItem(RELAY_KEY) as 'private') === 'private' ? 'private' : 'shared')
watch(relayMode, (m) => localStorage.setItem(RELAY_KEY, m))
const settingsStore = useSettingsStore()
const hasOwnRelay = computed(() => !!settingsStore.settings.hallWsUrl.trim())

// ── 入场身份（人设）──
const personas = usePersonasStore()
const activePersona = computed(() => personas.list.find((p) => p.uuid === personas.activeUuid) || null)

function personaProfile(): Profile | null {
  const p = activePersona.value
  if (!p) return null
  return { name: p.name, charName: p.name, persona: p.description }
}

// ── 表单 ──
const creating = ref(false)
const createError = ref('')
const suggestCode = ref(genRoomCode())
const form = reactive({ title: '', desc: '', cover: '', locked: false, password: '' })
const setting = reactive<RoomSetting>(emptySetting())
const coverInput = ref<HTMLInputElement | null>(null)
const campaigns = ref<{ id: string; name: string; roomCode: string; locked: boolean; hasPassword: boolean }[]>([])

// ── 逐条清单（房规 / 关键 NPC / 内容红线）：一条一项，随意增删，提交时按行合并 ──
const houseRuleList = ref<string[]>([])
const npcList = ref<string[]>([])
const redlineList = ref<string[]>([])

const linesOf = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean)
const joinLines = (l: string[]): string => l.map((x) => x.trim()).filter(Boolean).join('\n')

function syncListsToSetting() {
  setting.houseRules = joinLines(houseRuleList.value)
  setting.npcs = joinLines(npcList.value)
  setting.redlines = joinLines(redlineList.value)
}

const preset = computed(() => RULE_PRESETS.find((r) => r.id === setting.system) || RULE_PRESETS[0])

// ── 团的基调：作者自定义标签（至多 4 个） ──
const toneInput = ref('')

function addTone(raw?: string) {
  const t = (raw ?? toneInput.value).trim().slice(0, 8)
  if (!t) return
  if (!setting.tones.includes(t) && setting.tones.length < 4) setting.tones.push(t)
  toneInput.value = ''
}
function removeTone(t: string) {
  const i = setting.tones.indexOf(t)
  if (i >= 0) setting.tones.splice(i, 1)
}

onMounted(async () => {
  suggestCode.value = genRoomCode()
  await refreshCampaigns()
  campaigns.value = hall.campaigns.map((c) => ({
    id: c.id, name: c.name, roomCode: c.roomCode, locked: c.locked, hasPassword: !!c.password,
  }))
  // 模组库：本机 IndexedDB（AI 工作台「剧情模组」页签可生成/导入入库）
  moduleList.value = await db.modules.orderBy('updatedAt').reverse().toArray()
})

// ── 剧情模组：从模组库挂载，或导入一次性 JSON（章节大纲/路线/结局/命运转盘随机表）──
const moduleList = ref<GameModule[]>([])
const moduleId = ref('') // '' = 不用模组
const importedModule = ref<GameModule | null>(null) // 导入的一次性模组（本局使用，不入库）
const moduleInput = ref<HTMLInputElement | null>(null)
const pickedModule = computed<GameModule | null>(
  () => importedModule.value || moduleList.value.find((m) => m.id === moduleId.value) || null,
)

function pickModuleFile() { moduleInput.value?.click() }

async function onModulePicked(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    const m = normalizeModule(JSON.parse(await f.text()))
    if (!m) {
      createError.value = '不是有效的模组文件：没找到可识别的章节/结局/随机表内容'
    } else {
      importedModule.value = m
      moduleId.value = ''
      createError.value = ''
    }
  } catch {
    createError.value = '模组文件解析失败：请确认是导出的模组 JSON'
  }
  ;(e.target as HTMLInputElement).value = ''
}

function clearModule() {
  importedModule.value = null
  moduleId.value = ''
}

// ── AI 锻造模组（复用工作台锻造台组件；用 KP 模型配置，保存入库后自动回填选中）──
const showForge = ref(false)
const forgeKey = ref(0) // 每次打开重挂载，草稿状态归零
const forgeCfg = computed<ModuleAiConfig | null>(() => {
  const c = kpApiConfig()
  return c ? { baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model } : null
})

function openForge() {
  forgeKey.value += 1
  showForge.value = true
}

async function onForgeSaved(m: GameModule) {
  moduleList.value = await db.modules.orderBy('updatedAt').reverse().toArray()
  importedModule.value = null
  moduleId.value = m.id
  showForge.value = false
}

// ── AI 辅助：简洁 = 房间名+简介；详细 = 全套开团设定 ──
const aiIdea = ref('')
const aiBusy = ref(false)

async function aiFill() {
  if (aiBusy.value) return
  aiBusy.value = true
  createError.value = ''
  try {
    if (mode.value === 'pro') {
      const idea = await aiAssistCampaign(aiIdea.value)
      form.title = idea.title
      form.desc = idea.desc
      Object.assign(setting, idea.setting)
      houseRuleList.value = linesOf(idea.setting.houseRules)
      npcList.value = linesOf(idea.setting.npcs)
      redlineList.value = linesOf(idea.setting.redlines)
    } else {
      const idea = await aiAssistRoom(aiIdea.value)
      form.title = idea.title
      form.desc = idea.desc
    }
  } catch (err) {
    createError.value = (err as Error).message
  } finally {
    aiBusy.value = false
  }
}

// ── 封面 ──
function pickCover() { coverInput.value?.click() }

async function onCoverPicked(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  if (f.size > 150 * 1024) {
    createError.value = '封面图片请小于 150KB'
    ;(e.target as HTMLInputElement).value = ''
    return
  }
  form.cover = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(f)
  })
  ;(e.target as HTMLInputElement).value = ''
}

// ── 提交 ──
async function submit() {
  if (creating.value) return
  const profile = personaProfile()
  if (!profile) { createError.value = '还没有人设：请先点「人设」创建你的身份'; return }
  if (form.locked && !form.password.trim()) { createError.value = '已选择上锁，请输入房间密码'; return }
  creating.value = true
  createError.value = ''
  syncListsToSetting()
  const meta: CreateMeta = {
    title: form.title.trim() || '未命名房间',
    desc: form.desc.trim(),
    cover: form.cover,
    locked: form.locked,
    setting: mode.value === 'pro' && !isEmptySetting(setting) ? { ...setting, tones: [...setting.tones] } : null,
    module: mode.value === 'pro' ? pickedModule.value : null,
    relay: relayMode.value,
  }
  await connect({
    mode: 'create',
    code: suggestCode.value,
    profile,
    meta,
    password: form.locked ? form.password.trim() : '',
  })
  creating.value = false
  if (hall.state.phase === 'error' || hall.state.phase === 'closed') createError.value = hall.state.error
}

async function resumeCampaign(c: { id: string; name: string; roomCode: string; locked: boolean; hasPassword: boolean }) {
  const camp = hall.campaigns.find((x) => x.id === c.id)
  if (!camp) return
  const profile = personaProfile()
  if (!profile) { createError.value = '还没有人设：请先点「人设」创建你的身份'; return }
  creating.value = true
  createError.value = ''
  await connect({
    mode: 'create',
    code: camp.roomCode,
    profile,
    campaignId: camp.id,
    meta: { title: camp.name, desc: camp.desc, cover: camp.cover, locked: camp.locked, setting: camp.setting },
    password: camp.password,
  })
  creating.value = false
  if (hall.state.phase === 'error' || hall.state.phase === 'closed') createError.value = hall.state.error
}

// 进房成功后由父层收起弹窗（连接异步完成）
watch(() => hall.state.phase, (p) => { if (p === 'room') emit('close') })
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal-box">
      <div class="modal-head">
        <h3>创建房间</h3>
        <!-- 简洁 / 详细 滑块 -->
        <div class="mode-switch" :class="{ pro: mode === 'pro' }" role="radiogroup" aria-label="创建模式">
          <div class="mode-thumb" />
          <button type="button" :class="{ on: mode === 'simple' }" @click="mode = 'simple'">简洁</button>
          <button type="button" :class="{ on: mode === 'pro' }" @click="mode = 'pro'">详细</button>
        </div>
        <button class="modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <p class="mode-hint">
          <Info :size="13" style="vertical-align: -2px" />
          <template v-if="mode === 'pro'">
            详细模式：填写完整开团设定（规则系统、世界观、模组梗概、NPC、房规、内容红线…），KP 会全程依据设定主持
          </template>
          <template v-else>
            简洁模式：只填房间名与简介，够开一桌自由团；想要完整世界观与规则预设，切到「详细」
          </template>
        </p>

        <!-- 恢复战役（置顶）：数据存在本机 IndexedDB，退出不丢；全量列表见大厅「我的团」 -->
        <div v-if="campaigns.length" class="card-panel" style="margin-bottom: 14px; padding: 11px 14px">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px">
            <div style="font-size: 0.8rem; font-weight: 700">最近开过的团</div>
            <span class="group-sub">恢复沿用原房间码与密码 · 全部战役见工具栏「我的团」</span>
          </div>
          <button v-for="c in campaigns.slice(0, 3)" :key="c.id" class="btn sm" style="width: 100%; justify-content: flex-start; margin-bottom: 6px" @click="resumeCampaign(c)">
            {{ c.name }} · {{ c.roomCode.toUpperCase() }} <span v-if="c.locked" class="hall-tag" style="margin-left: auto">🔒</span>
          </button>
        </div>

        <div class="card-panel" style="margin-bottom: 14px; padding: 12px 14px; background: var(--bg-2); border-style: dashed">
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px">
            <Wand2 :size="16" style="color: var(--accent); flex-shrink: 0" />
            <div style="font-size: 0.82rem; font-weight: 700">AI 辅助创作{{ mode === 'pro' ? '（全套设定）' : '' }}</div>
          </div>
          <div style="display: flex; gap: 8px">
            <input
              v-model="aiIdea"
              class="input"
              style="flex: 1; font-size: 0.82rem"
              :placeholder="mode === 'pro' ? '一句话描述你想开的团，AI 生成房间名、简介与全套开团设定…' : '一句话描述你想开的团，AI 帮你写房间名和简介…'"
              @keyup.enter="aiFill"
            />
            <button class="btn sm primary" style="white-space: nowrap" :disabled="aiBusy" @click="aiFill">
              {{ aiBusy ? (mode === 'pro' ? '备团中…' : '生成中…') : 'AI 生成' }}
            </button>
          </div>
          <div style="font-size: 0.72rem; color: var(--text-2); margin-top: 6px">
            {{ mode === 'pro' ? '如：周五晚带新人跑 COC 雾镇调查团，恐怖氛围，4 人——AI 会补全世界观、模组梗概、NPC 与房规' : '如：周五晚带新人跑 COC 雾镇调查团，恐怖氛围，4 人' }}
          </div>
        </div>

        <div class="field">
          <label>房间可见性 <span class="group-sub">决定房间开在哪个中继上，创建后不可改</span></label>
          <div class="mode-switch relay-switch" role="radiogroup" aria-label="房间可见性">
            <div class="mode-thumb" :class="{ right: relayMode === 'private' }" />
            <button type="button" :class="{ on: relayMode === 'shared' }" @click="relayMode = 'shared'">共享大厅</button>
            <button type="button" :class="{ on: relayMode === 'private' }" @click="relayMode = 'private'">私人中继</button>
          </div>
          <div class="relay-hint">
            <template v-if="relayMode === 'shared'">
              开在公共共享中继（{{ DEFAULT_HALL_RELAY }}）：所有人都能在「共享大厅」列表里看到，点击或凭密码进入
            </template>
            <template v-else>
              开在你自己的中继上：公共大厅看不到，朋友只能通过房间内的<b>「邀请」</b>按钮生成的链接进入
              <span v-if="!hasOwnRelay" class="relay-warn">
                尚未配置私人中继——将使用本页自身地址（仅限本地/自托管同源部署；GitHub Pages 部署请先在「模型 → 高级」填写我的中继）
              </span>
            </template>
          </div>
        </div>

        <div class="field">
          <label>房间名（会显示在大厅列表）</label>
          <input v-model="form.title" class="input" maxlength="40" placeholder="如：周五夜 · 万智宅邸" />
        </div>
        <div class="field">
          <label>房间简介</label>
          <textarea v-model="form.desc" class="textarea" rows="2" maxlength="200" placeholder="题材、规则、人数预期…" />
        </div>

        <!-- ── 详细模式：开团设定 ── -->
        <template v-if="mode === 'pro'">
          <div class="group-title">开团设定 <span class="group-sub">注入 AI KP 的主持设定，随战役保存</span></div>

          <div class="two-col">
            <div class="field">
              <label>规则系统</label>
              <select v-model="setting.system" class="input">
                <option v-for="r in RULE_PRESETS" :key="r.id" :value="r.id">{{ r.name }}</option>
              </select>
            </div>
            <div v-if="setting.system === 'custom'" class="field">
              <label>规则名称</label>
              <input v-model="setting.systemCustom" class="input" maxlength="30" placeholder="如：野火 GR、无限恐怖" />
            </div>
            <div v-else class="field">
              <label>时代背景</label>
              <input v-model="setting.era" class="input" maxlength="40" :list="`era-list-${preset.id}`" placeholder="选择或填写" />
              <datalist :id="`era-list-${preset.id}`">
                <option v-for="e in preset.eras" :key="e" :value="e" />
              </datalist>
            </div>
          </div>
          <div class="two-col">
            <div class="field">
              <label>人数预期（2-8）</label>
              <input v-model.number="setting.players" class="input" type="number" min="2" max="8" />
            </div>
            <div class="field">
              <label>KP 风格</label>
              <select v-model="setting.kpStyle" class="input">
                <option v-for="k in KP_STYLES" :key="k.id" :value="k.id">{{ k.name }}</option>
              </select>
            </div>
          </div>

          <div class="field">
            <label>团的基调 <span class="group-sub">作者自定义，至多 4 个，回车添加</span></label>
            <div class="tone-input-row">
              <input
                v-model="toneInput"
                class="input"
                maxlength="8"
                placeholder="起一个基调短词，如：雾镇怪谈、蒸汽朋克…"
                @keyup.enter="addTone()"
              />
              <button class="btn sm" style="white-space: nowrap" @click="addTone()">添加</button>
            </div>
            <div v-if="setting.tones.length" class="tone-tags">
              <span v-for="t in setting.tones" :key="t" class="chip on tone-tag">
                {{ t }}
                <button class="tone-x" :title="`移除 ${t}`" @click="removeTone(t)">✕</button>
              </span>
            </div>
            <div class="tone-suggest">
              <span class="tone-suggest-label">点选常用：</span>
              <button
                v-for="t in TONE_OPTIONS"
                :key="t"
                type="button"
                class="chip tone-chip"
                :class="{ on: setting.tones.includes(t) }"
                :disabled="setting.tones.length >= 4 && !setting.tones.includes(t)"
                @click="addTone(t)"
              >{{ t }}</button>
            </div>
          </div>

          <div class="field">
            <label>世界观与舞台（KP 现场速查的骨架，不堆细节）</label>
            <textarea v-model="setting.world" class="textarea" rows="3" maxlength="400" placeholder="这是一个怎样的世界？舞台在哪？正在发生什么？…" />
          </div>
          <div class="field">
            <label>模组 / 剧情梗概 <span class="group-sub">KP 秘密：含真相与转折，不会剧透给玩家</span></label>
            <textarea v-model="setting.module" class="textarea" rows="3" maxlength="400" placeholder="故事的起因、真相、可用的转折点…" />
          </div>
          <div class="field">
            <label>剧情模组（结构化） <span class="group-sub">可选：章节大纲+规划路线+结局表+命运转盘随机表；KP 按章节推进，全员侧栏实时看进度与结局图鉴</span></label>
            <select v-model="moduleId" class="input" @change="importedModule = null">
              <option value="">不使用模组（自由即兴团）</option>
              <option v-for="m in moduleList" :key="m.id" :value="m.id">
                {{ m.name }}（{{ m.chapters.length }} 章 · {{ m.endings.length }} 结局{{ m.tables.length ? ` · ${m.tables.length} 转盘` : '' }}）
              </option>
            </select>
            <div style="display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap: wrap">
              <button class="btn sm primary" :title="forgeCfg ? 'AI 生成一套新模组，可编辑后入库挂载' : '先在跑团「模型设置」或「更多 → 语言模型」配置 API'" @click="openForge"><Sparkles :size="13" />AI 锻造新模组</button>
              <button class="btn sm" @click="pickModuleFile">导入模组 JSON</button>
              <button v-if="pickedModule" class="btn sm ghost" @click="clearModule">清除已选</button>
              <input ref="moduleInput" type="file" accept="application/json,.json" hidden @change="onModulePicked" />
            </div>
            <div v-if="importedModule" class="group-sub" style="display: block; margin-top: 6px">
              已导入「{{ importedModule.name }}」——只用于本局，不存入模组库（想入库可到 AI 工作台「剧情模组」导入）
            </div>
            <div v-if="pickedModule" class="relay-hint" style="margin-top: 8px">
              {{ pickedModule.synopsis || '（模组没有写简介）' }}
            </div>
          </div>
          <div class="field">
            <label>开场场景（KP 的开局指引：玩家此刻在哪、正在做什么）</label>
            <textarea v-model="setting.opening" class="textarea" rows="2" maxlength="300" placeholder="如：暴雨夜，你们的汽车抛锚在雾镇外的公路边，镇口的灯忽明忽暗…" />
          </div>
          <div class="field">
            <label>开场白 <span class="group-sub">可留空；填了会在建团后自动作为第一段旁白发到剧情流</span></label>
            <textarea v-model="setting.openingNarration" class="textarea" rows="3" maxlength="500" placeholder="如：雨下了整整三天。今晚，长途汽车在雾镇外抛锚——你们人人湿透，唯一的亮光来自镇口那盏忽明忽暗的灯。下车前，司机回头说了一句：「别在镇上待到天黑。」" />
          </div>
          <div class="field">
            <label>关键 NPC <span class="group-sub">一条一个：名字（身份：动机/秘密）</span></label>
            <div v-for="(_, i) in npcList" :key="`npc-${i}`" class="entry-row">
              <input
                v-model="npcList[i]"
                class="input"
                maxlength="80"
                :placeholder="i === 0 ? '如：镇长 埃德蒙（体面人：镇子的繁荣靠掩盖真相）' : '如：旅店老板娘 玛莎（线人：知道失踪案的日期规律）'"
              />
              <button class="btn sm ghost entry-del" title="删除这条 NPC" @click="npcList.splice(i, 1)">✕</button>
            </div>
            <button class="btn sm entry-add" @click="npcList.push('')">＋ 添加一个 NPC</button>
          </div>

          <div class="group-title">房规与边界</div>
          <div class="field">
            <label>房规 <span class="group-sub">一条一条加，优先级高于默认规则</span></label>
            <div v-for="(_, i) in houseRuleList" :key="`hr-${i}`" class="entry-row">
              <input
                v-model="houseRuleList[i]"
                class="input"
                maxlength="100"
                :placeholder="i === 0 ? '如：理智归零不即死改为濒疯' : '如：大失败可花幸运重骰一次'"
              />
              <button class="btn sm ghost entry-del" title="删除这条房规" @click="houseRuleList.splice(i, 1)">✕</button>
            </div>
            <button class="btn sm entry-add" @click="houseRuleList.push('')">＋ 添加一条房规</button>
          </div>
          <div class="field">
            <label>内容红线 <span class="group-sub">一条一条加，本次回避的题材，全员受约束</span></label>
            <div v-for="(_, i) in redlineList" :key="`rl-${i}`" class="entry-row">
              <input
                v-model="redlineList[i]"
                class="input"
                maxlength="60"
                placeholder="如：回避虐待、儿童伤害"
              />
              <button class="btn sm ghost entry-del" title="删除这条红线" @click="redlineList.splice(i, 1)">✕</button>
            </div>
            <button class="btn sm entry-add" @click="redlineList.push('')">＋ 添加一条红线</button>
          </div>
          <div class="field">
            <label>场景 / 地图备注（v1 文字团的场景速查，帮 KP 保持方位连贯）</label>
            <textarea v-model="setting.sceneNotes" class="textarea" rows="2" maxlength="300" placeholder="如：宅邸三层——一层大厅/厨房/书房，二层卧室×4（402 反锁），三层阁楼锁着；地下酒窖通后院枯井" />
          </div>
        </template>

        <div class="field">
          <label>封面（可选，≤150KB）</label>
          <div style="display: flex; gap: 10px; align-items: center">
            <div
              style="width: 64px; height: 64px; border-radius: 12px; overflow: hidden; background: var(--bg-3); display: flex; align-items: center; justify-content: center; cursor: pointer; border: 1px dashed var(--line-strong)"
              @click="pickCover"
            >
              <img v-if="form.cover" :src="form.cover" style="width: 100%; height: 100%; object-fit: cover" alt="" />
              <template v-else>＋</template>
            </div>
            <input ref="coverInput" type="file" accept="image/*" hidden @change="onCoverPicked" />
            <button v-if="form.cover" class="btn sm" @click="form.cover = ''">移除封面</button>
          </div>
        </div>

        <div class="field">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer">
            <input v-model="form.locked" type="checkbox" style="width: auto" />
            上锁房间（大厅展示为「已上锁」，凭密码进入）
          </label>
          <input v-if="form.locked" v-model="form.password" class="input" type="password" maxlength="40" placeholder="房间密码（只存在你本机，服务器只存校验散列）" />
        </div>
        <div v-if="createError" class="danger-box">{{ createError }}</div>
        <div style="display: flex; justify-content: flex-end; gap: 10px">
          <button class="btn" @click="emit('close')">取消</button>
          <button class="btn primary" :disabled="creating" @click="submit">
            <Lock v-if="form.locked" :size="13" style="margin-right: 4px" />
            {{ creating ? '进入中…' : `创建并进入（${suggestCode.toUpperCase()}）` }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- AI 锻造剧情模组：叠在创建弹窗（z-index 100）之上的宽弹窗；保存入库后自动回填选中并关闭 -->
  <div v-if="showForge" class="modal-mask" style="z-index: 110" @click.self="showForge = false">
    <div class="modal-box wide" style="max-height: 88vh">
      <div class="modal-head">
        <h3>AI 锻造剧情模组</h3>
        <button class="modal-close" @click="showForge = false">✕</button>
      </div>
      <div class="modal-body" style="max-height: calc(88vh - 64px); overflow-y: auto">
        <AiModuleForge :key="forgeKey" :cfg="forgeCfg" @saved="onForgeSaved" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.mode-switch {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px;
  width: 148px;
  user-select: none;
}
.mode-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: calc(50% - 3px);
  height: calc(100% - 6px);
  border-radius: 999px;
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.85), rgba(99, 102, 241, 0.85));
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.mode-switch.pro .mode-thumb { transform: translateX(100%); }
.mode-switch button {
  position: relative;
  z-index: 1;
  background: none;
  border: none;
  color: var(--text-2);
  font-size: 0.74rem;
  font-weight: 700;
  padding: 4px 0;
  cursor: pointer;
  border-radius: 999px;
  transition: color 0.15s;
}
.mode-switch button.on { color: #fff; }
html[data-theme='light'] .mode-switch button.on { color: #fff; }
.mode-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.74rem;
  color: var(--text-2);
  background: rgba(139, 92, 246, 0.07);
  border: 1px solid rgba(139, 92, 246, 0.18);
  border-radius: 10px;
  padding: 7px 10px;
  margin: 0 0 14px;
  line-height: 1.5;
}
.mode-hint svg { flex-shrink: 0; color: var(--accent); }

/* 房间可见性：共享 / 私人 */
.relay-switch { width: 176px; margin-bottom: 8px; }
.relay-switch .mode-thumb { background: linear-gradient(135deg, rgba(59, 130, 246, 0.8), rgba(16, 185, 129, 0.8)); }
.relay-switch .mode-thumb.right { transform: translateX(100%); }
.relay-hint {
  font-size: 0.72rem; color: var(--text-2); line-height: 1.6;
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: 10px; padding: 7px 10px;
}
.relay-hint b { color: var(--accent-soft); }
.relay-warn { display: block; margin-top: 4px; color: var(--danger); }
.group-title {
  font-size: 0.8rem;
  font-weight: 800;
  color: var(--text-1);
  margin: 18px 0 10px;
  padding-left: 9px;
  border-left: 3px solid var(--accent);
}
.group-sub { font-size: 0.7rem; font-weight: 400; color: var(--text-2); margin-left: 4px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.two-col .field { margin-bottom: 12px; }

/* 团的基调：自定义标签输入 */
.tone-input-row { display: flex; gap: 8px; }
.tone-input-row .input { flex: 1; }
.tone-tags { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
.tone-tag { display: inline-flex; align-items: center; gap: 6px; font-size: 0.74rem; padding: 4px 10px; }
.tone-x {
  background: none; border: none; color: inherit; opacity: 0.65;
  cursor: pointer; font-size: 0.7rem; padding: 0 2px; line-height: 1;
}
.tone-x:hover { opacity: 1; }
.tone-suggest { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.tone-suggest-label { font-size: 0.7rem; color: var(--text-2); }
.tone-chip { cursor: pointer; font-size: 0.7rem; padding: 3px 9px; transition: all 0.15s; opacity: 0.85; }
.tone-chip:hover:not(:disabled) { border-color: var(--accent); color: var(--text-0); opacity: 1; }
.tone-chip:disabled { opacity: 0.4; cursor: not-allowed; }

/* 逐条清单（房规 / NPC / 红线）：一条一行，可增删 */
.entry-row { display: flex; gap: 8px; margin-bottom: 7px; }
.entry-row .input { flex: 1; }
.entry-del { flex-shrink: 0; }
.entry-add { margin-top: 2px; }
@media (max-width: 560px) {
  .two-col { grid-template-columns: 1fr; }
}
</style>
