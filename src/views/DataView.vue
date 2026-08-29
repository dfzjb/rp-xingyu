<script setup lang="ts">
/**
 * 「导入 / 导出」：
 * - 导出：全库打包为 legacy_backup_日期.json
 * - 导入：选择备份 JSON → 一键写入本地 → 显示「导入完成」计数
 * 另附新站原生完整备份（保留非当前分支等全部树数据）作为补充选项。
 * 角色卡广场已移至独立视图（侧边栏「卡片广场」）。
 */
import { ref } from 'vue'
import { Download, FolderInput, FileJson2, DatabaseBackup, ArrowRight, MessagesSquare } from 'lucide-vue-next'
import { NSelect } from 'naive-ui'
import { useChatStore } from '../stores/chat'
import { useCharactersStore } from '../stores/characters'
import { migrateLegacyData, parseLegacyBackupFile } from '../lib/migrate'
import { exportLegacyBundle } from '../lib/legacyExport'
import { exportAll, restoreAll, downloadJson, db } from '../db'
import type { MigrateReport } from '../types'
import { uuid } from '../lib/id'
import { toast } from '../lib/toast'

const emit = defineEmits<{ (e: 'finish'): void }>()

const chat = useChatStore()
const characters = useCharactersStore()

// ── ST JSONL 聊天记录导入 ──
const jsonlInput = ref<HTMLInputElement | null>(null)
const jsonlCharUuid = ref('')
const jsonlBusy = ref(false)

async function onJsonlPicked(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  jsonlBusy.value = true
  try {
    if (!jsonlCharUuid.value) throw new Error('请先选择要挂载到的角色')
    const lines = (await f.text()).trim().split('\n')
    type JsonlMsg = { name?: string; is_user?: boolean; mes?: string }
    const msgs: JsonlMsg[] = []
    for (const line of lines) {
      try {
        const o = JSON.parse(line)
        if (o && typeof o.mes === 'string') msgs.push(o as JsonlMsg)
      } catch { /* 跳过元数据行 */ }
    }
    if (!msgs.length) throw new Error('未找到消息（首行可能是元数据）')

    const nodes: Record<string, import('../types').MsgNode> = {}
    let prev: string | null = null
    for (const m of msgs) {
      const id = uuid()
      nodes[id] = {
        id,
        role: m.is_user ? 'user' : 'assistant',
        name: m.name || '',
        content: m.mes || '',
        isSelf: !!m.is_user,
        createdAt: Date.now(),
        parentId: prev,
        childrenIds: [],
      }
      if (prev) nodes[prev].childrenIds.push(id)
      prev = id
    }
    const s = {
      id: uuid(),
      charUuid: jsonlCharUuid.value,
      name: `JSONL ${f.name.replace(/\.jsonl$/i, '').slice(0, 16)}`,
      rootNodeId: Object.keys(nodes)[0] || null,
      activeNodeId: prev,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      origin: 'new' as const,
      nodes,
    }
    await db.chats.put(s)
    await chat.load()
    toast.success(`已导入 ${Object.keys(nodes).length} 条消息为本地会话`)
  } catch (err) {
    importError.value = `JSONL 导入失败：${(err as Error).message}`
  } finally {
    jsonlBusy.value = false
    if (jsonlInput.value) jsonlInput.value.value = ''
  }
}

// ── 旧版格式导出 ──
const exporting = ref(false)
const exportMsg = ref('')

async function doExport() {
  exporting.value = true
  exportMsg.value = ''
  try {
    const { d1, count } = await exportLegacyBundle()
    const bundle = { d1, ls: {} as Record<string, string> }
    const d = new Date()
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    downloadJson(bundle, `legacy_backup_${stamp}.json`)
    exportMsg.value = `已下载备份文件（${count} 条记录）`
  } catch (err) {
    exportMsg.value = `出错: ${(err as Error).message}`
  } finally {
    exporting.value = false
  }
}

// ── 新站原生完整导出 ──
async function doNativeExport() {
  exporting.value = true
  exportMsg.value = ''
  try {
    const data = await exportAll()
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    downloadJson(data, `rp-site-full-backup-${stamp}.json`)
    exportMsg.value = '已下载完整备份（含全部分支与原始键存档）'
  } catch (err) {
    exportMsg.value = `出错: ${(err as Error).message}`
  } finally {
    exporting.value = false
  }
}

// ── 导入 ──
const importing = ref(false)
const importError = ref('')
const importOk = ref('')
const report = ref<MigrateReport | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

async function onFilePicked(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  importError.value = ''
  importOk.value = ''
  report.value = null
  importing.value = true
  try {
    const obj = JSON.parse(await f.text())
    if ((obj as { format?: string }).format === 'rp-site-backup') {
      // 新站原生备份：整体恢复并刷新
      if (!confirm('恢复该备份将覆盖当前全部本地数据，确定继续？')) return
      await restoreAll(obj)
      importOk.value = '完整备份已恢复，即将刷新…'
      setTimeout(() => location.reload(), 900)
      return
    }
    // 旧版备份 / 平面键值表：映射写入（不覆盖已有数据）
    const keys = parseLegacyBackupFile(obj)
    report.value = await migrateLegacyData(keys, f.name)
    await Promise.all([characters.load(), chat.load()])
    const total = report.value.characters + report.value.chats + report.value.branches +
      report.value.personas + report.value.kvKeys
    importOk.value = `导入完成！共 ${total} 条记录`
  } catch (err) {
    importError.value = `出错: ${(err as Error).message}`
  } finally {
    importing.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner" style="max-width: 720px">
        <div class="section-title" style="font-size: 1.12rem"><FolderInput /> 导入 / 导出</div>

        <!-- 导出 -->
        <div class="card-panel spotlight-card" style="margin-bottom: 16px" @mousemove="(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          ;(e.currentTarget as HTMLElement).style.setProperty('--mx', `${e.clientX - r.left}px`)
          ;(e.currentTarget as HTMLElement).style.setProperty('--my', `${e.clientY - r.top}px`)
        }">
          <div class="section-title"><Download /> 导出数据</div>
          <p style="font-size: 0.82rem; color: var(--text-1); line-height: 1.8; margin-bottom: 14px">
            把本浏览器的全部数据（角色卡、聊天记录、人设、设置）打包下载为
            <code>legacy_backup_日期.json</code>。<br />
            可在本站或其他设备上恢复。
          </p>
          <button class="btn primary" style="padding: 11px 26px" :disabled="exporting" @click="doExport">
            <Download :size="15" />{{ exporting ? '读取中…' : '导出数据' }}
          </button>
          <div v-if="exportMsg" class="ok-box" style="margin-top: 12px">{{ exportMsg }}</div>
        </div>

        <!-- 导入 -->
        <div class="card-panel spotlight-card" style="margin-bottom: 16px" @mousemove="(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          ;(e.currentTarget as HTMLElement).style.setProperty('--mx', `${e.clientX - r.left}px`)
          ;(e.currentTarget as HTMLElement).style.setProperty('--my', `${e.clientY - r.top}px`)
        }">
          <div class="section-title"><FolderInput /> 导入数据</div>
          <p style="font-size: 0.82rem; color: var(--text-1); line-height: 1.8; margin-bottom: 14px">
            选择之前导出的 <code>legacy_backup_*.json</code>，将自动导入其中的全部角色卡和聊天记录（含分支）。<br />
            已存在的同名数据会跳过，不会覆盖。
          </p>
          <label class="btn primary" style="cursor: pointer; padding: 11px 26px">
            <FolderInput :size="15" />{{ importing ? '解析文件中…' : '选择备份文件' }}
            <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="onFilePicked" />
          </label>

          <template v-if="importOk && report">
            <div class="ok-box" style="margin-top: 14px">{{ importOk }}</div>
            <div class="report-grid">
              <div class="report-item"><div class="num">{{ report.characters }}</div><div class="label">角色卡</div></div>
              <div class="report-item"><div class="num">{{ report.chats }}</div><div class="label">主线会话</div></div>
              <div class="report-item"><div class="num">{{ report.branches }}</div><div class="label">分支会话</div></div>
              <div class="report-item"><div class="num">{{ report.messages }}</div><div class="label">消息楼层</div></div>
              <div class="report-item"><div class="num">{{ report.personas }}</div><div class="label">人设</div></div>
              <div class="report-item"><div class="num">{{ report.kvKeys }}</div><div class="label">其余键存档</div></div>
            </div>
            <div v-if="report.warnings.length" class="warn-box">
              <div v-for="w in report.warnings" :key="w">⚠ {{ w }}</div>
            </div>
            <button class="btn sm primary" @click="emit('finish')">去对话 <ArrowRight :size="13" /></button>
          </template>
          <div v-if="importError" class="danger-box" style="margin-top: 12px">{{ importError }}</div>

          <!-- JSONL 聊天导入 -->
          <div style="margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--line-strong)">
            <div class="section-title" style="font-size: 0.9rem"><MessagesSquare /> 导入酒馆聊天记录（JSONL）</div>
            <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center">
              <NSelect
                v-model:value="jsonlCharUuid"
                size="small"
                filterable
                :options="[{ label: '选择挂载的角色…', value: '' }, ...characters.list.map((c) => ({ label: c.name, value: c.uuid }))]"
                style="max-width: 260px"
              />
              <label class="btn sm" style="cursor: pointer">
                {{ jsonlBusy ? '导入中…' : '📂 选择 .jsonl 文件' }}
                <input ref="jsonlInput" type="file" accept=".jsonl,application/jsonl" hidden @change="onJsonlPicked" />
              </label>
            </div>
          </div>
        </div>

        <!-- 补充：原生完整备份 -->
        <div class="card-panel">
          <div class="section-title" style="font-size: 0.9rem"><DatabaseBackup /> 完整备份（新站原生格式，可选）</div>
          <p style="font-size: 0.78rem; color: var(--text-2); line-height: 1.7; margin-bottom: 10px">
            此格式仅包含每个会话「当前选用的分支」。若需保留重 roll 的全部历史版本，请使用完整备份。
          </p>
          <button class="btn sm" :disabled="exporting" @click="doNativeExport">
            <FileJson2 :size="14" />下载完整备份
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
