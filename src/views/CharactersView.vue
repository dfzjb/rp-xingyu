<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  LibraryBig, Search, Upload, Plus, Pencil, FileJson, ImageDown, Trash2, Sparkles, Wand2, Star,
} from 'lucide-vue-next'
import { NTabs, NTabPane } from 'naive-ui'
import WorldBookEditor from '../components/WorldBookEditor.vue'
import RegexEditor from '../components/RegexEditor.vue'
import { useCharactersStore } from '../stores/characters'
import { useChatStore } from '../stores/chat'
import type { CharacterCard } from '../types'
import { importCardFile, oursCardToSt, buildPngCard } from '../lib/cardio'
import { normalizeUiTemplates } from '../lib/uitemplate'
import { downloadJson, restoreAll } from '../db'
import { importChatJsonlAuto } from '../lib/migrate'

const emit = defineEmits<{ (e: 'open-ai-workshop'): void }>()

const characters = useCharactersStore()
const chat = useChatStore()

const search = ref('')
const importing = ref('')
const importError = ref('')

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return characters.list
  return characters.list.filter(
    (c) => c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q),
  )
})

// ── 导入：按扩展名/内容自动路由 ──
// .jsonl → 聊天记录（旧版导出/酒馆导出，按角色名自动挂载）
// .json  → 新站完整备份 / 旧版备份（含聊天）/ 角色卡 JSON
// .png   → 角色卡
async function onImportFiles(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files?.length) return
  importError.value = ''
  importing.value = '导入中…'
  const notes: string[] = []
  for (const f of Array.from(files)) {
    try {
      const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
      if (ext === '.jsonl') {
        const report = await importChatJsonlAuto(await f.text(), f.name.replace(/\.jsonl$/i, ''))
        await Promise.all([characters.load(), chat.load()])
        const total = report.chats + report.branches
        notes.push(`${f.name}：导入 ${total} 个会话 / ${report.messages} 条消息${report.warnings.length ? '（⚠ ' + report.warnings.join('；') + '）' : ''}`)
        continue
      }
      if (ext === '.json') {
        const obj = JSON.parse(await f.text())
        if ((obj as { format?: string }).format === 'rp-site-backup') {
          // 新站原生完整备份：整体恢复并刷新
          if (!confirm('恢复该备份将覆盖当前全部本地数据，确定继续？')) continue
          await restoreAll(obj)
          importing.value = '完整备份已恢复，即将刷新…'
          setTimeout(() => location.reload(), 900)
          return
        }
        try {
          // 旧版备份 / 平面键值表：映射写入（不覆盖已有数据）
          const { parseLegacyBackupFile, migrateLegacyData } = await import('../lib/migrate')
          const keys = parseLegacyBackupFile(obj)
          const report = await migrateLegacyData(keys, f.name)
          await Promise.all([characters.load(), chat.load()])
          const total = report.characters + report.chats + report.branches + report.personas + report.kvKeys
          notes.push(`${f.name}：导入完成，共 ${total} 条记录${report.warnings.length ? '（⚠ ' + report.warnings.join('；') + '）' : ''}`)
          continue
        } catch { /* 不是备份文件，按角色卡 JSON 处理 */ }
      }
      // 角色卡（PNG / SillyTavern JSON）
      const card = await importCardFile(f)
      await characters.put(card)
      notes.push(`已导入角色卡：${card.name}`)
    } catch (err) {
      importError.value = `${importError.value ? importError.value + '\n' : ''}${f.name}：${(err as Error).message}`
    }
  }
  importing.value = notes.length ? notes.join('\n') : ''
  setTimeout(() => { if (importing.value && !importing.value.includes('即将刷新')) importing.value = '' }, 6000)
  ;(e.target as HTMLInputElement).value = ''
}

// ── 编辑器 ──
const editingCard = ref<CharacterCard | null>(null)
const isNew = ref(false)
const avatarFileInput = ref<HTMLInputElement | null>(null)
const showAdvanced = ref(false)
const uiTemplatesJson = ref('[]')
const advancedError = ref('')

function openNew() {
  const card = characters.emptyCard()
  editingCard.value = card
  isNew.value = true
  showAdvanced.value = false
  uiTemplatesJson.value = '[]'
  advancedError.value = ''
}
function openEdit(c: CharacterCard) {
  const copy = JSON.parse(JSON.stringify(c)) as CharacterCard // 深拷贝编辑
  editingCard.value = copy
  isNew.value = false
  showAdvanced.value = false
  uiTemplatesJson.value = JSON.stringify(copy.uiTemplates || [], null, 2)
  advancedError.value = ''
}

function pickAvatar() { avatarFileInput.value?.click() }
async function onAvatarPicked(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f || !editingCard.value) return
  editingCard.value.avatar = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(f)
  })
  ;(e.target as HTMLInputElement).value = ''
}

function parseUiTemplates(): boolean {
  if (!editingCard.value) return false
  try {
    const parsed = JSON.parse(uiTemplatesJson.value || '[]')
    if (!Array.isArray(parsed)) throw new Error('必须是数组')
    editingCard.value.uiTemplates = normalizeUiTemplates(parsed)
    advancedError.value = ''
    return true
  } catch (err) {
    advancedError.value = `UI 模板 JSON 解析失败：${(err as Error).message}`
    return false
  }
}

async function saveCard() {
  if (!editingCard.value) return
  if (!editingCard.value.name.trim()) { alert('角色名不能为空'); return }
  if (showAdvanced.value && !parseUiTemplates()) return
  await characters.put(editingCard.value)
  editingCard.value = null
}

async function removeCard(c: CharacterCard) {
  const n = chat.sessionsOfChar(c.uuid).reduce((acc, s) => acc + Object.keys(s.nodes).length, 0)
  const msg = n
    ? `删除角色「${c.name}」及其 ${chat.sessionsOfChar(c.uuid).length} 个会话（${n} 条消息）？不可恢复！`
    : `删除角色「${c.name}」？`
  if (!confirm(msg)) return
  await characters.remove(c.uuid)
}

// ── 导出 ──
async function exportJson(c: CharacterCard) {
  downloadJson(oursCardToSt(c), `${c.name}.json`)
}
async function exportPng(c: CharacterCard) {
  if (!c.avatar.startsWith('data:image/png')) {
    alert('该卡没有 PNG 头像（头像为空或非 PNG），请用 JSON 导出')
    return
  }
  const bytes = await buildPngCard(c.avatar, oursCardToSt(c))
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${c.name}.png`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

async function startChat(c: CharacterCard) {
  await chat.openCharacter(c.uuid)
}

function onMouseMove(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  el.style.setProperty('--mx', `${e.clientX - r.left}px`)
  el.style.setProperty('--my', `${e.clientY - r.top}px`)
}
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner">
        <div class="page-toolbar">
          <div class="section-title" style="margin-bottom: 0">
            <LibraryBig /> 角色卡工坊
            <span class="chip violet" style="margin-left: 4px">{{ characters.list.length }}</span>
          </div>
          <div style="flex: 1" />
          <input v-model="search" class="input" style="max-width: 220px" placeholder="搜索名称 / 描述…" />
          <label class="btn" style="cursor: pointer" title="角色卡 PNG/JSON · 聊天记录 .jsonl · 备份 .json（自动识别）">
            <Upload />导入 PNG / JSON
            <input type="file" accept=".png,.json,.jsonl" multiple hidden @change="onImportFiles" />
          </label>
          <button class="btn" title="空白新建" @click="openNew"><Plus :size="15" /></button>
          <button class="btn primary" @click="emit('open-ai-workshop')"><Wand2 />AI 工作台</button>
        </div>

        <div v-if="importing" class="shiny-text" style="margin-bottom: 10px; white-space: pre-line">{{ importing }}</div>
        <div v-if="importError" class="danger-box" style="white-space: pre-line">{{ importError }}</div>

        <div class="char-grid">
          <div
            v-for="(c, i) in filtered"
            :key="c.uuid"
            class="char-card spotlight-card"
            :style="{ animationDelay: `${Math.min(i * 40, 320)}ms` }"
            @click="startChat(c)"
            @mousemove="onMouseMove"
          >
            <div class="cover">
              <img v-if="c.avatar" :src="c.avatar" alt="" loading="lazy" />
              <template v-else>{{ c.name.slice(0, 2) }}</template>
              <div class="cover-chips">
                <span v-if="(c.worldInfo || []).length" class="chip on">世界书 {{ c.worldInfo.length }}</span>
                <span v-if="(c.regexScripts || []).length" class="chip">正则 {{ c.regexScripts.length }}</span>
                <span v-if="(c.uiTemplates || []).length" class="chip">UI {{ c.uiTemplates.length }}</span>
              </div>
              <div v-if="c.fav" class="fav-badge" title="已收藏置顶"><Star :size="12" /></div>
              <div class="cover-title">{{ c.name }}</div>
              <div class="hover-actions" @click.stop>
                <button class="btn sm" @click="openEdit(c)"><Pencil :size="13" />编辑</button>
                <button class="btn sm" @click="exportJson(c)"><FileJson :size="13" />JSON</button>
                <button class="btn sm" @click="exportPng(c)"><ImageDown :size="13" />PNG</button>
                <button class="btn sm" :class="{ 'fav-on': c.fav }" @click="characters.toggleFav(c.uuid)">
                  <Star :size="13" class="star-ic" :class="{ faved: c.fav }" />{{ c.fav ? '已收藏' : '收藏' }}
                </button>
                <button class="btn sm danger" @click="removeCard(c)"><Trash2 :size="13" />删除</button>
              </div>
            </div>
            <div class="info">
              <div class="desc">{{ c.description || '（无描述）' }}</div>
            </div>
          </div>
        </div>

        <div v-if="!filtered.length" class="chat-empty" style="padding: 70px 0">
          <div class="empty-glyph"><Sparkles /></div>
          <div style="font-size: 1rem; font-weight: 700; color: var(--text-1)">还没有角色卡</div>
          <div>右上角导入 SillyTavern PNG / JSON，或到「导入 / 导出」恢复备份</div>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <div v-if="editingCard" class="modal-mask" @click.self="editingCard = null">
      <div class="modal-box wide">
        <div class="modal-head">
          <h3>{{ isNew ? '新建角色卡' : `编辑 · ${editingCard.name}` }}</h3>
          <button class="modal-close" @click="editingCard = null">✕</button>
        </div>
        <div class="modal-body">
          <!-- AI 辅助创建入口 -->
          <div v-if="isNew" class="card-panel" style="margin-bottom: 14px; padding: 12px 14px; background: var(--bg-2); border-style: dashed; display: flex; align-items: center; gap: 12px">
            <Wand2 :size="18" style="color: var(--accent); flex-shrink: 0" />
            <div style="flex: 1">
              <div style="font-weight: 700; font-size: 0.85rem">AI 辅助创建</div>
              <div style="font-size: 0.72rem; color: var(--text-2)">输入一段描述，AI 自动补全角色卡、世界书、正则、UI 模板</div>
            </div>
            <button class="btn sm primary" @click="emit('open-ai-workshop')"><Sparkles :size="13" />打开 AI 工作台</button>
          </div>

          <div style="display: flex; gap: 16px; margin-bottom: 14px">
            <div
              style="width: 84px; height: 84px; border-radius: 18px; overflow: hidden; background: var(--bg-3); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; font-size: 1.7rem; color: #b7a8ef; border: 1px dashed var(--line-strong)"
              title="点击更换头像"
              @click="pickAvatar"
            >
              <img v-if="editingCard.avatar" :src="editingCard.avatar" style="width: 100%; height: 100%; object-fit: cover" alt="" />
              <template v-else>＋</template>
            </div>
            <input ref="avatarFileInput" type="file" accept="image/*" hidden @change="onAvatarPicked" />
            <div style="flex: 1">
              <div class="field" style="margin-bottom: 0">
                <label>角色名 *</label>
                <input v-model="editingCard.name" class="input" placeholder="角色名" />
              </div>
            </div>
          </div>

          <div class="field">
            <label>描述（人设主体，进入系统提示词）</label>
            <textarea v-model="editingCard.description" class="textarea" rows="5" placeholder="{{char}} 的设定…" />
          </div>
          <div class="field">
            <label>性格</label>
            <textarea v-model="editingCard.personality" class="textarea" rows="3" />
          </div>
          <div class="field">
            <label>场景</label>
            <textarea v-model="editingCard.scenario" class="textarea" rows="3" />
          </div>
          <div class="field">
            <label>开场白（新建会话的首条消息）</label>
            <textarea v-model="editingCard.first_mes" class="textarea" rows="4" />
          </div>

          <div class="field">
            <label>备选开场白（每行一条；新建会话时可选）</label>
            <textarea
              class="textarea"
              rows="3"
              :value="(editingCard.alternateGreetings || []).join('\n')"
              @change="editingCard.alternateGreetings = ($event.target as HTMLTextAreaElement).value.split('\n').map((s) => s.trim()).filter(Boolean)"
            />
          </div>
          <div class="field">
            <label>示例对话（mes_example，用 &lt;START&gt; 分段，以"角色名:"/"用户名:" 开头）</label>
            <textarea v-model="editingCard.mesExample" class="textarea mono" rows="4" placeholder="<START>&#10;用户名: 你好&#10;角色名: …" />
          </div>
          <div style="display: flex; gap: 14px; flex-wrap: wrap">
            <div class="field" style="flex: 1; min-width: 200px">
              <label>系统提示词覆盖（system_prompt，留空用默认组装）</label>
              <textarea v-model="editingCard.systemPromptOverride" class="textarea" rows="2" />
            </div>
            <div class="field" style="flex: 1; min-width: 200px">
              <label>历史后指令（post_history_instructions）</label>
              <textarea v-model="editingCard.postHistoryInstructions" class="textarea" rows="2" />
            </div>
          </div>
          <div class="field">
            <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-weight: normal">
              <input
                type="checkbox"
                style="width: auto; margin-top: 2px"
                :checked="editingCard.uiPanelAuxTakeover !== false"
                @change="editingCard.uiPanelAuxTakeover = ($event.target as HTMLInputElement).checked"
              />
              <span style="font-size: 0.8rem; color: var(--text-2); line-height: 1.6">
                整页 HTML 面板由副模型接管（默认开启）：自动识别 AI 自画的整页面板消息——主模型只写剧情正文，历史面板不再整段进上下文（替换为文字摘要），面板由副模型每轮按剧情重绘并挂在最新回复下。
              </span>
            </label>
          </div>
          <div style="display: flex; gap: 14px; flex-wrap: wrap">
            <div class="field" style="flex: 1; min-width: 140px">
              <label>作者（creator）</label>
              <input v-model="editingCard.creator" class="input" />
            </div>
            <div class="field" style="max-width: 160px">
              <label>卡版本</label>
              <input v-model="editingCard.characterVersion" class="input" />
            </div>
            <div class="field" style="flex: 1; min-width: 200px">
              <label>标签（逗号分隔）</label>
              <input
                class="input"
                :value="(editingCard.tags || []).join(', ')"
                @change="editingCard.tags = ($event.target as HTMLInputElement).value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)"
              />
            </div>
          </div>
          <div class="field">
            <label>作者注释</label>
            <textarea v-model="editingCard.creator_notes" class="textarea" rows="2" />
          </div>

          <button class="btn sm" style="margin-top: 4px" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? '▲ 收起' : '▼ 展开高级数据' }}（世界书 / 正则 / UI 模板）
          </button>
          <template v-if="showAdvanced">
            <n-tabs type="line" size="small" style="margin-top: 10px" default-value="worldbook">
              <n-tab-pane name="worldbook" tab="世界书">
                <WorldBookEditor v-model:list="editingCard.worldInfo" />
              </n-tab-pane>
              <n-tab-pane name="regex" tab="正则工具">
                <RegexEditor v-model:list="editingCard.regexScripts" />
              </n-tab-pane>
              <n-tab-pane name="uitpl" tab="UI 模板（JSON 存档）">
                <div class="field" style="margin-top: 8px">
                  <label>UI 模板条目（JSON 数组；对话内挂到最后一条 AI 消息上渲染）</label>
                  <textarea v-model="uiTemplatesJson" class="textarea mono" rows="6" @change="parseUiTemplates()" />
                </div>
              </n-tab-pane>
            </n-tabs>
            <div v-if="advancedError" class="danger-box">{{ advancedError }}</div>
          </template>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editingCard = null">取消</button>
          <button class="btn primary" @click="saveCard">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
