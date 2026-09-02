/**
 * 记忆系统：对齐旧版经典记忆模型。
 * 存储：按会话 id 分组；条目 {summary, turn, sourceAssistantIds, classicMemory:true}
 * 注入：绑定的 AI 消息之后插入上下文消息（见 prompt.ts）。
 */
import { db } from '../db'
import type { ApiConfig } from './api'
import { chatOnce, fetchEmbeddings, cosineSimilarity } from './api'
import type { MemoryEntry, MsgNode } from '../types'
import { parseCot } from './cot'
import { uuid } from './id'
import { deepPlain } from './plain'

export async function listMemories(sessionId: string): Promise<MemoryEntry[]> {
  const rows = await db.memories.where('sessionId').anyOf([sessionId, 'global']).toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export async function addMemory(
  sessionId: string,
  summary: string,
  opts?: { source?: 'manual' | 'ai'; turn?: number; sourceAssistantIds?: string[] },
): Promise<MemoryEntry> {
  const entry: MemoryEntry = {
    id: uuid(),
    sessionId,
    summary: summary.trim(),
    turn: opts?.turn,
    sourceAssistantIds: opts?.sourceAssistantIds,
    enabled: true,
    classicMemory: true,
    source: opts?.source || 'manual',
    createdAt: Date.now(),
  }
  // deepPlain 剥掉响应式 Proxy（IndexedDB 无法结构化克隆 Proxy，同 chat store）
  await db.memories.put(deepPlain(entry))
  return entry
}

export async function updateMemory(entry: MemoryEntry) {
  await db.memories.put(deepPlain(entry))
}

export async function removeMemory(id: string) {
  await db.memories.delete(id)
}

const DISTILL_SYSTEM = '你是剧情记录员。把给定的 RP 聊天记录提炼成简洁的长期记忆要点，供后续剧情保持连贯。要求：只输出要点列表，每行一条、以 - 开头；保留关键事实（人物关系、承诺、地点、物品、身份揭示、重大转折），不要复述对白，总长不超过 {LIMIT} 字。'

/** 三档详略（对齐旧版）：精简 50-80 字 / 均衡 100-130 字 / 详细 200-250 字 */
export const SUMMARY_STYLES = {
  brief: { label: '精简', limit: 80, hint: '精简总结，50 到 80 字' },
  balanced: { label: '均衡', limit: 130, hint: '均衡总结，100 到 130 字' },
  detailed: { label: '详细', limit: 250, hint: '详细总结，200 到 250 字' },
} as const

export type SummaryStyle = keyof typeof SUMMARY_STYLES

/**
 * AI 提炼：取最近 limit 楼正文交给当前模型总结为记忆条目入库。
 * 每条记忆绑定其覆盖范围内最后一条 AI 消息的节点 id（注入时紧随其后）。
 */
export async function distillMemoriesFromChat(
  cfg: ApiConfig,
  chainNodes: MsgNode[],
  sessionId: string,
  limit = 30,
  style: SummaryStyle = 'balanced',
): Promise<number> {
  const slice = chainNodes.slice(-limit)
  const recent = slice
    .map((n) => `${n.role === 'user' ? n.name || '用户' : n.name || '角色'}: ${parseCot(n.content || '').main}`)
    .filter((t) => t.trim().length > 1)
    .join('\n\n')
  if (!recent.trim()) return 0

  const styleDef = SUMMARY_STYLES[style] || SUMMARY_STYLES.balanced
  const summary = await chatOnce(cfg, [
    { role: 'system', content: DISTILL_SYSTEM.replace('{LIMIT}', String(styleDef.limit)) + `本次要求：${styleDef.hint}。` },
    { role: 'user', content: recent },
  ])
  const lines = summary
    .split('\n')
    .map((l) => l.replace(/^\s*[-*·\d.、]+\s*/, '').trim())
    .filter((l) => l.length > 3)
  if (!lines.length) return 0

  // 绑定锚点：切片内最后一条 assistant 节点
  let anchorId: string | undefined
  for (let i = slice.length - 1; i >= 0; i--) {
    if (slice[i].role === 'assistant') { anchorId = slice[i].id; break }
  }

  let added = 0
  for (const line of lines) {
    await addMemory(sessionId, line, { source: 'ai', sourceAssistantIds: anchorId ? [anchorId] : undefined })
    added++
  }
  return added
}

/** 简易并发池：并发执行任务列表，聚合结果 */
async function runPool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = []
  let idx = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (idx < tasks.length) {
      const my = idx++
      results[my] = await tasks[my]()
    }
  })
  await Promise.all(workers)
  return results
}

export interface BackfillOptions {
  keepFloors: number
  concurrency: number
  style: SummaryStyle
  onProgress?: (done: number, total: number) => void
}

/**
 * 补录记忆（对齐旧版"补录"语义）：
 * 把「保留最近楼层」之外的历史按每块 10 楼分段，以指定并发数提炼入库。
 * 已有 AI 记忆绑定锚点之前的楼层自动跳过，避免重复补录。
 * @returns 新增记忆条数
 */
export async function backfillMemories(
  cfg: ApiConfig,
  chainNodes: MsgNode[],
  sessionId: string,
  opts: BackfillOptions,
): Promise<number> {
  const keep = Math.max(0, opts.keepFloors)
  if (chainNodes.length <= keep) return 0
  const older = chainNodes.slice(0, chainNodes.length - keep)
  // 分块：每块最多 10 楼
  const chunks: MsgNode[][] = []
  for (let i = 0; i < older.length; i += 10) chunks.push(older.slice(i, i + 10))
  if (!chunks.length) return 0

  // 跳过已补录块：该块末尾 assistant id 已被某条记忆绑定时跳过
  const existing = new Set<string>()
  for (const m of await listMemories(sessionId)) {
    for (const id of m.sourceAssistantIds || []) existing.add(id)
  }
  const pending = chunks.filter((c) => {
    const lastAssistant = [...c].reverse().find((n) => n.role === 'assistant')
    return !lastAssistant || !existing.has(lastAssistant.id)
  })

  let done = 0
  let added = 0
  const tasks = pending.map((chunk) => async () => {
    try {
      const n = await distillMemoriesFromChat(cfg, chunk, sessionId, chunk.length, opts.style)
      added += n
    } catch { /* 单块失败跳过 */ }
    done++
    opts.onProgress?.(done, pending.length)
  })
  await runPool(tasks, Math.max(1, opts.concurrency))
  return added
}

// ── 向量模式 ──

export interface EmbedConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 为单条记忆生成 embedding 并持久化 */
export async function embedMemory(cfg: EmbedConfig, entry: MemoryEntry): Promise<MemoryEntry> {
  if (!entry.summary.trim()) return entry
  const [vec] = await fetchEmbeddings(cfg, [entry.summary.trim()])
  if (vec?.length) {
    entry.embedding = vec
    await db.memories.put(deepPlain(entry))
  }
  return entry
}

/** 批量为缺少 embedding 的记忆生成向量 */
export async function ensureEmbeddings(
  cfg: EmbedConfig,
  entries: MemoryEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const pending = entries.filter((e) => !e.embedding?.length && e.summary.trim())
  if (!pending.length) return 0
  // 分批，每批最多 20 条
  const batchSize = 20
  let done = 0
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    try {
      const vecs = await fetchEmbeddings(cfg, batch.map((e) => e.summary.trim()))
      for (let j = 0; j < batch.length; j++) {
        if (vecs[j]?.length) {
          batch[j].embedding = vecs[j]
          await db.memories.put(deepPlain(batch[j]))
        }
      }
    } catch { /* 单批失败跳过 */ }
    done += batch.length
    onProgress?.(done, pending.length)
  }
  return pending.length
}

/** 向量检索：取与 query 最相似的 topK 条记忆 */
export async function searchVectorMemories(
  cfg: EmbedConfig,
  sessionIds: string[],
  query: string,
  topK = 8,
): Promise<MemoryEntry[]> {
  const all = await db.memories.where('sessionId').anyOf(sessionIds).toArray()
  const enabled = all.filter((m) => m.enabled !== false && m.summary?.trim())
  if (!enabled.length) return []

  // 确保所有记忆都有 embedding
  await ensureEmbeddings(cfg, enabled)

  // 生成 query 向量
  const [qvec] = await fetchEmbeddings(cfg, [query.slice(0, 2000)])
  if (!qvec?.length) return []

  // 余弦相似度排序
  const scored = enabled
    .filter((m) => m.embedding?.length)
    .map((m) => ({ m, score: cosineSimilarity(qvec, m.embedding!) }))
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map((x) => x.m)
}

// ── 向量模式：对话原文分片自动入库（对齐旧版 _doEmbedMemoryForMessages，不依赖聊天副模型）──

/** 入库前清洗：去思维链 / UI 更新块 / 代码块 / 行内代码 / HTML 标签 / 冗余空白 */
export function cleanTextForVector(raw: string): string {
  let s = parseCot(raw || '').main
  s = s.replace(/<ui_template_updates>[\s\S]*?<\/ui_template_updates>/gi, ' ')
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/`[^`\n]*`/g, ' ')
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/\r/g, '')
  return s.trim()
}

const CHUNK_TARGET = 350 // 单片目标字符数（短段合并到此附近）
const CHUNK_MAX = 800 // 单片硬上限（超出按句切）

/** 段落分片：短段合并、长段按句拆（对齐旧版 split/merge 语义） */
export function chunkText(raw: string): string[] {
  const paras = raw.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 1)
  const out: string[] = []
  let buf = ''
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = '' }
  for (const p of paras) {
    if (p.length > CHUNK_MAX) {
      flush()
      const sentences = p.match(/[^。！？!?….]+[。！？!?….]*/g) || [p]
      let acc = ''
      for (const s of sentences) {
        if (acc && (acc.length + s.length) > CHUNK_TARGET) { out.push(acc.trim()); acc = s }
        else acc += s
      }
      if (acc.trim()) out.push(acc.trim())
      continue
    }
    if (buf && buf.length + p.length > CHUNK_TARGET) flush()
    buf = buf ? buf + '\n' + p : p
  }
  flush()
  return out
}

/**
 * 向量模式自动入库：把链路中尚未覆盖的对话原文清洗 → 分片 → embedding → 存为 kind:'chunk' 记忆。
 * 只需 embedding 接口，不需要聊天副模型。已被任一记忆（sourceTurnIds/sourceAssistantIds）
 * 覆盖的节点自动跳过，可重复调用（增量）。
 * @returns 新增条目数
 */
export async function autoIngestVectorFloors(
  cfg: EmbedConfig,
  chainNodes: MsgNode[],
  sessionId: string,
): Promise<number> {
  const existing = await db.memories.where('sessionId').anyOf([sessionId, 'global']).toArray()
  const covered = new Set<string>()
  for (const m of existing) {
    for (const id of [...(m.sourceTurnIds || []), ...(m.sourceAssistantIds || [])]) {
      if (id) covered.add(id)
    }
  }

  // 连续同角色节点合并为一组（片段绑定其全部来源节点）
  const groups: { ids: string[]; text: string }[] = []
  for (const n of chainNodes) {
    if (n.role !== 'user' && n.role !== 'assistant') continue
    if (covered.has(n.id)) continue
    const body = cleanTextForVector(n.content || '')
    if (body.length < 2) continue
    const speaker = n.role === 'user' ? (n.name || '用户') : (n.name || '角色')
    const piece = `${speaker}：${body}`
    const last = groups[groups.length - 1]
    if (last && last.ids.length && chainNodes.find((x) => x.id === last.ids[last.ids.length - 1])?.role === n.role) {
      last.text += '\n' + piece
      last.ids.push(n.id)
    } else {
      groups.push({ ids: [n.id], text: piece })
    }
  }
  if (!groups.length) return 0

  // 每组分片，记录来源
  const pieces: { text: string; ids: string[] }[] = []
  for (const g of groups) {
    for (const c of chunkText(g.text)) {
      if (c.trim().length >= 2) pieces.push({ text: c, ids: g.ids })
    }
  }
  if (!pieces.length) return 0

  // 分批 embedding + 入库（每批最多 20）
  let added = 0
  const now = Date.now()
  for (let i = 0; i < pieces.length; i += 20) {
    const batch = pieces.slice(i, i + 20)
    let vecs: number[][] = []
    try {
      vecs = await fetchEmbeddings(cfg, batch.map((p) => p.text))
    } catch {
      continue // 整批失败跳过（embedding 接口不可用时不产生空条目）
    }
    const rows: MemoryEntry[] = []
    for (let j = 0; j < batch.length; j++) {
      if (!vecs[j]?.length) continue
      rows.push({
        id: uuid(),
        sessionId,
        summary: batch[j].text,
        sourceTurnIds: [...batch[j].ids],
        kind: 'chunk',
        enabled: true,
        classicMemory: true,
        source: 'ai',
        createdAt: now + added,
        embedding: vecs[j],
      })
      added++
    }
    if (rows.length) await db.memories.bulkPut(deepPlain(rows))
  }
  return added
}

