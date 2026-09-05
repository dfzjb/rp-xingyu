<script setup lang="ts">
/**
 * P2-16 开发者面板：展示最终发给主模型的完整 messages（逐条 + 来源标注）。
 * 内嵌于「更多 → messages 预览」标签页（非弹窗，切换标签即离开）。
 * 数据源（chat store，内存态）：
 * - lastSent：真实发送/续写时捕获的最终 messages；
 * - previewCapture：对当前链路干跑一次组装的结果（不调模型）。
 * 排查"模型为什么思考 X"：展开含 X 的消息 → 看来源标签 → 定位到具体预设/世界书条目/卡文。
 */
import { computed, ref } from 'vue'
import { useChatStore } from '../stores/chat'

const chat = useChatStore()
const tab = ref<'sent' | 'preview'>('sent')
const expanded = ref<Record<number, boolean>>({})
const loading = ref(false)
const copied = ref('')

const cap = computed(() => (tab.value === 'sent' ? chat.lastSent : chat.previewCapture))
const totalChars = computed(() => (cap.value ? cap.value.messages.reduce((n, m) => n + m.content.length, 0) : 0))

async function refreshPreview() {
  loading.value = true
  await chat.debugPreview()
  loading.value = false
}

function switchTab(t: 'sent' | 'preview') {
  tab.value = t
  expanded.value = {}
  if (t === 'preview' && !chat.previewCapture) void refreshPreview()
}

function toggle(i: number) {
  expanded.value[i] = !expanded.value[i]
}

async function copyText(text: string, tag: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = tag
    setTimeout(() => { if (copied.value === tag) copied.value = '' }, 1500)
  } catch {
    /* 剪贴板不可用时静默 */
  }
}

function roleTone(role: string): string {
  if (role === 'system') return 'var(--text-2)'
  if (role === 'user') return '#2f8af5'
  return '#8b5cf6'
}
</script>

<template>
  <div>
    <p style="font-size: 0.76rem; color: var(--text-2); line-height: 1.7; margin-bottom: 10px">
      展示最终发给主模型的完整 messages（含发送层正则处理后的文本）。排查"模型为什么思考 X"：
      展开含 X 的消息，看头上的<b>来源标签</b>（预设/世界书条目/前奏/楼层/注入指令），即可定位出处。
    </p>

    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px">
      <button class="btn sm" :class="{ primary: tab === 'sent' }" @click="switchTab('sent')">上次实际发送</button>
      <button class="btn sm" :class="{ primary: tab === 'preview' }" @click="switchTab('preview')">当前会话预览（干跑）</button>
      <span style="margin-left: auto; display: flex; gap: 6px">
        <button v-if="tab === 'preview'" class="btn sm" :disabled="loading" @click="refreshPreview">
          {{ loading ? '生成中…' : '刷新预览' }}
        </button>
        <button v-if="cap" class="btn sm" @click="copyText(JSON.stringify({ messages: cap.messages, trace: cap.trace }, null, 2), 'all')">
          {{ copied === 'all' ? '已复制 ✓' : '复制整包 JSON' }}
        </button>
      </span>
    </div>

    <div v-if="cap" style="font-size: 0.74rem; color: var(--text-2); margin-bottom: 8px">
      {{ cap.kind }} · {{ new Date(cap.at).toLocaleTimeString() }} · {{ cap.charName }} · {{ cap.messages.length }} 条 / {{ totalChars }} 字
    </div>

    <div v-if="loading && !cap" style="color: var(--text-2); font-size: 0.8rem; padding: 20px 0">组装中…</div>
    <div v-else-if="!cap" class="chat-empty" style="padding: 30px 0">
      <div style="font-size: 0.84rem">
        {{ tab === 'sent' ? '还没有捕获到发送记录——在对话里发送/续写一次后回到这里查看。' : '点击「刷新预览」生成当前链路的组装结果。' }}
      </div>
    </div>

    <div v-else class="msg-list">
      <div v-for="(m, i) in cap.messages" :key="i" class="msg-row" @click="toggle(i)">
        <div class="msg-head">
          <span class="msg-idx">#{{ i }}</span>
          <span class="msg-role" :style="{ color: roleTone(m.role) }">{{ m.role }}</span>
          <span v-for="(o, j) in cap.trace[i]?.origins || []" :key="j" class="msg-origin">{{ o }}</span>
          <span class="msg-len">{{ m.content.length }} 字</span>
          <button class="btn sm ghost" @click.stop="copyText(m.content, 'm' + i)">
            {{ copied === 'm' + i ? '✓' : '复制' }}
          </button>
        </div>
        <pre v-if="expanded[i]" class="msg-body">{{ m.content }}</pre>
        <div v-else class="msg-peek">{{ m.content.slice(0, 160) }}{{ m.content.length > 160 ? '…' : '' }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg-list {
  display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px;
}
.msg-row {
  border: 1px solid var(--line); border-radius: 11px; padding: 8px 10px;
  background: rgba(13, 18, 32, 0.45); cursor: pointer;
}
html[data-theme='light'] .msg-row { background: #f6f8fd; }
.msg-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.msg-idx { font-size: 0.72rem; color: var(--text-2); font-family: ui-monospace, monospace; }
.msg-role { font-size: 0.74rem; font-weight: 700; }
.msg-origin {
  font-size: 0.68rem; color: var(--text-2);
  border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px;
  background: color-mix(in srgb, var(--accent, #8b5cf6) 6%, transparent);
}
.msg-len { margin-left: auto; font-size: 0.7rem; color: var(--text-2); }
.msg-body {
  margin: 8px 0 0; padding: 9px 10px; border-radius: 9px;
  background: rgba(0, 0, 0, 0.25); white-space: pre-wrap; word-break: break-word;
  font-size: 0.76rem; line-height: 1.7; font-family: ui-monospace, monospace;
  max-height: 40vh; overflow-y: auto;
}
html[data-theme='light'] .msg-body { background: #eef1f8; }
.msg-peek { margin-top: 5px; font-size: 0.75rem; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
