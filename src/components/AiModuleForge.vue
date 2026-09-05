<script setup lang="ts">
/**
 * 剧情模组锻造：一句话构想 → AI 生成整套模组（章节大纲/规划路线/结局表/命运转盘随机表），
 * 或导入模组 JSON / 从库中取出一本，可视化编辑后存入本机模组库（db.modules），开团时挂载。
 * API 配置由父级注入（cfg prop）：AI 工作台传主站模型选择，创建房间弹窗传 KP 模型配置；
 * 保存入库后 emit('saved', m) 供父级回填选中。
 */
import { onMounted, ref } from 'vue'
import { Download, FolderOpen, Plus, Save, Trash2, Upload, Wand2 } from 'lucide-vue-next'
import { NButton } from 'naive-ui'
import { db, downloadJson } from '../db'
import { aiGenerateModule, normalizeModule, MAX_CHAPTERS, MAX_ENDINGS, MAX_ROUTES, MAX_TABLES, type GameModule, type ModuleAiConfig, type ModuleEndingKind } from '../lib/hall/module'
import { uuid } from '../lib/id'
import { toast } from '../lib/toast'

const props = defineProps<{ cfg: ModuleAiConfig | null }>()
const emit = defineEmits<{ saved: [m: GameModule] }>()

// ── 模组库 ──
const library = ref<GameModule[]>([])
async function refreshLibrary() {
  library.value = await db.modules.orderBy('updatedAt').reverse().toArray()
}
onMounted(() => void refreshLibrary())

// ── 编辑中的模组草稿 ──
const draft = ref<GameModule | null>(null)
const error = ref('')
const busy = ref(false)

const idea = ref('')
const wantChapters = ref(5)
const wantTables = ref(true)

const ENDING_KINDS: { value: ModuleEndingKind; label: string }[] = [
  { value: 'normal', label: '普通结局' },
  { value: 'good', label: '好结局' },
  { value: 'bad', label: '坏结局' },
  { value: 'secret', label: '隐藏结局' },
]

async function genModule() {
  if (busy.value) return
  if (!idea.value.trim()) { error.value = '先用一句话描述你想要的模组'; return }
  if (!props.cfg) { error.value = '请先配置 API 与模型（跑团用「模型设置」，主站用「语言模型」）'; return }
  busy.value = true
  error.value = ''
  try {
    const m = await aiGenerateModule(props.cfg, idea.value, { chapters: wantChapters.value, withActionTable: wantTables.value })
    draft.value = { ...m, id: '' }
    toast.success('模组已生成，检查后保存入库')
  } catch (err) {
    error.value = `生成失败：${(err as Error).message}`
  } finally {
    busy.value = false
  }
}

// ── 导入 / 导出 / 库操作 ──
const fileInput = ref<HTMLInputElement | null>(null)

async function onFilePicked(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    const m = normalizeModule(JSON.parse(await f.text()))
    if (!m) { error.value = '不是有效的模组文件：没找到可识别的章节/结局/随机表'; return }
    draft.value = m
    error.value = ''
    toast.success(`已载入「${m.name}」，可编辑后保存`)
  } catch {
    error.value = '模组文件解析失败：请确认是导出的模组 JSON'
  }
  ;(e.target as HTMLInputElement).value = ''
}

function editFromLibrary(m: GameModule) {
  draft.value = JSON.parse(JSON.stringify(m)) as GameModule
  error.value = ''
}

async function saveDraft() {
  if (!draft.value) return
  const m = normalizeModule(draft.value)
  if (!m) { error.value = '模组内容为空：至少要有名字和一点章节/结局/随机表'; return }
  const saved: GameModule = { ...m, id: m.id || uuid(), createdAt: m.createdAt || Date.now(), updatedAt: Date.now() }
  await db.modules.put(saved)
  await refreshLibrary()
  draft.value = JSON.parse(JSON.stringify(saved)) as GameModule
  emit('saved', saved)
  toast.success(`模组「${saved.name}」已入库——开团时可在详细模式里挂载`)
}

function exportDraft() {
  if (!draft.value) return
  downloadJson(draft.value, `rp-module-${draft.value.name || '未命名'}.json`)
}

async function removeFromLibrary(id: string) {
  const m = library.value.find((x) => x.id === id)
  if (!m || !confirm(`删除模组「${m.name}」？已挂载它的战役不受影响。`)) return
  await db.modules.delete(id)
  await refreshLibrary()
}

function newBlank() {
  draft.value = {
    id: '', name: '', synopsis: '',
    chapters: [{ id: 'c1', title: '', summary: '', goal: '' }],
    routes: [], endings: [], tables: [],
    createdAt: 0, updatedAt: 0,
  }
}

// ── 草稿编辑辅助（条目增删） ──
function addChapter() {
  if (!draft.value || draft.value.chapters.length >= MAX_CHAPTERS) return
  draft.value.chapters.push({ id: `c${Date.now() % 100000}`, title: '', summary: '', goal: '' })
}
function addRoute() {
  if (!draft.value || draft.value.routes.length >= MAX_ROUTES) return
  draft.value.routes.push({ id: `r${Date.now() % 100000}`, name: '', entry: '', summary: '' })
}
function addEnding() {
  if (!draft.value || draft.value.endings.length >= MAX_ENDINGS) return
  draft.value.endings.push({ id: `e${Date.now() % 100000}`, name: '', kind: 'normal', condition: '', epilogue: '' })
}
function addTable() {
  if (!draft.value || draft.value.tables.length >= MAX_TABLES) return
  draft.value.tables.push({ id: `t${Date.now() % 100000}`, name: '', usage: 'create', entries: [{ label: '', weight: 1, note: '' }] })
}
function addEntry(ti: number) {
  const t = draft.value?.tables[ti]
  if (!t || t.entries.length >= 24) return
  t.entries.push({ label: '', weight: 1, note: '' })
}
const moduleSubtitle = (m: GameModule) =>
  `${m.chapters.length} 章 · ${m.routes.length} 路线 · ${m.endings.length} 结局 · ${m.tables.length} 转盘`
</script>

<template>
  <div>
    <!-- ── 生成 / 导入台 ── -->
    <div class="mforge-panel">
      <div class="composer">
        <div class="composer-head">
          <span class="composer-title">描述你想要的剧情模组</span>
          <span class="composer-desc">AI 生成章节大纲、路线分支、结局表与命运转盘随机表</span>
        </div>
        <textarea v-model="idea" class="composer-input" rows="6" placeholder="例如：以民国雾镇为舞台的连环失踪案调查团，出身决定站在镇警还是秘密教团一边，终章在祭典之夜收束……" />
        <div class="composer-foot">
          <label class="mforge-param">章节数
            <input v-model.number="wantChapters" type="number" min="3" max="10" class="input" style="width: 64px; padding: 4px 8px" />
          </label>
          <label class="mforge-param"><input v-model="wantTables" type="checkbox" style="width: auto" />带行动遭遇转盘</label>
          <div style="flex: 1" />
          <NButton type="primary" size="large" :loading="busy" @click="genModule">
            <template #icon><Wand2 /></template>AI 生成模组
          </NButton>
        </div>
      </div>
      <div class="mforge-row" style="margin-top: 10px">
        <button class="btn sm" @click="fileInput?.click()"><Upload :size="13" />导入模组 JSON</button>
        <button class="btn sm ghost" @click="newBlank"><Plus :size="13" />从空白新建</button>
        <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFilePicked" />
        <span class="mforge-tip">导入/新建的模组先进入下方编辑区，确认后存入模组库</span>
      </div>
    </div>

    <div v-if="error" class="danger-box" style="margin-top: 12px">{{ error }}</div>

    <!-- ── 模组库 ── -->
    <div v-if="library.length" class="mforge-panel" style="margin-top: 14px">
      <div class="mforge-lib-head"><FolderOpen :size="15" />模组库（本机 {{ library.length }} 本）</div>
      <div v-for="m in library" :key="m.id" class="mforge-lib-item">
        <div style="flex: 1; min-width: 0">
          <b>{{ m.name }}</b>
          <span class="mforge-lib-sub">{{ moduleSubtitle(m) }}</span>
          <div class="mforge-lib-syn">{{ m.synopsis || '（没有写简介）' }}</div>
        </div>
        <button class="btn sm" @click="editFromLibrary(m)">编辑</button>
        <button class="btn sm ghost" title="导出为 JSON 分享" @click="downloadJson(m, `rp-module-${m.name}.json`)"><Download :size="13" /></button>
        <button class="btn sm ghost danger" title="删除" @click="removeFromLibrary(m.id)"><Trash2 :size="13" /></button>
      </div>
    </div>

    <!-- ── 编辑区 ── -->
    <div v-if="draft" class="mforge-panel" style="margin-top: 14px">
      <div class="mforge-lib-head"><Save :size="15" />模组编辑</div>

      <div class="grid-2">
        <div class="field"><label>模组名</label><input v-model="draft.name" class="input" maxlength="60" placeholder="如：雾镇迷局" /></div>
      </div>
      <div class="field"><label>大致剧情（玩家可见的开局说明，也是 KP 掌握全貌的锚点）</label><textarea v-model="draft.synopsis" class="textarea" rows="3" maxlength="600" /></div>

      <div class="mforge-sec">章节大纲（KP 秘密节拍，按顺序推进）</div>
      <div v-for="(c, i) in draft.chapters" :key="i" class="mforge-item">
        <div class="mforge-item-head">
          <span class="mforge-idx">{{ i + 1 }}</span>
          <input v-model="c.title" class="input" maxlength="60" placeholder="章节名，如：抵达雾镇" />
          <button class="btn sm ghost danger" title="删除本章" @click="draft!.chapters.splice(i, 1)"><Trash2 :size="13" /></button>
        </div>
        <textarea v-model="c.summary" class="textarea" rows="2" maxlength="500" placeholder="本章剧情节拍/真相（KP 秘密）" style="margin-top: 8px" />
        <input v-model="c.goal" class="input" maxlength="160" placeholder="推进条件，如：集齐三条线索后进入下一章" style="margin-top: 8px" />
      </div>
      <button class="btn sm mforge-add" :disabled="draft.chapters.length >= MAX_CHAPTERS" @click="addChapter"><Plus :size="13" />添加章节</button>

      <div class="mforge-sec">规划路线（出身/关键选择触发的分支）</div>
      <div v-for="(r, i) in draft.routes" :key="i" class="mforge-item">
        <div class="grid-2">
          <div class="field" style="margin-bottom: 8px"><label>路线名</label><input v-model="r.name" class="input" maxlength="40" placeholder="如：反派线" /></div>
          <div class="field" style="margin-bottom: 8px"><label>进入条件</label><input v-model="r.entry" class="input" maxlength="160" placeholder="如：出身抽到咒灵/诅咒师" /></div>
        </div>
        <textarea v-model="r.summary" class="textarea" rows="2" maxlength="400" placeholder="此路线的剧情差异（敌我逆转、专属节拍）" />
        <div style="text-align: right; margin-top: 6px">
          <button class="btn sm ghost danger" @click="draft!.routes.splice(i, 1)"><Trash2 :size="13" />删除路线</button>
        </div>
      </div>
      <button class="btn sm mforge-add" :disabled="draft.routes.length >= MAX_ROUTES" @click="addRoute"><Plus :size="13" />添加路线</button>

      <div class="mforge-sec">结局表（条件达成即终局）</div>
      <div v-for="(e, i) in draft.endings" :key="i" class="mforge-item">
        <div class="grid-2">
          <div class="field" style="margin-bottom: 8px"><label>结局名</label><input v-model="e.name" class="input" maxlength="60" placeholder="如：雾散天明" /></div>
          <div class="field" style="margin-bottom: 8px"><label>类型</label>
            <select v-model="e.kind" class="input">
              <option v-for="k in ENDING_KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
            </select>
          </div>
        </div>
        <input v-model="e.condition" class="input" maxlength="200" placeholder="达成条件，如：祭典之夜战败" style="margin-bottom: 8px" />
        <textarea v-model="e.epilogue" class="textarea" rows="2" maxlength="300" placeholder="终章旁白锚点（KP 写结局时的提示）" />
        <div style="text-align: right; margin-top: 6px">
          <button class="btn sm ghost danger" @click="draft!.endings.splice(i, 1)"><Trash2 :size="13" />删除结局</button>
        </div>
      </div>
      <button class="btn sm mforge-add" :disabled="draft.endings.length >= MAX_ENDINGS" @click="addEnding"><Plus :size="13" />添加结局</button>

      <div class="mforge-sec">命运转盘（加权随机表；create=开局出身，action=行动遭遇）</div>
      <div v-for="(t, ti) in draft.tables" :key="ti" class="mforge-item">
        <div class="grid-2">
          <div class="field" style="margin-bottom: 8px"><label>转盘名</label><input v-model="t.name" class="input" maxlength="40" placeholder="如：出身转盘" /></div>
          <div class="field" style="margin-bottom: 8px"><label>用途</label>
            <select v-model="t.usage" class="input">
              <option value="create">开局出身（create）</option>
              <option value="action">行动/遭遇（action）</option>
              <option value="">通用</option>
            </select>
          </div>
        </div>
        <div v-for="(en, ei) in t.entries" :key="ei" class="mforge-entry">
          <input v-model="en.label" class="input" maxlength="60" placeholder="条目名" />
          <input v-model.number="en.weight" type="number" min="0" class="input" style="width: 74px; flex: none" title="权重" />
          <input v-model="en.note" class="input" maxlength="120" placeholder="抽中效果/备注" />
          <button class="btn sm ghost danger" title="删除条目" @click="t.entries.splice(ei, 1)"><Trash2 :size="13" /></button>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 8px">
          <button class="btn sm" @click="addEntry(ti)"><Plus :size="13" />添加条目</button>
          <div style="flex: 1" />
          <button class="btn sm ghost danger" @click="draft!.tables.splice(ti, 1)"><Trash2 :size="13" />删除转盘</button>
        </div>
      </div>
      <button class="btn sm mforge-add" :disabled="draft.tables.length >= MAX_TABLES" @click="addTable"><Plus :size="13" />添加转盘</button>

      <div class="aiw-actions" style="margin-top: 18px">
        <NButton type="primary" size="large" @click="saveDraft"><template #icon><Save /></template>保存到模组库</NButton>
        <NButton size="large" @click="exportDraft"><template #icon><Download /></template>导出 JSON</NButton>
        <NButton quaternary size="large" @click="draft = null">放弃编辑</NButton>
      </div>
    </div>

    <!-- ── 玩法说明 ── -->
    <div class="mforge-usage">
      <b>怎么用：</b>模组入库后，开团（详细模式）时在「剧情模组」里挂载。KP 会按章节推进剧情、自动跟踪当前章节/天数/路线；
      侧栏出现「剧情」进度面板（结局图鉴）与「命运转盘」面板（玩家开局抽出身后入场）；达成结局条件时 KP 写终章并点亮图鉴。
      出身转盘的条目尽量写清加成（如「咒灵：术式伤害+10%」），KP 会照着结算。
    </div>
  </div>
</template>

<style scoped>
/* 生成作曲台（与工作台同款观感；样式随组件自带，父页面无需提供） */
.composer {
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: var(--bg-1);
  transition: border-color 0.15s, box-shadow 0.15s;
  margin-bottom: 16px;
}
.composer:focus-within {
  border-color: rgba(139, 92, 246, 0.55);
  box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.12);
}
.composer-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; padding: 15px 18px 0; }
.composer-title { font-size: 1.08rem; font-weight: 800; color: var(--text-0); }
.composer-desc { font-size: 0.8rem; color: var(--text-2); }
.composer-input {
  display: block; width: 100%; border: none; outline: none; background: transparent;
  min-height: 130px; resize: vertical; padding: 12px 18px;
  font: inherit; font-size: 0.98rem; line-height: 1.75; color: var(--text-0);
}
.composer-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 12px 12px; }
.aiw-actions { margin-top: 16px; display: flex; gap: 10px; }

.mforge-panel {
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  padding: 18px 20px;
  background: rgba(13, 18, 32, 0.4);
}
html[data-theme='light'] .mforge-panel { background: #f6f8fd; }
.mforge-param { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--text-1); }
.mforge-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mforge-tip { font-size: 0.72rem; color: var(--text-2); }
.mforge-lib-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 0.95rem; font-weight: 700; margin-bottom: 12px; color: var(--text-1);
}
.mforge-lib-head svg { color: var(--accent); }
.mforge-lib-item {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-radius: 12px; margin-bottom: 8px;
  background: var(--bg-2); border: 1px solid var(--line);
}
.mforge-lib-sub { font-size: 0.72rem; color: var(--text-2); margin-left: 8px; }
.mforge-lib-syn {
  font-size: 0.74rem; color: var(--text-2); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mforge-sec { font-size: 0.9rem; font-weight: 700; color: var(--text-1); margin: 20px 0 10px; padding-left: 9px; border-left: 3px solid var(--accent); }
.mforge-item {
  padding: 12px 14px; border-radius: 12px; margin-bottom: 10px;
  background: var(--bg-2); border: 1px solid var(--line);
}
.mforge-item-head { display: flex; align-items: center; gap: 10px; }
.mforge-idx {
  width: 26px; height: 26px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-grad); color: #fff; font-size: 0.78rem; font-weight: 700;
}
.mforge-add { margin-bottom: 6px; }
.mforge-entry { display: flex; gap: 8px; margin-bottom: 7px; }
.mforge-entry .input:first-child { flex: 1.1; }
.mforge-entry .input:nth-child(3) { flex: 1.6; }
.mforge-usage {
  margin-top: 14px; font-size: 0.78rem; color: var(--text-2); line-height: 1.8;
  background: rgba(139, 92, 246, 0.07); border: 1px solid rgba(139, 92, 246, 0.18);
  border-radius: 10px; padding: 10px 14px;
}
.mforge-usage b { color: var(--accent-soft); }
.btn.ghost.danger:hover { color: var(--danger); border-color: var(--danger); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 860px) { .grid-2 { grid-template-columns: 1fr; } .mforge-entry { flex-wrap: wrap; } }
</style>
