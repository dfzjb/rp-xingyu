<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Menu, Plus, Trash2, SendHorizontal, Square, ImagePlus, MoonStar, BrainCircuit, Heart, Sparkles, Play, UserRound, Search } from 'lucide-vue-next'
import { NSelect } from 'naive-ui'
import { useChatStore } from '../stores/chat'
import { useCharactersStore } from '../stores/characters'
import { useSettingsStore } from '../stores/settings'
import { groupedModelOptions } from '../lib/api'
import MessageBubble from '../components/MessageBubble.vue'
import MemoryDrawer from '../components/MemoryDrawer.vue'

const emit = defineEmits<{
  (e: 'open-sidebar'): void
  (e: 'goto', view: 'characters' | 'settings' | 'affinity'): void
}>()

const chat = useChatStore()
const characters = useCharactersStore()
const settings = useSettingsStore()

const inputText = ref('')
const pendingImages = ref<{ dataUrl: string; description?: string }[]>([])
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const lightbox = ref<{ src: string } | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const memoryShow = ref(false)
const pendingInstructionOpen = ref(false)
const searchOpen = ref(false)
const searchText = ref('')
const searchResults = ref<{ sessionId: string; sessionName: string; nodeId: string; floor: number; text: string }[]>([])

function doSearch() {
  const q = searchText.value.trim().toLowerCase()
  searchResults.value = []
  if (!q || !char.value) return
  for (const s of chat.sessionsOfChar(char.value.uuid)) {
    // 沿 active 链取楼层，与界面楼层号一致
    const path: { id: string; content: string }[] = []
    let cur = s.activeNodeId ? s.nodes[s.activeNodeId] : undefined
    while (cur) { path.unshift(cur); cur = cur.parentId ? s.nodes[cur.parentId] : undefined }
    for (let i = 0; i < path.length; i++) {
      const body = (path[i].content || '').replace(/<(think|cot)>[\s\S]*?(?:<\/\s*\1\s*>|$)/gi, '')
      if (body.toLowerCase().includes(q)) {
        searchResults.value.push({
          sessionId: s.id, sessionName: s.name,
          nodeId: path[i].id, floor: i + 1,
          text: body.replace(/\s+/g, ' ').slice(0, 80),
        })
      }
    }
    if (searchResults.value.length >= 20) return
  }
}

async function jumpToResult(r: { sessionId: string; nodeId: string }) {
  stickBottom = false
  await chat.selectSession(r.sessionId)
  searchOpen.value = false
  await nextTick()
  // 会话切换后整条链重渲染，直接定位到目标楼层
  const scroll = () => document.getElementById('msg-' + r.nodeId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  scroll()
  setTimeout(scroll, 400)
}

const char = computed(() =>
  characters.list.find((c) => c.uuid === chat.currentSession?.charUuid),
)

/** 聊天区封面背景：浓度/模糊由设置滑条实时控制（浓度 0 = 关闭） */
const coverStyle = computed(() => {
  const op = Math.max(0, Math.min(100, Number(settings.settings.chatCoverOpacity ?? 30))) / 100
  const blur = Math.max(0, Number(settings.settings.chatCoverBlur ?? 6))
  return { opacity: op.toFixed(2), filter: `blur(${blur}px) saturate(1.15)` }
})

const sessionOptions = computed(() => {
  if (!char.value) return []
  return chat
    .sessionsOfChar(char.value.uuid)
    .map((s) => ({
      value: s.id,
      label: `${s.name} · ${Object.keys(s.nodes).length} 楼`,
    }))
})

/** 自动滚动到底部（生成时跟随） */
let stickBottom = true
async function scrollToBottom() {
  await nextTick()
  const el = bodyEl.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(
  () => chat.chain.length,
  () => { if (stickBottom) void scrollToBottom() },
)
watch(
  () => chat.chain[chat.chain.length - 1]?.content,
  () => { if (stickBottom && chat.generating) void scrollToBottom() },
)
function onScroll() {
  const el = bodyEl.value
  if (!el) return
  stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function autosize() {
  const el = textareaEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 180) + 'px'
}

async function send() {
  const text = inputText.value.trim()
  if ((!text && !pendingImages.value.length) || !chat.currentSession || chat.generating) return
  stickBottom = true
  inputText.value = ''
  autosize()
  const imgs = pendingImages.value.slice()
  pendingImages.value = []
  await chat.send(text, imgs.length ? imgs : undefined)
  void scrollToBottom()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

/**
 * 接收沙箱 iframe（HTML 消息 / UI 模板）内 triggerSlash 发出的消息：
 * 卡片内"确认创建"等按钮通过 postMessage 把文本送回宿主，直接作为用户消息发送。
 * srcdoc iframe 带 allow-same-origin，origin 继承父页 —— 非同源来源一律忽略，防外部窗口伪造。
 */
function onIframeMessage(e: MessageEvent) {
  const data = e.data as { type?: string; message?: unknown } | null
  if (!data || typeof data !== 'object') return
  if (data.type !== 'rp-site-send-message' && data.type !== 'send_message') return
  if (e.origin !== location.origin) return
  const text = typeof data.message === 'string' ? data.message.trim() : ''
  if (!text || !chat.currentSession || chat.generating) return
  stickBottom = true
  void chat.send(text).then(() => scrollToBottom())
}

onMounted(() => window.addEventListener('message', onIframeMessage))
onUnmounted(() => window.removeEventListener('message', onIframeMessage))

function pickImages() {
  fileInput.value?.click()
}
async function onImagesPicked(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files) return
  for (const f of Array.from(files)) {
    if (!f.type.startsWith('image/')) continue
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.onerror = reject
      r.readAsDataURL(f)
    })
    pendingImages.value.push({ dataUrl })
  }
  if (fileInput.value) fileInput.value.value = ''
}

async function newSession() {
  if (!char.value) return
  const greetings = [char.value.first_mes?.trim() || '', ...(char.value.alternateGreetings || []).map((g) => g.trim())].filter(Boolean)
  if (greetings.length > 1) {
    // 多开场白：弹出选择（含预览）
    greetingChoice.value = 0
    greetingOpen.value = true
    return
  }
  await chat.createSession(char.value)
  stickBottom = true
  void scrollToBottom()
}

const greetingOpen = ref(false)
const greetingChoice = ref(0)
const greetingOptions = computed(() => {
  const g = [char.value?.first_mes?.trim() || '', ...(char.value?.alternateGreetings || [])].filter(Boolean)
  return g.map((text, i) => ({ index: i, text }))
})

async function confirmGreeting() {
  if (!char.value) { greetingOpen.value = false; return }
  await chat.createSession(char.value, greetingChoice.value)
  greetingOpen.value = false
  stickBottom = true
  void scrollToBottom()
}

async function onSessionChange(id: string) {
  await chat.selectSession(id)
  stickBottom = true
  void scrollToBottom()
}

async function deleteCurrentSession() {
  const s = chat.currentSession
  if (!s) return
  if (!confirm(`删除会话「${s.name}」？整棵消息树都会删除，不可恢复。`)) return
  await chat.deleteSession(s.id)
}

const floorTotal = computed(() => chat.chain.length)

// ── 快捷模型切换 ──
const modelOptions = computed(() => {
  const slotOpts = settings.settings.modelSlots.map((m, i) => ({
    label: `${m.label}${m.model ? ' · ' + m.model : '（未设置）'}`,
    value: '__slot' + i,
  }))
  const known = new Set(settings.settings.modelSlots.map((m) => m.model).filter(Boolean))
  const remaining = settings.modelsCache.filter((m) => !known.has(m))
  return [
    { type: 'group' as const, label: '模型槽位', key: 'slots', children: slotOpts },
    ...groupedModelOptions(remaining, 'text'),
  ]
})
const currentModelValue = computed(() => {
  const slot = settings.settings.activeSlot
  const m = settings.settings.modelSlots[slot]?.model
  // 如果当前槽位模型在已知列表中，返回模型名；否则返回槽位标识
  if (m && settings.modelsCache.includes(m)) return m
  return '__slot' + slot
})
function onModelChange(v: string) {
  if (v.startsWith('__slot')) {
    settings.patch({ activeSlot: Number(v.slice(6)) })
  } else {
    // 直接选/输入了模型名：写入当前槽位
    const slots = settings.settings.modelSlots.map((m, i) =>
      i === settings.settings.activeSlot ? { ...m, model: v } : m,
    )
    settings.patch({ modelSlots: slots })
  }
}
</script>

<template>
  <div v-if="chat.currentSession && char" class="view-page">
    <!-- 角色封面氛围背景：取卡头像做底图，浓度/模糊在「更多 → 设置 → 聊天背景」调节 -->
    <div
      v-if="char.avatar && coverStyle.opacity !== '0.00'"
      class="chat-cover-bg"
      :style="{ ...coverStyle, backgroundImage: 'url(' + char.avatar + ')' }"
      aria-hidden="true"
    />
    <!-- 顶栏 -->
    <header class="chat-header">
      <button class="mobile-toggle" @click="emit('open-sidebar')"><Menu /></button>
      <div class="avatar">
        <img v-if="char.avatar" :src="char.avatar" alt="" />
        <template v-else>{{ char.name.slice(0, 1) }}</template>
      </div>
      <div class="title">
        <div class="name">{{ char.name }}</div>
        <div class="stats">
          <span>{{ chat.currentSession.name }}</span>
          <span>共 {{ floorTotal }} 楼</span>
          <span>正文 {{ chat.totalBodyChars }} 字</span>
        </div>
      </div>
      <div class="actions">
        <NSelect
          :value="currentModelValue"
          size="small"
          filterable
          tag
          :options="modelOptions"
          :placeholder="settings.activeModel || '选择模型'"
          style="width: 180px"
          @update:value="onModelChange"
        />
        <NSelect
          :value="chat.currentSessionId"
          size="small"
          filterable
          :options="sessionOptions"
          style="width: 160px"
          @update:value="onSessionChange"
        />
        <button class="btn sm hide-sm" title="搜索聊天记录" @click="searchOpen = !searchOpen"><Search :size="14" /></button>
        <button class="btn sm hide-sm" title="好感度 · 关系状态" @click="emit('goto', 'affinity')"><Heart :size="14" /></button>
        <button class="btn sm hide-sm" title="会话记忆" @click="memoryShow = true"><BrainCircuit :size="14" /></button>
        <button class="btn sm hide-sm" @click="newSession"><Plus :size="14" />会话</button>
        <button class="btn sm danger hide-sm" @click="deleteCurrentSession"><Trash2 :size="14" />删会话</button>
      </div>
    </header>

    <!-- 搜索面板 -->
    <div v-if="searchOpen" class="card-panel" style="margin: 0 12px 8px; padding: 12px">
      <div style="display: flex; gap: 8px">
        <input v-model="searchText" class="input" style="flex:1; font-size:0.82rem" placeholder="搜索聊天记录…" @keydown.enter="doSearch" />
        <button class="btn sm primary" @click="doSearch"><Search :size="13" /></button>
      </div>
      <div v-if="searchResults.length" style="margin-top: 8px; max-height: 200px; overflow-y: auto">
        <div
          v-for="(r, i) in searchResults"
          :key="i"
          class="search-result"
          @click="jumpToResult(r)"
        >
          <span class="chip">{{ r.sessionName }} #{{ r.floor }}</span> {{ r.text }}
        </div>
      </div>
    </div>

    <!-- 生成进度光束 -->
    <div v-if="chat.generating" class="gradient-beam" />

    <!-- 消息列表 -->
    <div ref="bodyEl" class="chat-body" @scroll="onScroll">
      <MessageBubble
        v-for="(m, i) in chat.chain"
        :key="m.id"
        :node="m"
        :floor="i + 1"
        v-model:lightbox="lightbox"
      />
      <div v-if="!floorTotal" class="chat-empty anim-in">
        <div class="empty-glyph"><MoonStar /></div>
        <div style="font-size: 1rem; font-weight: 700">还没有消息</div>
        <div>发送第一句话，或到「角色卡」为该角色填写开场白</div>
      </div>
    </div>

    <!-- 输入区 -->
    <footer class="composer">
      <div class="composer-inner">
        <div v-if="pendingImages.length" class="pending-images">
          <div v-for="(img, i) in pendingImages" :key="i" class="thumb">
            <img :src="img.dataUrl" alt="" />
            <button class="rm" @click="pendingImages.splice(i, 1)">×</button>
          </div>
        </div>
        <div v-if="pendingInstructionOpen || chat.pendingInstruction" class="composer-tip" style="justify-content: flex-start; margin: 0 0 8px">
          <input
            class="input"
            style="flex: 1; padding: 6px 10px; font-size: 0.78rem"
            placeholder="临时规范指令（仅随下一次发送附带，如：本章不要出现打斗）"
            :value="chat.pendingInstruction"
            @input="chat.pendingInstruction = ($event.target as HTMLInputElement).value"
          />
          <button class="btn sm ghost" title="清除" @click="chat.pendingInstruction = ''">✕</button>
        </div>
        <div class="composer-box">
          <button
            class="composer-attach-btn"
            :style="chat.pendingInstruction || pendingInstructionOpen ? 'color: var(--accent-2)' : ''"
            title="临时规范指令（仅下次发送生效）"
            @click="pendingInstructionOpen = !pendingInstructionOpen"
          ><Sparkles /></button>
          <button class="composer-attach-btn" title="附加图片" @click="pickImages"><ImagePlus /></button>
          <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onImagesPicked" />
          <textarea
            ref="textareaEl"
            v-model="inputText"
            class="composer-textarea"
            rows="1"
            placeholder="输入剧情 / 对话…（Enter 发送，Shift+Enter 换行）"
            @keydown="onKeydown"
            @input="autosize"
          />
          <button
            v-if="chat.generating"
            class="composer-send stop"
            title="停止生成（保留已生成部分）"
            @click="chat.stopGenerating()"
          ><Square fill="currentColor" :size="15" /></button>
          <button
            v-else
            class="composer-send"
            title="发送"
            :disabled="!inputText.trim() && !pendingImages.length"
            @click="send"
          ><SendHorizontal /></button>
        </div>
        <div v-if="chat.uiTplStatus" class="uitpl-status" :data-state="chat.uiTplStatus.state">
          <span class="dot" />{{ chat.uiTplStatus.message }}
        </div>
        <div v-if="chat.generatingError" class="composer-tip" style="color: var(--danger)">
          ⚠️ {{ chat.generatingError }}
        </div>
        <div v-else class="composer-tip">本地优先 · 消息树结构，重 roll 不丢历史 · Enter 发送 / Shift+Enter 换行</div>
        <div v-if="inputText.length > 0" class="composer-tip" style="justify-content: flex-end">
          ≈{{ Math.ceil(inputText.length / 2.5) }} tokens
        </div>
      </div>
    </footer>

    <!-- 开场白选择 -->
    <div v-if="greetingOpen" class="modal-mask" @click.self="greetingOpen = false">
      <div class="modal-box">
        <div class="modal-head">
          <h3>选择开场白</h3>
          <button class="modal-close" @click="greetingOpen = false">✕</button>
        </div>
        <div class="modal-body" style="display: flex; flex-direction: column; gap: 10px">
          <label
            v-for="(g, i) in greetingOptions"
            :key="i"
            class="greeting-option"
            :class="{ selected: greetingChoice === i }"
            @click="greetingChoice = i"
          >
            <div class="greeting-radio">
              <div v-if="greetingChoice === i" class="greeting-radio-dot" />
            </div>
            <div style="flex: 1">
              <span style="font-size: 0.82rem; white-space: pre-wrap; line-height: 1.7">{{ g.text.slice(0, 220) }}{{ g.text.length > 220 ? '…' : '' }}</span>
            </div>
            <span class="chip" style="align-self: flex-start; flex-shrink: 0">{{ i === 0 ? '默认' : `备选 ${i}` }}</span>
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="greetingOpen = false">取消</button>
          <button class="btn primary" @click="confirmGreeting">开始对话</button>
        </div>
      </div>
    </div>

    <!-- 记忆抽屉 -->
    <MemoryDrawer v-model:show="memoryShow" />

    <!-- 图片灯箱 -->
    <div v-if="lightbox" class="lightbox" @click="lightbox = null">
      <img :src="lightbox.src" alt="" @click.stop />
      <button class="lightbox-close" @click="lightbox = null">✕</button>
    </div>
  </div>

  <!-- 无会话空态（主页） -->
  <div v-else class="view-page">
    <button class="mobile-toggle" style="position: absolute; left: 12px; top: 12px; z-index: 4" @click="emit('open-sidebar')"><Menu /></button>
    <div class="chat-empty" style="height: 100%; padding: 20px">
      <div class="empty-glyph anim-in"><MoonStar /></div>
      <div style="font-size: 1.3rem; font-weight: 800" class="gradient-text">RP · 星屿</div>
      <div style="color: var(--text-1)">从左侧选择角色卡开始对话</div>

      <div style="display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap; justify-content: center">
        <button class="btn primary" style="min-width: 220px; padding: 11px 22px" @click="emit('goto', 'characters')">
          📥 导入数据（角色卡 + 聊天记录 + 备份）
        </button>
        <button class="btn" @click="emit('goto', 'characters')">📤 备份 / 导出</button>
      </div>
      <div style="font-size: 0.78rem; color: var(--text-2); max-width: 420px; text-align: center; line-height: 1.7">
        在角色卡工坊导入 PNG / JSON / 备份文件，右上角「备份」可导出
      </div>
    </div>
  </div>
</template>
