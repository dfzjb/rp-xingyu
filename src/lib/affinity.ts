/**
 * 好感度 Behavior Engine（Artemis 五维模型的 Web 移植，重构为六维三轴 + 多 NPC）：
 * - 三组相对属性轴（雷达图上每组对置 180°，方向相反、此消彼长）：
 *   关注轴 interest 兴趣 ↔ annoyance 厌烦
 *   心动轴 attraction 吸引 ↔ disgust 反感
 *   自在轴 trust 信任 ↔ cringe 尴尬（均 0-100）
 * - 9 段关系阶段：敌对 → 警惕 → 陌生 → 初识 → 熟识 → 朋友 → 好友 → 亲密 → 挚爱
 * - 4 级冲突：0 无冲突 / 1 摩擦 / 2 争执 / 3 冷战 / 4 决裂（自动推导 + 手动覆盖）
 * - 按 会话+出场角色名 建档；AI 每轮自主评判出场 NPC 并平滑合并
 */
import { db } from '../db'
import type { ApiConfig } from './api'
import { chatOnce } from './api'
import type { MsgNode, NpcAffinity } from '../types'
import { parseCot } from './cot'
import { deepPlain } from './plain'

export type { NpcAffinity }

export const AFFINITY_DIMS = [
  { key: 'interest', label: '兴趣' },
  { key: 'trust', label: '信任' },
  { key: 'attraction', label: '吸引' },
  { key: 'annoyance', label: '厌烦' },
  { key: 'cringe', label: '尴尬' },
  { key: 'disgust', label: '反感' },
] as const

export type AffinityDimKey = (typeof AFFINITY_DIMS)[number]['key']

/**
 * 三组相对属性轴（单一事实源）：编辑弹窗的双端滑条与雷达图的对轴直径都从这里派生。
 * 每轴两方向此消彼长：手动编辑用一根 -100~100 的滑条表达，正值 = 正向维度，负值 = 负向维度。
 */
export const AFFINITY_AXES = [
  { name: '关注轴', pos: 'interest', posLabel: '兴趣', neg: 'annoyance', negLabel: '厌烦' },
  { name: '心动轴', pos: 'attraction', posLabel: '吸引', neg: 'disgust', negLabel: '反感' },
  { name: '自在轴', pos: 'trust', posLabel: '信任', neg: 'cringe', negLabel: '尴尬' },
] as const

/** 新档案默认值：刚出场的 NPC 从「陌生」起步 */
const DIM_DEFAULTS: Record<AffinityDimKey, number> = {
  interest: 15, trust: 8, attraction: 5, annoyance: 0, cringe: 0, disgust: 0,
}

export function defaultNpcAffinity(sessionId: string, npcName: string): NpcAffinity {
  return {
    id: `${sessionId}:${npcName}`,
    sessionId,
    npcName,
    ...DIM_DEFAULTS,
    conflictOverride: null,
    updatedAt: Date.now(),
  }
}

/** 兼容旧档案：补齐缺失维度；顺手剥掉七维试验期遗留的 respect/dependence 字段 */
export function normalizeAffinity(row: NpcAffinity): NpcAffinity {
  const a = { ...row } as NpcAffinity & Record<string, unknown>
  delete a.respect
  delete a.dependence
  for (const d of AFFINITY_DIMS) {
    if (!Number.isFinite(a[d.key])) a[d.key] = DIM_DEFAULTS[d.key]
  }
  return a
}

// ── 9 段关系阶段 ──

/** 阈值从高到低排列；deriveStage 取第一个 score >= 阈值 的档位 */
const STAGES: [number, string][] = [
  [75, '挚爱'], [60, '亲密'], [48, '好友'], [34, '朋友'], [20, '熟识'],
  [10, '初识'], [0, '陌生'], [-30, '警惕'], [-999, '敌对'],
]

/** 阶段 → 注入提示词的行为提示（约束 NPC 言行分寸） */
const STAGE_HINTS: Record<string, string> = {
  敌对: '敌视用户，言语带刺，抗拒接近',
  警惕: '防备心强，只维持最低限度的交流',
  陌生: '刚认识，客气而疏远',
  初识: '有了初步好感，愿意简单交谈',
  熟识: '已经熟悉，可以自然闲聊',
  朋友: '把用户当朋友，相处放松',
  好友: '交情深厚，会主动分享心事',
  亲密: '关系亲密，不介意肢体接触',
  挚爱: '深爱用户，一举一动都流露爱意',
}

// ── 权重 ──

/** 信任是关系基石权重最高；吸引推动恋爱线；负面里反感比尴尬更伤关系；正负权重总量对称（各 3.4） */
const DIM_WEIGHTS: Record<AffinityDimKey, number> = {
  interest: 1.0, trust: 1.3, attraction: 1.1,
  annoyance: 1.2, cringe: 0.9, disgust: 1.3,
}
const NEG_DAMP = 0.7 // 负面按 70% 计入：一次尴尬不该清空长期积累，但持续反感仍会压垮关系

/** 综合分 = 加权正面均值 − 加权负面均值 × NEG_DAMP，范围约 [-70, 100] */
export function affinityScore(a: NpcAffinity): number {
  let pos = 0, posW = 0, neg = 0, negW = 0
  for (const d of AFFINITY_DIMS) {
    const w = DIM_WEIGHTS[d.key]
    const v = Number.isFinite(a[d.key]) ? a[d.key] : DIM_DEFAULTS[d.key]
    if (d.key === 'annoyance' || d.key === 'cringe' || d.key === 'disgust') { neg += w * v; negW += w } else { pos += w * v; posW += w }
  }
  return Math.round((pos / posW - (neg / negW) * NEG_DAMP) * 10) / 10
}

// ── 4 级冲突 ──

export interface ConflictLevel { level: 0 | 1 | 2 | 3 | 4; name: string; desc: string }

export const CONFLICT_LEVELS: ConflictLevel[] = [
  { level: 0, name: '无冲突', desc: '关系平稳，没有未化解的矛盾。' },
  { level: 1, name: '摩擦', desc: '轻微口角与小别扭；态度略带敷衍，但很快翻篇。' },
  { level: 2, name: '争执', desc: '发生过激烈争吵；信任受损，对话带着火药味。' },
  { level: 3, name: '冷战', desc: '几乎不再主动说话；回避眼神，需要郑重道歉才能解冻。' },
  { level: 4, name: '决裂', desc: '关系已破裂到临界点；只有重大补救才有一丝转机。' },
]

export function deriveConflict(a: NpcAffinity): number {
  if (typeof a.conflictOverride === 'number' && a.conflictOverride >= 0) {
    return Math.max(0, Math.min(4, a.conflictOverride))
  }
  const hostile = Math.max(a.annoyance, a.disgust)
  if (a.trust < 15 && hostile > 75) return 4
  if (a.trust < 25 && hostile > 60) return 3
  if (hostile > 55 || a.cringe > 60) return 2
  if (hostile > 35 || a.cringe > 35) return 1
  return 0
}

export function conflictInfo(level: number): ConflictLevel {
  return CONFLICT_LEVELS[Math.max(0, Math.min(4, level))]
}

export function deriveStage(a: NpcAffinity): string {
  let score = affinityScore(a)
  const conflict = deriveConflict(a)
  // 冲突联动：决裂直接判敌对，冷战至多警惕，争执至多回落到初识
  if (conflict >= 4) score = Math.min(score, -40)
  else if (conflict === 3) score = Math.min(score, -20)
  else if (conflict === 2) score = Math.min(score, 10)
  for (const [min, name] of STAGES) {
    if (score >= min) return name
  }
  return '敌对'
}

export function affinityLineFor(a: NpcAffinity): string {
  const stage = deriveStage(a)
  const dims = AFFINITY_DIMS.map((d) => `${d.label}${Math.round(a[d.key])}`).join('/')
  const conflict = conflictInfo(deriveConflict(a))
  const conflictText = conflict.level > 0 ? `冲突：Lv.${conflict.level} ${conflict.name}` : '冲突：无'
  return `NPC「${a.npcName}」对用户：关系阶段「${stage}」（综合 ${Math.round(affinityScore(a))} 分，${STAGE_HINTS[stage] ?? ''}）；` +
    `${dims}；${conflictText}。`
}

/** 汇总某会话全部 NPC 的状态行（注入 system） */
export async function affinityStatusLines(sessionId: string): Promise<string[]> {
  const rows = await db.affinity.where('sessionId').anyOf([sessionId]).toArray()
  return rows.map(normalizeAffinity).filter((r) => r.npcName).map((r) => affinityLineFor(r))
}

// ── 存取 ──

export async function listNpcAffinities(sessionId: string): Promise<NpcAffinity[]> {
  const rows = await db.affinity.where('sessionId').equals(sessionId).toArray()
  return rows.map(normalizeAffinity).sort((a, b) => affinityScore(b) - affinityScore(a))
}

export async function saveNpcAffinity(a: NpcAffinity) {
  a.updatedAt = Date.now()
  // deepPlain 剥掉响应式 Proxy（IndexedDB 无法结构化克隆 Proxy）
  await db.affinity.put(deepPlain(a))
}

export async function removeNpcAffinity(id: string) {
  await db.affinity.delete(id)
}

function clamp(v: unknown, fallback: number): number {
  const n = Number(v)
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : fallback))
}

/** 平滑合并：新评估占 60%，旧值占 40%（避免好感跳变） */
function mergeSmooth(oldV: number, newV: number): number {
  return Math.round(newV * 0.6 + oldV * 0.4)
}

// ── AI 自主评判 ──

const EVAL_SYSTEM = `你是 RP 关系状态追踪器。阅读最近的聊天记录，找出其中出场的所有 AI 侧角色/NPC（用户本人除外），为每个 NPC 对用户的关系在三条相对轴上打分（每轴两个方向各 0-100 整数，方向相反、通常此消彼长）：
- 关注轴：interest 兴趣（想了解你、想陪你）/ annoyance 厌烦（被你打扰的不耐烦）
- 心动轴：attraction 吸引（恋爱/身体层面的心动，纯友情关系应偏低）/ disgust 反感（本能的排斥、看不惯）
- 自在轴：trust 信任（安心、敢交软肋，关系基石）/ cringe 尴尬（相处紧绷、别扭）
conflict 冲突等级 0-4：0 无冲突 / 1 摩擦 / 2 争执 / 3 冷战 / 4 决裂。
评分要有惯性：没有明显剧情事件时小幅浮动；发生重大事件（告白、背叛、救命之恩等）可以大幅调整。
只输出严格 JSON 数组，不要其他文字，格式：
[{"npcName":"角色名","interest":0-100,"annoyance":0-100,"attraction":0-100,"disgust":0-100,"trust":0-100,"cringe":0-100,"conflict":0-4}]`

export interface NpcEvalResult {
  npcName: string
  interest: number
  annoyance: number
  attraction: number
  disgust: number
  trust: number
  cringe: number
  conflict: number
}

/** 评判输入：名字必填，各维度可缺（漏评维度沿用旧值/默认）——模型与 UI 补全都可能只给部分维度 */
export type NpcEvalInput = Partial<Omit<NpcEvalResult, 'npcName'>> & { npcName: string }

/**
 * 把一批 AI 评判结果合并入库：新名字自动建档；已有条目按 新值60%/旧值40% 平滑合并。
 * 独立评判（evaluateNpcsAutonomously）与「UI 补全搭车返回 affinity」共用这一段，
 * 保证无论哪条通道产出的好感数值，落库口径一致。
 */
export async function mergeNpcEvalResults(
  sessionId: string,
  list: NpcEvalInput[],
): Promise<NpcAffinity[]> {
  const existing = await listNpcAffinities(sessionId)
  const byName = new Map(existing.map((e) => [e.npcName, e]))

  const updated: NpcAffinity[] = []
  for (const item of list) {
    const name = String(item.npcName || '').trim()
    if (!name) continue
    const old = byName.get(name)
    const base = normalizeAffinity(old || defaultNpcAffinity(sessionId, name))
    const itemRec = item as unknown as Record<string, unknown>
    const next: NpcAffinity = { ...base }
    // 七维统一处理：模型漏评的维度沿用旧值；已有档案按 60/40 平滑合并，避免跳变
    for (const d of AFFINITY_DIMS) {
      const v = clamp(itemRec[d.key], base[d.key])
      next[d.key] = old ? mergeSmooth(old[d.key], v) : v
    }
    next.conflictOverride = typeof item.conflict === 'number'
      ? Math.max(0, Math.min(4, Math.round(item.conflict)))
      : (base.conflictOverride ?? null)
    next.updatedAt = Date.now()
    await saveNpcAffinity(next)
    updated.push(next)
  }
  return updated
}

/**
 * AI 自主评判：分析最近楼层，为每个出场 NPC 生成/更新好感度档案（独立一次模型调用，
 * 供好感度页手动「重新评估」使用；自动每轮评判已并入 UI 补全，见 runAuxTemplateAnalysis）。
 */
export async function evaluateNpcsAutonomously(
  cfg: ApiConfig,
  chainNodes: MsgNode[],
  sessionId: string,
  limit = 24,
): Promise<NpcAffinity[]> {
  const slice = chainNodes.slice(-limit)
  const recent = slice
    .map((n) => `${n.role === 'user' ? '用户' : (n.name || '角色')}: ${parseCot(n.content || '').main.slice(0, 400)}`)
    .filter((t) => t.trim().length > 1)
    .join('\n\n')
  if (!recent.trim()) throw new Error('没有可分析的剧情')

  const existing = await listNpcAffinities(sessionId)

  const raw = await chatOnce({ ...cfg, temperature: 0.2 }, [
    { role: 'system', content: EVAL_SYSTEM },
    { role: 'user', content: `已知 NPC 档案名：${existing.map((e) => e.npcName).join('、') || '（暂无）'}\n\n最近聊天记录：\n${recent}` },
  ])

  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) throw new Error('模型未返回有效 JSON 数组')
  const list = JSON.parse(m[0]) as NpcEvalResult[]
  if (!Array.isArray(list)) throw new Error('模型返回格式错误')

  return mergeNpcEvalResults(sessionId, list)
}
