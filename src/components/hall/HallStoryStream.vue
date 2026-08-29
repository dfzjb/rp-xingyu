<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { hall } from '../../lib/hall/useHall'
import type { RoomEvent } from '../../lib/hall/protocol'

const props = defineProps<{
  events: RoomEvent[]
  streaming: { id: string; text: string } | null
}>()

type StreamableEvent = Extract<RoomEvent, { k: 'chat' | 'narration' | 'roll' | 'system' }>

function isStreamable(e: RoomEvent): e is StreamableEvent {
  return e.k === 'chat' || e.k === 'narration' || e.k === 'roll' || e.k === 'system'
}

type Row =
  | { kind: 'chat'; id: string; char: string; user: string; text: string; mine: boolean; initial: string }
  | { kind: 'narr'; id: string; text: string }
  | { kind: 'roll'; id: string; who: string; detail: string }
  | { kind: 'sys'; id: string; text: string }

const rows = computed<Row[]>(() =>
  props.events.filter(isStreamable).map((e): Row => {
    if (e.k === 'chat') {
      const m = hall.state.members[e.from]
      const char = e.charName || e.name
      return {
        kind: 'chat', id: e.id, char, user: e.name, text: e.text,
        mine: e.from === hall.state.myPeerId,
        initial: (m?.charName || m?.name || char).slice(0, 1),
      }
    }
    if (e.k === 'narration') return { kind: 'narr', id: e.id, text: e.text }
    if (e.k === 'roll') return { kind: 'roll', id: e.id, who: e.charName || e.name, detail: e.detail }
    return { kind: 'sys', id: e.id, text: e.text }
  }),
)

const scrollEl = ref<HTMLElement | null>(null)

watch(
  () => [props.events.length, props.streaming?.text.length ?? 0],
  async () => {
    await nextTick()
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  },
)
</script>

<template>
  <div ref="scrollEl" class="hall-stream">
    <p v-if="!events.length && !streaming" class="hall-sys-line hall-empty-hint">
      剧情流还是空的——聊一句话，KP 就会开口。
    </p>

    <template v-for="row in rows" :key="row.id">
      <div v-if="row.kind === 'chat'" class="hall-msg">
        <div class="hall-avatar" :class="{ mine: row.mine }">{{ row.initial }}</div>
        <div class="hall-bubble">
          <div class="hall-who">
            {{ row.char }}
            <span v-if="row.user && row.user !== row.char" class="hall-sys-line" style="display: inline">{{ row.user }}</span>
          </div>
          <div class="hall-text">{{ row.text }}</div>
        </div>
      </div>

      <div v-else-if="row.kind === 'narr'" class="hall-narration">
        <div class="hall-narration-mark">◆</div>
        <div class="hall-narration-text">{{ row.text }}</div>
      </div>

      <div v-else-if="row.kind === 'roll'" class="hall-roll-chip">
        <span>🎲</span>
        <b>{{ row.who }}</b>
        <span style="font-family: monospace">{{ row.detail }}</span>
      </div>

      <div v-else class="hall-sys-line">{{ row.text }}</div>
    </template>

    <div v-if="streaming" class="hall-narration hall-kp-live">
      <div class="hall-narration-mark">◆</div>
      <div class="hall-narration-text">{{ streaming.text || '…' }}<span class="hall-caret" /></div>
    </div>
  </div>
</template>
