<script setup lang="ts">
/**
 * 用量统计：今日/累计收发字数、生成次数、按角色汇总、存储占用。
 */
import { computed, onMounted, ref } from 'vue'
import { BarChart3, HardDrive, MessagesSquare, Coins } from 'lucide-vue-next'
import { db } from '../db'
import { useCharactersStore } from '../stores/characters'

const characters = useCharactersStore()

const today = ref({ charsIn: 0, charsOut: 0, calls: 0 })
const total = ref({ charsIn: 0, charsOut: 0, calls: 0, days: 0 })
const recent = ref<{ date: string; charsIn: number; charsOut: number; calls: number }[]>([])
const perChar = ref<{ name: string; messages: number; chars: number }[]>([])
const storageMb = ref(0)

onMounted(async () => {
  if (!characters.loaded) await characters.load()
  const all = await db.usage.toArray()
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  today.value = all.find((r) => r.date === key) || { date: key, charsIn: 0, charsOut: 0, calls: 0 }
  total.value = {
    charsIn: all.reduce((n, r) => n + r.charsIn, 0),
    charsOut: all.reduce((n, r) => n + r.charsOut, 0),
    calls: all.reduce((n, r) => n + r.calls, 0),
    days: all.length,
  }
  recent.value = [...all].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14)

  // 按角色汇总
  const sessions = await db.chats.toArray()
  const charName = new Map(characters.list.map((c) => [c.uuid, c.name]))
  const agg = new Map<string, { messages: number; chars: number }>()
  for (const s of sessions) {
    let msgs = 0
    let charsN = 0
    for (const n of Object.values(s.nodes)) {
      msgs++
      charsN += (n.content || '').replace(/\s/g, '').length
    }
    if (!msgs) continue
    const label = charName.get(s.charUuid) || '未关联角色'
    const cur = agg.get(label) || { messages: 0, chars: 0 }
    cur.messages += msgs
    cur.chars += charsN
    agg.set(label, cur)
  }
  perChar.value = [...agg.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 10)

  const est = await navigator.storage?.estimate?.()
  if (est?.usage) storageMb.value = Math.round((est.usage / 1024 / 1024) * 10) / 10
})

function fmt(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n)
}
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner" style="max-width: 860px">
        <div class="section-title" style="font-size: 1.12rem"><BarChart3 /> 用量统计</div>

        <div class="stat-grid">
          <div class="card-panel stat-card">
            <MessagesSquare class="stat-icon" />
            <div class="stat-num">{{ today.calls }}</div>
            <div class="stat-label">今日生成次数</div>
          </div>
          <div class="card-panel stat-card">
            <Coins class="stat-icon" />
            <div class="stat-num">{{ fmt(today.charsOut) }}</div>
            <div class="stat-label">今日接收字数</div>
          </div>
          <div class="card-panel stat-card">
            <HardDrive class="stat-icon" />
            <div class="stat-num">{{ storageMb }} MB</div>
            <div class="stat-label">浏览器占用</div>
          </div>
        </div>

        <div class="card-panel" style="margin-bottom: 18px">
          <div class="section-title" style="font-size: 0.95rem">累计</div>
          <div class="report-grid">
            <div class="report-item"><div class="num">{{ total.calls }}</div><div class="label">生成次数</div></div>
            <div class="report-item"><div class="num">{{ fmt(total.charsIn) }}</div><div class="label">发送字数</div></div>
            <div class="report-item"><div class="num">{{ fmt(total.charsOut) }}</div><div class="label">接收字数</div></div>
            <div class="report-item"><div class="num">{{ total.days }}</div><div class="label">活跃天数</div></div>
          </div>
        </div>

        <div class="card-panel" style="margin-bottom: 18px">
          <div class="section-title" style="font-size: 0.95rem">近 14 天</div>
          <div v-if="recent.length" class="usage-bars">
            <div v-for="r in recent" :key="r.date" class="ubar-row">
              <span class="ubar-date">{{ r.date.slice(5) }}</span>
              <div class="ubar-track">
                <div class="ubar-fill" :style="{ width: Math.min(100, (r.charsOut / Math.max(1, Math.max(...recent.map(x => x.charsOut)))) * 100) + '%' }" />
              </div>
              <span class="ubar-val">{{ fmt(r.charsOut) }} 字 · {{ r.calls }} 次</span>
            </div>
          </div>
          <div v-else style="font-size: 0.8rem; color: var(--text-2)">暂无记录——开始对话后这里会出现每日柱状统计。</div>
        </div>

        <div class="card-panel">
          <div class="section-title" style="font-size: 0.95rem">按角色汇总（消息量 Top 10）</div>
          <table class="utable">
            <thead><tr><th>角色</th><th>消息</th><th>正文字数</th></tr></thead>
            <tbody>
              <tr v-for="r in perChar" :key="r.name">
                <td>{{ r.name }}</td><td>{{ r.messages }}</td><td>{{ fmt(r.chars) }}</td>
              </tr>
              <tr v-if="!perChar.length"><td colspan="3" style="color: var(--text-2)">暂无数据</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 18px; }
.stat-card { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.stat-icon { width: 18px; height: 18px; color: var(--accent-soft); }
.stat-num { font-size: 1.6rem; font-weight: 800; font-variant-numeric: tabular-nums; }
.stat-label { font-size: 0.74rem; color: var(--text-2); }
.usage-bars { display: flex; flex-direction: column; gap: 7px; }
.ubar-row { display: grid; grid-template-columns: 52px 1fr auto; gap: 10px; align-items: center; font-size: 0.76rem; color: var(--text-1); }
.ubar-track { height: 8px; background: var(--bg-3); border-radius: 4px; overflow: hidden; }
.ubar-fill { height: 100%; background: var(--accent-grad); border-radius: 4px; }
.ubar-val { color: var(--text-2); white-space: nowrap; }
.utable { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
.utable th, .utable td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
.utable th { color: var(--text-2); font-weight: 600; }
</style>
