<script setup lang="ts">
import { ref } from 'vue'
import { UserRound, Plus, Pencil, Trash2 } from 'lucide-vue-next'
import { usePersonasStore } from '../stores/personas'
import type { Persona } from '../types'

const personas = usePersonasStore()

const editing = ref<Persona | null>(null)
const isNew = ref(false)

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
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner" style="max-width: 760px">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px">
          <div class="section-title" style="margin-bottom: 0"><UserRound /> 用户人设</div>
          <div style="flex: 1" />
          <button class="btn primary" @click="openNew"><Plus :size="15" />新建人设</button>
        </div>

        <p style="font-size: 0.8rem; color: var(--text-1); margin-bottom: 14px; line-height: 1.7">
          对话时你扮演的形象：人设描述会注入系统提示词，人设名显示在你的消息上。单选当前生效人设。
        </p>

        <div
          v-for="p in personas.list"
          :key="p.uuid"
          class="card-panel spotlight-card"
          style="display: flex; align-items: center; gap: 14px; margin-bottom: 12px; cursor: pointer"
          :style="personas.activeUuid === p.uuid ? 'border-color: rgba(139,92,246,0.55)' : ''"
          @click="personas.setActive(p.uuid)"
        >
          <div class="msg-avatar" style="width: 46px; height: 46px">
            <img v-if="p.avatar" :src="p.avatar" alt="" />
            <template v-else>{{ p.name.slice(0, 1) }}</template>
          </div>
          <div style="flex: 1; min-width: 0">
            <div style="display: flex; align-items: center; gap: 8px">
              <b>{{ p.name }}</b>
              <span class="chip" :class="{ on: personas.activeUuid === p.uuid }">
                {{ personas.activeUuid === p.uuid ? '使用中' : '点击启用' }}
              </span>
              <span class="chip">{{ p.person === 'first' ? '第一人称' : '第二人称' }}</span>
            </div>
            <div style="font-size: 0.78rem; color: var(--text-2); margin-top: 4px; white-space: pre-wrap">
              {{ p.description || '（无描述）' }}
            </div>
          </div>
          <div style="display: flex; gap: 6px" @click.stop>
            <button class="btn sm" @click="openEdit(p)"><Pencil :size="13" />编辑</button>
            <button class="btn sm danger" @click="remove(p)"><Trash2 :size="13" />删除</button>
          </div>
        </div>

        <!-- 编辑弹窗 -->
        <div v-if="editing" class="modal-mask" @click.self="editing = null">
          <div class="modal-box">
            <div class="modal-head">
              <h3>{{ isNew ? '新建人设' : `编辑 · ${editing.name}` }}</h3>
              <button class="modal-close" @click="editing = null">×</button>
            </div>
            <div class="modal-body">
              <div class="field">
                <label>名字</label>
                <input v-model="editing.name" class="input" />
              </div>
              <div class="field">
                <label>描述（你是谁、外貌、口吻等）</label>
                <textarea v-model="editing.description" class="textarea" rows="6" />
              </div>
              <div class="field">
                <label>叙述人称</label>
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
    </div>
  </div>
</template>
