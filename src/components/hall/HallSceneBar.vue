<script setup lang="ts">
import { computed, ref } from 'vue'
import { Plus, RotateCcw, X } from 'lucide-vue-next'
import { createScene, hall, setSceneClosed, setSceneGenerator } from '../../lib/hall/useHall'
import { PARTY_LINE, sceneNarrator } from '../../lib/hall/protocol'

/** 分线页签：全体主线 + 房主开的自定义线（个人线/合作线）；页签角标显示叙述者（谁烧谁的 API） */
const creating = ref(false)
const newName = ref('')
const newGen = ref('')

const activeScene = computed(() => hall.state.scenes.find((s) => s.id === hall.state.currentScene))
const memberNames = computed(() =>
  [...new Set(hall.memberList.value.map((m) => m.charName || m.name).filter(Boolean))].filter((n) => n),
)
const activeNarrator = computed(() => sceneNarrator(hall.state.scenes, hall.state.currentScene))

function pick(id: string) {
  hall.state.currentScene = id
}

async function submit() {
  const n = newName.value.trim()
  if (!n) return
  await createScene(n, newGen.value)
  newName.value = ''
  newGen.value = ''
  creating.value = false
  // 开完线直接切过去
  hall.state.currentScene = hall.state.scenes[hall.state.scenes.length - 1]?.id || PARTY_LINE
}

async function changeGen(e: Event) {
  if (!activeScene.value) return
  await setSceneGenerator(activeScene.value.id, (e.target as HTMLSelectElement).value)
}
</script>

<template>
  <div class="hall-scene-bar">
    <button
      class="hall-scene-tab"
      :class="{ active: hall.state.currentScene === PARTY_LINE }"
      title="全体主线 · 房主叙述"
      @click="pick(PARTY_LINE)"
    >全体</button>
    <button
      v-for="s in hall.state.scenes"
      :key="s.id"
      class="hall-scene-tab"
      :class="{ active: hall.state.currentScene === s.id, closed: s.closed }"
      :title="`${s.name} · 叙述者 ${sceneNarrator(hall.state.scenes, s.id)}${s.closed ? ' · 已收线' : ''}`"
      @click="pick(s.id)"
    >{{ s.name }}<span class="hall-scene-who">{{ sceneNarrator(hall.state.scenes, s.id) }}</span></button>

    <template v-if="hall.state.isHost">
      <button v-if="!creating" class="hall-scene-add" title="开一条新线（个人线 / 小组合作线）" @click="creating = true"><Plus :size="13" /></button>
      <div v-else class="hall-scene-form">
        <input v-model="newName" class="input" placeholder="线名：如 王五的个人线 / 图书馆二人组" maxlength="24" @keyup.enter="submit" />
        <select v-model="newGen" class="input hall-scene-select" title="叙述者：这条线的旁白由谁的本机 API 生成、谁付 token">
          <option value="">叙述：房主</option>
          <option v-for="m in memberNames" :key="m" :value="m">叙述：{{ m }}</option>
        </select>
        <button class="btn sm" @click="submit">开线</button>
        <button class="btn sm ghost" title="取消" @click="creating = false"><X :size="13" /></button>
      </div>
      <template v-if="!creating && activeScene">
        <select
          class="input hall-scene-select hall-scene-gen"
          :value="activeScene.generator || ''"
          title="改叙述者：这条线的旁白由谁的本机 API 生成、谁付 token；选「房主」即收回"
          @change="changeGen"
        >
          <option value="">叙述：房主</option>
          <option v-for="m in memberNames" :key="m" :value="m">叙述：{{ m }}</option>
        </select>
        <button
          class="hall-scene-op"
          :title="activeScene.closed ? '重开这条线' : '收线（剧情保留，可重开）'"
          @click="setSceneClosed(activeScene.id, !activeScene.closed)"
        ><RotateCcw v-if="activeScene.closed" :size="12" /><X v-else :size="12" /></button>
      </template>
    </template>
  </div>
</template>
