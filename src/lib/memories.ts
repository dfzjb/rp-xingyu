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

  // 余弦相似度排序（vectorScore 运行时携带，注入时转为 similarity 百分比）
  const scored = enabled
    .filter((m) => m.embedding?.length)
    .map((m) => ({ m, score: cosineSimilarity(qvec, m.embedding!) }))
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map((x) => ({ ...x.m, vectorScore: x.score }))
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

// ── 旧版同构分片构造（buildVectorMemoryFragments / stripVectorMemoryCode 逐字对齐）──

const VECTOR_MAX_PARAGRAPH = 1800 // 旧版 MEMORY_VECTOR_MAX_PARAGRAPH_LENGTH
const VECTOR_MERGE_MAX = 400 // 旧版 MEMORY_VECTOR_MERGE_MAX_LENGTH
const VECTOR_BATCH_SIZE = 16 // 旧版 MEMORY_VECTOR_BATCH_SIZE

/** 保存记忆前的文本清洗（旧版 stripVectorMemoryCode 同构）：剥思维链/UI 更新块/代码块/HTML，逐行剔除代码样式行 */
export function stripMemoryCode(raw: string): string {
  let result = parseCot(raw || '').main
    .replace(/<ui_template_updates>[\s\S]*?<\/ui_template_updates>/gi, '')
    .replace(/<image>[\s\S]*?<\/image>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<html[\s\S]*?<\/html>/gi, '')
    .replace(/<(script|style|template|svg|canvas|iframe|object|embed|head|link|meta)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|template|svg|canvas|iframe|object|embed|link|meta|input|img|br|hr)\b[^>]*\/?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/`[^`\n]{1,200}`/g, '')

  const isCodeLikeLine = (line: string): boolean => {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (/^<\/?[a-z][\w:-]*(\s|>|\/>)/i.test(trimmed)) return true
    if (/^[{}()[\];,]+$/.test(trimmed)) return true
    if (/^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch)\b/.test(trimmed)) return true
    if (/^(#include|using\s+namespace|public:|private:|protected:|def\s+|from\s+\S+\s+import\s+)/.test(trimmed)) return true
    if (/^(@click|v-if|v-for|v-model|class=|style=|id=|data-|aria-)/i.test(trimmed)) return true
    if (/^[.#]?[a-zA-Z0-9_-]+\s*\{/.test(trimmed)) return true
    if (/[{};]/.test(trimmed) && /(=>|===|!==|&&|\|\||;\s*$|:\s*function|\bconsole\.|\bdocument\.|\bwindow\.)/.test(trimmed)) return true
    if (/<\/?[a-z][\w:-]*[\s\S]*?>/i.test(trimmed) && !/[，。！？、]/.test(trimmed)) return true
    return false
  }

  const cleanedLines: string[] = []
  for (const line of result.split(/\r?\n/)) {
    if (isCodeLikeLine(line)) continue
    cleanedLines.push(line)
  }
  result = cleanedLines.join('\n')
    .replace(/<\/?[a-z][\w:-]*\b[^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return result
}

/** 长段按句切（旧版 splitLongMemoryParagraph：超长时优先在句读处断开，且断点不早于 55% 处） */
export function splitLongMemoryParagraph(paragraph: string, maxLength = VECTOR_MAX_PARAGRAPH): string[] {
  const text = String(paragraph || '').trim()
  if (!text) return []
  if (text.length <= maxLength) return [text]
  const parts: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    const windowText = remaining.slice(0, maxLength)
    const breakAt = Math.max(
      windowText.lastIndexOf('。'),
      windowText.lastIndexOf('！'),
      windowText.lastIndexOf('？'),
      windowText.lastIndexOf('.'),
      windowText.lastIndexOf('!'),
      windowText.lastIndexOf('?'),
      windowText.lastIndexOf('\n'),
    )
    const cutAt = breakAt > Math.floor(maxLength * 0.55) ? breakAt + 1 : maxLength
    parts.push(remaining.slice(0, cutAt).trim())
    remaining = remaining.slice(cutAt).trim()
  }
  if (remaining) parts.push(remaining)
  return parts.filter(Boolean)
}

/** 空行分段 → 每段超长再切（旧版 splitMemoryParagraphs） */
export function splitMemoryParagraphs(text: string): string[] {
  const clean = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!clean) return []
  const rawParagraphs = clean
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean)
  return rawParagraphs.flatMap((p) => splitLongMemoryParagraph(p))
}

/** 小段合并到 maxLength 以内（旧版 mergeSmallMemoryParagraphs，保留段落序号区间） */
export function mergeSmallMemoryParagraphs(
  paragraphs: string[],
  maxLength = VECTOR_MERGE_MAX,
): { text: string; start: number; end: number }[] {
  const merged: { text: string; start: number; end: number }[] = []
  let current: { text: string; start: number; end: number } | null = null
  const flush = () => {
    if (!current) return
    merged.push(current)
    current = null
  }
  paragraphs.forEach((paragraph, index) => {
    const text = String(paragraph || '').trim()
    if (!text) return
    const paragraphNo = index + 1
    if (!current) {
      current = { text, start: paragraphNo, end: paragraphNo }
      return
    }
    const candidateText = `${current.text}\n\n${text}`
    if (candidateText.length <= maxLength) {
      current.text = candidateText
      current.end = paragraphNo
      return
    }
    flush()
    current = { text, start: paragraphNo, end: paragraphNo }
  })
  flush()
  return merged
}

/** 内容指纹（旧版 getVectorMemoryContentFingerprint）：去空白/标点后 ≥80 字取前 1000 */
export function memoryContentFingerprint(text: string): string {
  const normalized = String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。、“”‘’：；！？,.!?;:"'`~]/g, '')
  return normalized.length >= 80 ? normalized.slice(0, 1000) : ''
}

function trimMemoryText(text: string, maxLength = 900): string {
  const clean = String(text || '').replace(/\n{3,}/g, '\n\n').trim()
  if (clean.length <= maxLength) return clean
  return `${clean.slice(0, maxLength)}...`
}

/** 一条旧版式记忆分片 */
export interface VectorFragment {
  turn: number
  sequence: number
  paragraph: string
  sourceText: string
  sourceRole: 'user' | 'assistant' | 'mixed'
  sourceName: string
  ids: string[] // 覆盖的节点 id（user+assistant，用于增量去重）
}

/**
 * 一轮对话 → 旧版式记忆分片（buildVectorMemoryFragments 同构）：
 * assistant 段加"角色卡："前缀；存在 AI 段时把"用户：…"整行前置到每条片段；
 * 无 AI 段（纯用户输入轮）则用户段独立成片并自带"用户："前缀。
 */
export function buildTurnVectorFragments(turnNodes: MsgNode[], turn: number): VectorFragment[] {
  const userBlocks: { idPart: string; speaker: string; role: 'user' | 'assistant'; text: string; ids: string[] }[] = []
  const roleBlocks: { idPart: string; speaker: string; role: 'user' | 'assistant'; text: string; ids: string[] }[] = []

  turnNodes.forEach((n, messageIndex) => {
    if (n.role !== 'user' && n.role !== 'assistant') return
    const speaker = n.role === 'user' ? n.name || '用户' : n.name || '角色卡'
    const sourceLabel = n.role === 'user' ? '用户' : '角色卡'
    const paragraphs = splitMemoryParagraphs(stripMemoryCode(n.content || '')).flatMap((p) =>
      splitLongMemoryParagraph(p, VECTOR_MERGE_MAX),
    )
    const groups = mergeSmallMemoryParagraphs(paragraphs)
    groups.forEach((group) => {
      const block = {
        idPart: `${messageIndex}:${n.role}:${group.start}-${group.end}`,
        speaker,
        role: n.role as 'user' | 'assistant',
        text: group.text,
        ids: [n.id],
      }
      if (n.role === 'user') userBlocks.push(block)
      else roleBlocks.push({ ...block, text: `${sourceLabel}：${group.text}` })
    })
  })

  const userText = userBlocks.map((b) => b.text).filter(Boolean).join('\n\n')
  const userLine = userText ? `用户：${userText}` : ''

  const sourceBlocks =
    roleBlocks.length > 0
      ? roleBlocks
      : userBlocks.map((b) => ({ ...b, text: `用户：${b.text}` }))

  return sourceBlocks.map((block, index) => {
    const includeUser = roleBlocks.length > 0 && !!userLine
    const paragraph = [includeUser ? userLine : '', block.text].filter(Boolean).join('\n')
    return {
      turn,
      sequence: index + 1,
      paragraph,
      sourceText: [`第 ${turn} 轮`, paragraph].filter(Boolean).join('\n'),
      sourceRole: (includeUser ? 'mixed' : block.role) as 'user' | 'assistant' | 'mixed',
      sourceName: includeUser
        ? [userBlocks[0]?.speaker, block.speaker].filter(Boolean).join(' + ')
        : block.speaker,
      ids: includeUser ? [...new Set([...userBlocks.flatMap((b) => b.ids), ...block.ids])] : block.ids,
    }
  })
}

/**
 * 总结模式每轮提炼：把刚完成的一轮（用户+AI）提炼为记忆条目。
 * 轮内任一节点已被既有记忆覆盖时跳过（防续写/重 roll 重复入库）。
 * @returns 新增记忆条数
 */
export async function distillTurnMemory(
  cfg: ApiConfig,
  turnNodes: MsgNode[],
  sessionId: string,
  turn: number,
  style: SummaryStyle = 'balanced',
): Promise<number> {
  const covered = new Set<string>()
  for (const m of await listMemories(sessionId)) {
    for (const id of [...(m.sourceTurnIds || []), ...(m.sourceAssistantIds || [])]) if (id) covered.add(id)
  }
  // 轮级去重：轮内任一节点已被既有记忆覆盖即整轮跳过（旧版 autoExtract 以轮为单位，续写/重 roll 不重复入库）
  if (turnNodes.some((n) => covered.has(n.id))) return 0
  const usable = turnNodes.filter((n) => n.role === 'user' || n.role === 'assistant')
  if (!usable.length) return 0
  const recent = usable
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

  let anchorId: string | undefined
  for (let i = usable.length - 1; i >= 0; i--) {
    if (usable[i].role === 'assistant') { anchorId = usable[i].id; break }
  }
  let added = 0
  for (const line of lines) {
    await addMemory(sessionId, line, { source: 'ai', turn, sourceAssistantIds: anchorId ? [anchorId] : undefined })
    added++
  }
  return added
}

/**
 * 向量模式自动入库（旧版 _doEmbedMemoryForMessages 对齐）：
 * 链路按轮分组（user 节点起新轮，开场白等无前置用户输入的 AI 楼不参与）→
 * 未覆盖的轮按旧版规则分片 → 内容指纹去重（存量 + 批内）→ 按 16/批 embedding 入库。
 * 幂等：已被记忆覆盖的节点自动跳过，可每轮重复调用。
 * @returns 新增条目数
 */
export async function autoIngestVectorFloors(
  cfg: EmbedConfig,
  chainNodes: MsgNode[],
  sessionId: string,
): Promise<number> {
  const existing = await db.memories.where('sessionId').anyOf([sessionId, 'global']).toArray()
  const covered = new Set<string>()
  const existingFingerprints = new Set<string>()
  for (const m of existing) {
    for (const id of [...(m.sourceTurnIds || []), ...(m.sourceAssistantIds || [])]) {
      if (id) covered.add(id)
    }
    const fp = m.contentFingerprint || memoryContentFingerprint(m.paragraph || m.summary || '')
    if (fp) existingFingerprints.add(fp)
  }

  // 按轮分组：user 节点起新轮（开场白等无前置用户输入的 AI 楼跳过，对齐旧版"完整轮"语义）
  const turns: { turn: number; nodes: MsgNode[] }[] = []
  let turnNo = 0
  for (const n of chainNodes) {
    if (n.role !== 'user' && n.role !== 'assistant') continue
    if (n.role === 'user') {
      turnNo++
      turns.push({ turn: turnNo, nodes: [n] })
    } else if (turns.length) {
      turns[turns.length - 1].nodes.push(n)
    }
  }

  // 整轮已覆盖跳过；轮内部分覆盖（重 roll/续写）只取未覆盖节点参与分片
  const fragments: VectorFragment[] = []
  for (const t of turns) {
    const nodes = t.nodes.filter((n) => !covered.has(n.id))
    if (!nodes.length) continue
    fragments.push(...buildTurnVectorFragments(nodes, t.turn))
  }

  // 内容指纹去重（旧版 getVectorFragmentFingerprint 语义：存量 + 本批 pending）
  const pending = new Set(existingFingerprints)
  const deduped = fragments.filter((f) => {
    const fp = memoryContentFingerprint(f.paragraph || f.sourceText)
    if (fp && pending.has(fp)) return false
    if (fp) pending.add(fp)
    return true
  })
  if (!deduped.length) return 0

  let added = 0
  const now = Date.now()
  for (let i = 0; i < deduped.length; i += VECTOR_BATCH_SIZE) {
    const batch = deduped.slice(i, i + VECTOR_BATCH_SIZE)
    let vecs: number[][] = []
    try {
      vecs = await fetchEmbeddings(cfg, batch.map((f) => f.sourceText))
    } catch {
      continue // 整批失败跳过（embedding 接口不可用时不产生空条目）
    }
    const rows: MemoryEntry[] = []
    for (let j = 0; j < batch.length; j++) {
      const f = batch[j]
      if (!vecs[j]?.length) continue
      rows.push({
        id: uuid(),
        sessionId,
        summary: trimMemoryText(f.paragraph, 900),
        turn: f.turn,
        sourceTurnIds: f.ids,
        kind: 'chunk',
        enabled: true,
        classicMemory: true,
        source: 'ai',
        createdAt: now + added,
        embedding: vecs[j],
        paragraph: f.paragraph,
        sourceRole: f.sourceRole,
        sourceName: f.sourceName,
        contentFingerprint: memoryContentFingerprint(f.paragraph || f.sourceText),
      })
      added++
    }
    if (rows.length) await db.memories.bulkPut(deepPlain(rows))
  }
  return added
}

