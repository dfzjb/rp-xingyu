<script setup lang="ts">
// 用户人设管理（原「更多 → 人设」整体移入跑团）：跑团里以当前启用人设的身份入场
import { computed, ref } from 'vue'
import { UserRound, Plus, Pencil, Trash2 } from 'lucide-vue-next'
import { usePersonasStore } from '../../stores/personas'
import type { Persona } from '../../types'

const emit = defineEmits<{ close: [] }>()

const personas = usePersonasStore()

const editing = ref<Persona | null>(null)
const isNew = ref(false)
const avatarInput = ref<HTMLInputElement | null>(null)

const active = computed(() => personas.list.find((p) => p.uuid === personas.activeUuid) || null)

function openNew() {
  editing.value = personas.empty()
  isNew.value = true
}
function openEdit(p: Persona) {
  editing.value = { ...p }
  isNew.value = false
}
async function save() {
  if (!editing.value) return
  if (!editing.value.name.trim()) { alert('人设名不能为空'); return }
  await personas.put(editing.value)
  if (!personas.activeUuid || isNew.value) await personas.setActive(editing.value.uuid)
  editing.value = null
}
async function remove(p: Persona) {
  if (!confirm(`删除人设「${p.name}」？`)) return
  await personas.remove(p.uuid)
}

function pickAvatar() { avatarInput.value?.click() }
async function onAvatarPicked(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f || !editing.value) return
  editing.value.avatar = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(f)
  })
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal-box" style="max-height: 84vh; overflow-y: auto">
      <div class="modal-head">
        <h3><UserRound :size="16" style="vertical-align: -2px" /> 用户人设</h3>
        <button class="modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size: 0.78rem; color: var(--text-2); margin: 0 0 12px; line-height: 1.7">
          你在跑团里的身份：人设名 = 房间里的角色名，人设描述 = 给 KP 的一句话人设。点击卡片启用当前人设。
        </p>

        <div v-for="p in personas.list" :key="p.uuid" class="card-panel" style="display: flex; align-items: center; gap: 12px; margin-bottom: 10px; padding: 10px 12px; cursor: pointer"
          :style="personas.activeUuid === p.uuid ? 'border-color: rgba(139,92,246,0.55)' : ''"
          @click="personas.setActive(p.uuid)"
        >
          <div class="hall-avatar hall-avatar-sm" style="width: 40px; height: 40px; border-radius: 10px; overflow: hidden">
            <img v-if="p.avatar" :src="p.avatar" style="width: 100%; height: 100%; object-fit: cover" alt="" />
            <template v-else>{{ p.name.slice(0, 1) }}</template>
          </div>
          <div style="flex: 1; min-width: 0">
            <div style="display: flex; align-items: center; gap: 8px">
              <b style="font-size: 0.86rem">{{ p.name }}</b>
              <span class="chip" :class="{ on: personas.activeUuid === p.uuid }">
                {{ personas.activeUuid === p.uuid ? '使用中' : '点击启用' }}
              </span>
            </div>
            <div style="font-size: 0.76rem; color: var(--text-2); margin-top: 2px; white-space: pre-wrap; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical">
              {{ p.description || '（无描述）' }}
            </div>
          </div>
          <div style="display: flex; gap: 6px" @click.stop>
            <button class="btn sm" @click="openEdit(p)"><Pencil :size="13" />编辑</button>
            <button class="btn sm danger" @click="remove(p)"><Trash2 :size="13" />删除</button>
          </div>
        </div>

        <div v-if="!personas.list.length" class="chat-empty" style="padding: 26px 0">
          <div class="empty-glyph"><UserRound /></div>
          <div style="font-size: 0.9rem">还没有人设——点「新建人设」创建你在跑团里的身份</div>
        </div>

        <button class="btn primary" style="width: 100%; margin-top: 6px" @click="openNew"><Plus :size="15" />新建人设</button>
        <p v-if="active" style="font-size: 0.74rem; color: var(--text-2); margin: 10px 0 0; text-align: center">
          当前将以「{{ active.name }}」的身份进入房间
        </p>
      </div>
    </div>

    <!-- 人设编辑弹窗（叠在大厅弹窗之上） -->
    <div v-if="editing" class="modal-mask" @click.self="editing = null" style="z-index: 70">
      <div class="modal-box">
        <div class="modal-head">
          <h3>{{ isNew ? '新建人设' : `编辑 · ${editing.name}` }}</h3>
          <button class="modal-close" @click="editing = null">×</button>
        </div>
        <div class="modal-body">
          <div style="display: flex; gap: 14px; margin-bottom: 14px; align-items: center">
            <div
              style="width: 64px; height: 64px; border-radius: 14px; overflow: hidden; background: var(--bg-3); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; font-size: 1.4rem; border: 1px dashed var(--line-strong)"
              title="点击设置头像"
              @click="pickAvatar"
            >
              <img v-if="editing.avatar" :src="editing.avatar" style="width: 100%; height: 100%; object-fit: cover" alt="" />
              <template v-else>＋</template>
            </div>
            <input ref="avatarInput" type="file" accept="image/*" hidden @change="onAvatarPicked" />
            <div style="flex: 1">
              <div class="field" style="margin-bottom: 0">
                <label>名字（房间里的角色名）</label>
                <input v-model="editing.name" class="input" />
              </div>
            </div>
          </div>
          <div class="field">
            <label>描述（你是谁、外貌、口吻——KP 会参考）</label>
            <textarea v-model="editing.description" class="textarea" rows="5" />
          </div>
          <div class="field">
            <label>叙述人称（仅主站对话使用，跑团不生效）</label>
            <select v-model="editing.person" class="input">
              <option value="second">第二人称（"你"视角，RP 常用）</option>
              <option value="first">第一人称（"我"视角）</option>
            </select>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editing = null">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
