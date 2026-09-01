<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { MapPin, Pencil } from 'lucide-vue-next'
import { hall, setGameArea } from '../../lib/hall/useHall'

/** 侧栏底部常驻条：当前所在区域（房主可点击修改，全员实时同步） */
const area = computed(() => hall.state.gameState?.area.trim() || '')
const isHost = computed(() => hall.state.isHost)

const editing = ref(false)
const draft = ref('')

async function startEdit() {
  draft.value = area.value
  editing.value = true
  await nextTick()
  document.querySelector<HTMLInputElement>('.hall-area-bar input')?.focus()
}

async function save() {
  editing.value = false
  if (draft.value.trim() !== area.value) await setGameArea(draft.value)
}
</script>

<template>
  <div class="hall-area-bar">
    <MapPin :size="14" class="hall-area-icon" />
    <span class="hall-area-label">当前区域</span>
    <template v-if="!editing">
      <div class="hall-area-text">
        <b v-if="area">{{ area }}</b>
        <span v-else class="hall-area-none">尚未记录</span>
      </div>
      <button v-if="isHost" class="hall-area-edit" title="修改当前区域" @click="startEdit"><Pencil :size="12" /></button>
    </template>
    <div v-else class="hall-row" style="flex: 1">
      <input v-model="draft" class="input" placeholder="玩家此刻在哪里？如：雾镇·图书馆" maxlength="60" @keyup.enter="save" @keyup.esc="editing = false" />
      <button class="btn sm" @click="save">记录</button>
    </div>
  </div>
</template>
