<script setup lang="ts">
import { computed, ref } from 'vue'
import { Backpack, Brain, Plus, X } from 'lucide-vue-next'
import { addGameItem, addGameMemory, hall, removeGameItem, removeGameMemory } from '../../lib/hall/useHall'

/** 战局面板：滑块切换「记忆 / 道具」，KP 自动维护 + 房主手动增删 */
const tab = ref<'mem' | 'item'>('mem')

const isHost = computed(() => hall.state.isHost)
const memories = computed(() => hall.state.gameState?.memories ?? [])
const items = computed(() => hall.state.gameState?.items ?? [])

const itemName = ref('')
const itemNote = ref('')
const memText = ref('')

async function submitItem() {
  if (!itemName.value.trim()) return
  await addGameItem(itemName.value, itemNote.value)
  itemName.value = ''
  itemNote.value = ''
}

async function submitMem() {
  if (!memText.value.trim()) return
  await addGameMemory(memText.value)
  memText.value = ''
}
</script>

<template>
  <div class="hall-panel">
    <div class="hall-panel-title">战局 · 记忆与道具</div>

    <!-- 滑块：记忆 / 道具 -->
    <div class="hall-state-tabs" role="tablist">
      <button :class="{ active: tab === 'mem' }" @click="tab = 'mem'">
        <Brain :size="12" />记忆 {{ memories.length }}
      </button>
      <button :class="{ active: tab === 'item' }" @click="tab = 'item'">
        <Backpack :size="12" />道具 {{ items.length }}
      </button>
    </div>

    <div v-if="tab === 'mem'" class="hall-state-list">
      <div v-for="m in memories" :key="m.id" class="hall-state-item">
        <div class="hall-state-text">{{ m.text }}</div>
        <button v-if="isHost" class="hall-state-del" title="删除这条记忆" @click="removeGameMemory(m.id)"><X :size="12" /></button>
      </div>
      <div v-if="!memories.length" class="hall-state-empty">
        还没有关键记忆——KP 推进剧情时会自动记下重要事实与线索<span v-if="isHost">，也可以在下面手动添加</span>
      </div>
    </div>

    <div v-else class="hall-state-list">
      <div v-for="it in items" :key="it.id" class="hall-state-item">
        <div class="hall-state-text">
          <b>{{ it.name }}</b>
          <span v-if="it.note" class="hall-state-note"> · {{ it.note }}</span>
        </div>
        <button v-if="isHost" class="hall-state-del" title="移出道具栏" @click="removeGameItem(it.id)"><X :size="12" /></button>
      </div>
      <div v-if="!items.length" class="hall-state-empty">
        背包空空如也——获得道具时会自动出现在这里<span v-if="isHost">，也可以在下面手动登记</span>
      </div>
    </div>

    <!-- KP 台（房主）可手动维护 -->
    <div v-if="isHost" class="hall-state-add">
      <template v-if="tab === 'mem'">
        <input v-model="memText" class="input" placeholder="手动记一条关键事实…" maxlength="160" @keyup.enter="submitMem" />
        <button class="btn sm" title="记下" @click="submitMem"><Plus :size="13" /></button>
      </template>
      <template v-else>
        <input v-model="itemName" class="input" placeholder="道具名" maxlength="40" @keyup.enter="submitItem" />
        <input v-model="itemNote" class="input" placeholder="备注，可空" maxlength="80" @keyup.enter="submitItem" />
        <button class="btn sm" title="登记道具" @click="submitItem"><Plus :size="13" /></button>
      </template>
    </div>
    <p v-else class="hall-sys-line" style="margin: 0">战局由 KP 台维护，这里实时同步</p>
  </div>
</template>
