<script setup lang="ts">
/**
 * 单条消息气泡：markdown / 思维链折叠 / 图片附件 / 旧版 HTML 消息 sandbox iframe /
 * 楼层与字数 / 编辑 / 删除 / 重roll / 分支切换
 */
import { computed, ref } from 'vue'
import { BrainCircuit, RefreshCw, Pencil, Trash2, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import type { MsgNode } from '../types'
import { parseCot, bodyLength } from '../lib/cot'
import { applyRegexScripts, PLACEMENT_AI_OUTPUT, PLACEMENT_USER_INPUT } from '../lib/regex'
import { renderMarkdown, isFullHtmlMessage } from '../lib/markdown'
import { normalizeUiTemplates, renderUiTemplateFrame, buildHtmlDocument, HTML_IFRAME_SANDBOX } from '../lib/uitemplate'
import { stripUiTemplateUpdates } from '../lib/ui-template-state'
import { useChatStore } from '../stores/chat'
import { useCharactersStore } from '../stores/characters'
import { useSettingsStore } from '../stores/settings'

const props = defineProps<{
  node: MsgNode
  floor: number
}>()

const chat = useChatStore()
const characters = useCharactersStore()
const settings = useSettingsStore()

// 当前会话角色卡的正则脚本（显示层应用）
const regexScripts = computed(() => {
  const char = characters.list.find((c) => c.uuid === chat.currentSession?.charUuid)
  return settings.settings.regexEnabled !== false ? char?.regexScripts : undefined
})

// 旧版迁移消息里已渲染的 UI 模板块快照（完整容器 HTML，原样 v-html 展示）
interface UiTplBlock { top: string[]; bottom: string[]; updatedAt?: number }
const legacyTplBlocks = computed<UiTplBlock | null>(() => {
  const raw = (props.node.extra as Record<string, unknown> | undefined)?.uiTemplateBlocks
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const top = Array.isArray(b.top) ? (b.top as string[]) : []
  const bottom = Array.isArray(b.bottom) ? (b.bottom as string[]) : []
  return top.length || bottom.length ? { top, bottom } : null
})

// 角色卡自带 UI 模板：挂到当前链路最后一条 AI 消息上（开场白即第一条 AI 消息，首轮即显示）。
// 变量由 AI 回复中的 <ui_template_updates> 驱动更新（会话级 uiTemplateStates）。
const liveTplBlocks = computed<{ top: string[]; bottom: string[] } | null>(() => {
  if (props.node.streaming) return null
  const char = characters.list.find((c) => c.uuid === chat.currentSession?.charUuid)
  const tpls = normalizeUiTemplates(char?.uiTemplates).filter((t) => t.enabled)
  if (!tpls.length) return null
  let lastAiId = ''
  for (const n of chat.chain) if (n.role === 'assistant') lastAiId = n.id
  if (!lastAiId || lastAiId !== props.node.id) return null
  const states = chat.currentSession?.uiTemplateStates || {}
  const sorted = [...tpls].sort((a, b) => a.order - b.order)
  const top = sorted.filter((t) => t.placement === 'top').map((t) => renderUiTemplateFrame(t, states[t.id])).filter(Boolean)
  const bottom = sorted.filter((t) => t.placement === 'bottom').map((t) => renderUiTemplateFrame(t, states[t.id])).filter(Boolean)
  return top.length || bottom.length ? { top, bottom } : null
})

// 实时块优先（变量始终最新），否则回落到迁移快照
const tplTop = computed(() => liveTplBlocks.value?.top ?? legacyTplBlocks.value?.top ?? [])
const tplBottom = computed(() => liveTplBlocks.value?.bottom ?? legacyTplBlocks.value?.bottom ?? [])

const parsed = computed(() => {
  const raw = stripUiTemplateUpdates(props.node.content || '')
  const p = parseCot(raw)
  // 整页 HTML 消息（开场白向导等）不走正则/markdown，直接沙箱 iframe 渲染；
  // 显示层正则（如"段落首行缩进"）会把每行包 <p>，破坏 <!DOCTYPE 文档结构
  if (isFullHtmlMessage(raw)) return p
  const placement = props.node.role === 'user' ? PLACEMENT_USER_INPUT : PLACEMENT_AI_OUTPUT
  if (regexScripts.value) {
    p.main = applyRegexScripts(p.main, regexScripts.value, placement, 'display')
  }
  return p
})
const rendered = computed(() => renderMarkdown(parsed.value.main))
const isHtml = computed(() => isFullHtmlMessage(stripUiTemplateUpdates(props.node.content || '')))
/** 整页 HTML 消息：注入 reset 样式 + 高度自适配 + triggerSlash 桥（与 UI 模板同构） */
const htmlDoc = computed(() => (isHtml.value ? buildHtmlDocument(parsed.value.main) : ''))
const htmlSandbox = HTML_IFRAME_SANDBOX
const wordCount = computed(() => bodyLength(parsed.value.main))

const cotOpen = ref(false)
const reasoningOpen = ref(false)

const editing = ref(false)
const editBuffer = ref('')

function startEdit() {
  editBuffer.value = stripUiTemplateUpdates(props.node.content)
  editing.value = true
}
async function saveEdit() {
  await chat.editNode(props.node.id, editBuffer.value)
  editing.value = false
}

const branch = computed(() => chat.branchInfo(props.node.id))
function branchPrev() { if (branch.value) chat.switchBranch(props.node.id, branch.value.index - 1) }
function branchNext() { if (branch.value) chat.switchBranch(props.node.id, branch.value.index + 1) }

const confirmDelete = ref(false)
async function doDelete() {
  confirmDelete.value = false
  await chat.deleteNode(props.node.id)
}

const lightbox = defineModel<{ src: string } | null>('lightbox', { default: null })
</script>

<template>
  <div class="msg-row" :id="'msg-' + node.id" :class="{ user: node.isSelf }">
    <div class="msg-avatar">
      <img v-if="node.avatar" :src="node.avatar" alt="" />
      <template v-else>{{ (node.name || '?').slice(0, 1) }}</template>
    </div>

    <div class="msg-main">
      <div class="msg-name-line">
        <span>{{ node.name || (node.isSelf ? '我' : '角色') }}</span>
        <span class="msg-floor">#{{ floor }}</span>
        <span class="msg-words">{{ wordCount }} 字</span>
      </div>

      <!-- 分支导航（该节点有多个子分支时显示） -->
      <div v-if="branch && !node.streaming" class="branch-nav">
        <button :disabled="branch.index <= 0" title="上一个版本" @click="branchPrev">
          <ChevronLeft />
        </button>
        <span class="pos">{{ branch.index + 1 }} / {{ branch.total }}</span>
        <button :disabled="branch.index >= branch.total - 1" title="下一个版本" @click="branchNext">
          <ChevronRight />
        </button>
      </div>

      <!-- 独立 reasoning 字段（旧版部分消息） -->
      <details v-if="node.reasoning" class="cot-block">
        <summary><BrainCircuit :size="13" /> 思维过程</summary>
        <div class="cot-content">{{ node.reasoning }}</div>
      </details>

      <!-- content 内嵌思维链 <think>/<cot> -->
      <details v-if="parsed.cot" class="cot-block">
        <summary><BrainCircuit :size="13" /> 思考过程{{ parsed.cotFinished ? '' : '（未完）' }}</summary>
        <div class="cot-content">{{ parsed.cot }}</div>
      </details>

      <!-- 正文 -->
      <div v-if="!editing" class="msg-bubble" :class="{ 'is-streaming': node.streaming }">
        <!-- 空内容流式占位：打字指示点 -->
        <div v-if="node.streaming && !node.content && !parsed.main" class="typing-dots"><i /><i /><i /></div>

        <!-- UI 模板块：top 位置（角色卡自带模板 / 旧版迁移快照） -->
        <template v-if="tplTop.length">
          <div class="ui-tpl-block" v-html="tplTop.join('')" />
        </template>

        <!-- 旧版整页 HTML 消息：沙箱 iframe 隔离渲染（脚本可执行，高度自适配，triggerSlash 桥接） -->
        <iframe
          v-if="isHtml"
          class="html-frame"
          :sandbox="htmlSandbox"
          scrolling="no"
          :srcdoc="htmlDoc"
          title="HTML 消息（已沙箱隔离）"
        />
        <div v-else-if="parsed.main" class="md-body" :class="{ 'stream-caret': node.streaming }" v-html="rendered" />

        <!-- UI 模板块：bottom 位置 -->
        <template v-if="tplBottom.length">
          <div class="ui-tpl-block" v-html="tplBottom.join('')" />
        </template>

        <!-- 图片附件 -->
        <div v-if="node.imageAttachments?.length" class="msg-images">
          <img
            v-for="(img, i) in node.imageAttachments"
            :key="i"
            :src="img.dataUrl"
            :alt="img.description || ''"
            loading="lazy"
            @click="lightbox = { src: img.dataUrl }"
          />
        </div>
      </div>

      <!-- 编辑态 -->
      <div v-else class="msg-bubble edit-area" style="width: 100%">
        <textarea v-model="editBuffer" class="textarea" />
        <div class="edit-actions">
          <button class="btn sm primary" @click="saveEdit">保存</button>
          <button class="btn sm" @click="editing = false">取消</button>
        </div>
      </div>

      <!-- 操作条 -->
      <div v-if="!node.streaming && !editing" class="msg-actions">
        <button v-if="node.role === 'assistant' && node.parentId" title="重新生成（旧版本保留在分支里）" @click="chat.regenerate(node.id)">
          <RefreshCw />重roll
        </button>
        <button title="编辑" @click="startEdit"><Pencil />编辑</button>
        <button v-if="confirmDelete" class="danger" @click="doDelete">确认删除？</button>
        <button v-else class="danger" title="删除（含子树）" @click="confirmDelete = true"><Trash2 />删除</button>
      </div>
    </div>
  </div>
</template>
