<script setup lang="ts">
/** 工具页签：完整备份/恢复、统计、清空本地库 */
import { ref } from 'vue'
import { DatabaseBackup, AlertTriangle, BarChart3 } from 'lucide-vue-next'
import { exportAll, restoreAll, downloadJson, db } from '../db'
import { useSettingsStore } from '../stores/settings'

const settings = useSettingsStore()

const restoreFileInput = ref<HTMLInputElement | null>(null)
const busy = ref('')
const msg = ref('')

async function doBackup() {
  busy.value = 'export'
  try {
    const data = await exportAll()
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    downloadJson(data, `rp-site-full-backup-${stamp}.json`)
    msg.value = '✓ 已下载完整备份（含全部分支与原始键存档）'
  } catch (err) {
    msg.value = `⚠️ ${(err as Error).message}`
  } finally {
    busy.value = ''
  }
}

async function onRestoreFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  msg.value = ''
  try {
    const obj = JSON.parse(await f.text())
    if (!confirm('恢复备份将【覆盖】当前全部本地数据，确定继续？')) return
    busy.value = 'restore'
    await restoreAll(obj)
    msg.value = '✓ 备份已恢复，即将刷新页面…'
    setTimeout(() => location.reload(), 900)
  } catch (err) {
    msg.value = `⚠️ ${(err as Error).message}`
  } finally {
    busy.value = ''
    if (restoreFileInput.value) restoreFileInput.value.value = ''
  }
}

async function wipeAll() {
  if (!confirm('清空本地数据库？所有未导出的数据将丢失！')) return
  if (!confirm('再次确认：真的要清空全部本地数据？')) return
  await Promise.all([
    db.characters.clear(), db.chats.clear(), db.personas.clear(), db.kv.clear(),
    db.memories.clear(), db.affinity.clear(), db.usage.clear(),
  ])
  location.reload()
}

const statLine = ref('')
async function showStats() {
  const [chars, chats, kvs, msgs] = await Promise.all([
    db.characters.count(),
    db.chats.count(),
    db.kv.count(),
    db.chats.toArray().then((all) => all.reduce((n, s) => n + Object.keys(s.nodes).length, 0)),
  ])
  const est = await navigator.storage?.estimate?.()
  statLine.value = `角色卡 ${chars} · 会话 ${chats} · 消息 ${msgs} · 键值存档 ${kvs}` +
    (est?.usage ? ` · 空间占用约 ${(est.usage / 1024 / 1024).toFixed(1)} MB` : '')
}
</script>

<template>
  <div>
    <div class="card-panel" style="margin-bottom: 18px; border: none; padding: 0; background: none">
      <div class="section-title" style="font-size: 0.95rem"><DatabaseBackup /> 备份与恢复</div>
      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 8px">
        <button class="btn primary sm" :disabled="busy === 'export'" @click="doBackup">⬇ 导出完整备份</button>
        <label class="btn sm" style="cursor: pointer">
          ⬆ 从备份恢复
          <input ref="restoreFileInput" type="file" accept=".json" hidden @change="onRestoreFile" />
        </label>
        <button class="btn sm" @click="showStats"><BarChart3 :size="13" />查看统计</button>
      </div>
      <div v-if="msg" style="margin-top: 10px; font-size: 0.78rem">{{ msg }}</div>
      <div v-if="statLine" style="margin-top: 8px; font-size: 0.76rem; color: var(--text-1)">{{ statLine }}</div>

      <hr style="border: none; border-top: 1px solid var(--line); margin: 18px 0" />

      <div class="section-title" style="color: var(--danger); font-size: 0.95rem">
        <AlertTriangle /> 危险区
      </div>
      <button class="btn danger sm" @click="wipeAll">清空本地数据库</button>
    </div>
  </div>
</template>
