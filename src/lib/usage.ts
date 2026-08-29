/** 每日用量记录：生成完成时累加（发送字数/接收字数/调用次数） */
import { db } from '../db'

function todayKey(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export async function recordUsage(charsIn: number, charsOut: number) {
  const date = todayKey()
  try {
    await db.transaction('rw', db.usage, async () => {
      const row = (await db.usage.get(date)) || { date, charsIn: 0, charsOut: 0, calls: 0 }
      row.charsIn += Math.max(0, charsIn)
      row.charsOut += Math.max(0, charsOut)
      row.calls += 1
      await db.usage.put(row)
    })
  } catch {
    // 统计失败不影响主流程
  }
}
