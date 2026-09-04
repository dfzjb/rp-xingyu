import { beforeEach, describe, expect, it } from 'vitest'
import {
  AFFINITY_AXES,
  affinityLineFor,
  affinityScore,
  conflictInfo,
  defaultNpcAffinity,
  deriveConflict,
  deriveStage,
  listNpcAffinities,
  mergeNpcEvalResults,
  normalizeAffinity,
} from '../src/lib/affinity'
import { db } from '../src/db'
import type { NpcAffinity } from '../src/types'

function mk(partial: Partial<NpcAffinity>): NpcAffinity {
  return { ...defaultNpcAffinity('s1', '小明'), ...partial }
}

describe('defaultNpcAffinity / normalizeAffinity', () => {
  it('新档案六维取默认值，NPC 从「陌生」起步', () => {
    const a = defaultNpcAffinity('sess', '小红')
    expect(a.id).toBe('sess:小红')
    expect(a.interest).toBe(15)
    expect(a.trust).toBe(8)
    expect(a.attraction).toBe(5)
    expect(a.annoyance).toBe(0)
    expect(a.cringe).toBe(0)
    expect(a.disgust).toBe(0)
    expect(a.conflictOverride).toBeNull()
    expect(deriveStage(a)).toBe('陌生')
  })

  it('normalizeAffinity 补齐缺失维度并剥离 respect/dependence 遗留字段', () => {
    const legacy = { id: 's:x', sessionId: 's', npcName: 'x', respect: 5, dependence: 9 } as unknown as NpcAffinity
    const a = normalizeAffinity(legacy) as NpcAffinity & Record<string, unknown>
    expect(a.respect).toBeUndefined()
    expect(a.dependence).toBeUndefined()
    expect(a.interest).toBe(15)
    expect(a.trust).toBe(8)
  })
})

describe('AFFINITY_AXES 单一事实源', () => {
  it('三轴六维恰好覆盖全部维度，且每轴 pos/neg 不重叠', () => {
    const dims = new Set<string>()
    for (const ax of AFFINITY_AXES) {
      expect(dims.has(ax.pos)).toBe(false)
      expect(dims.has(ax.neg)).toBe(false)
      dims.add(ax.pos)
      dims.add(ax.neg)
    }
    expect(dims.size).toBe(6)
  })
})

describe('affinityScore 加权综合分', () => {
  it('纯正面分值 = 加权均值（保留一位小数）', () => {
    // interest 50*1.0 + trust 40*1.3 + attraction 30*1.1 = 135 / 3.4 = 39.705… → 39.7
    const a = mk({ interest: 50, trust: 40, attraction: 30 })
    expect(affinityScore(a)).toBe(39.7)
  })

  it('负面按 0.7 折减计入（负面均值按全部负面维度加权，未触维度计 0）', () => {
    const a = mk({ annoyance: 80 })
    // pos: (15*1.0+8*1.3+5*1.1)/3.4 ≈ 9.1；neg: (80*1.2)/3.4*0.7 ≈ 19.8 → -10.7
    expect(affinityScore(a)).toBe(-10.7)
  })

  it('正负可同时存在（爱恨交加），负面折减后不直接清空正面', () => {
    const a = mk({ interest: 100, trust: 100, attraction: 100, cringe: 100 })
    // pos: 100；neg: (100*0.9)/3.4*0.7 ≈ 18.5 → 81.5
    expect(affinityScore(a)).toBe(81.5)
  })

  it('全零档案得 0 分', () => {
    const a = mk({ interest: 0, trust: 0, attraction: 0 })
    expect(affinityScore(a)).toBe(0)
  })
})

describe('deriveStage 阈值表（降序查表）', () => {
  it('满分档案判「挚爱」而非「敌对」（回归：阈值表曾升序排列恒判敌对）', () => {
    const a = mk({ interest: 100, trust: 100, attraction: 100 })
    expect(affinityScore(a)).toBe(100)
    expect(deriveStage(a)).toBe('挚爱')
  })

  it('边界值落在正确档位', () => {
    expect(deriveStage(mk({ interest: 0, trust: 0, attraction: 0 }))).toBe('陌生')
    // score = 20*1.0/3.4 ≈ 5.9 → 初识档（≥10 之下）→ 陌生? 5.9 < 10 → 陌生
    expect(deriveStage(mk({ interest: 20, trust: 0, attraction: 0 }))).toBe('陌生')
    // score = 34*1.0/3.4 = 10 → 初识
    expect(deriveStage(mk({ interest: 34, trust: 0, attraction: 0 }))).toBe('初识')
    // score = 3.4*48/3.4 = 48 → 好友
    expect(deriveStage(mk({ interest: 48, trust: 48, attraction: 48 }))).toBe('好友')
  })

  it('纯负面档案判「敌对」', () => {
    const a = mk({ disgust: 90 })
    expect(deriveStage(a)).toBe('敌对')
  })
})

describe('deriveConflict / conflictInfo', () => {
  it('手动覆盖优先生效并夹取 0-4', () => {
    expect(deriveConflict(mk({ conflictOverride: 3 }))).toBe(3)
    expect(deriveConflict(mk({ conflictOverride: 99 }))).toBe(4)
    expect(deriveConflict(mk({ conflictOverride: -2 }))).toBe(0)
  })

  it('自动推导：低信任 + 高敌意 → 决裂；尴尬主导 → 争执', () => {
    expect(deriveConflict(mk({ trust: 5, annoyance: 90 }))).toBe(4)
    expect(deriveConflict(mk({ trust: 20, annoyance: 70 }))).toBe(3)
    expect(deriveConflict(mk({ cringe: 80 }))).toBe(2)
    expect(deriveConflict(mk({}))).toBe(0)
  })

  it('conflictInfo 越界夹取', () => {
    expect(conflictInfo(99).level).toBe(4)
    expect(conflictInfo(-5).level).toBe(0)
    expect(conflictInfo(0).name).toBe('无冲突')
  })
})

describe('冲突联动压制阶段', () => {
  it('决裂(Lv4) 时无论正面多高都强制「敌对」', () => {
    const a = mk({ interest: 100, attraction: 100, trust: 5, annoyance: 90 })
    expect(deriveConflict(a)).toBe(4)
    expect(deriveStage(a)).toBe('敌对')
  })

  it('争执(Lv2) 压制到至多「初识」', () => {
    const a = mk({ interest: 80, trust: 80, attraction: 80, cringe: 90 })
    expect(deriveConflict(a)).toBe(2)
    expect(deriveStage(a)).toBe('初识')
  })
})

describe('affinityLineFor 状态行', () => {
  it('包含 NPC 名、阶段、六维与冲突', () => {
    const line = affinityLineFor(mk({ trust: 50, disgust: 80 }))
    expect(line).toContain('小明')
    expect(line).toContain('信任50')
    expect(line).toContain('反感80')
    expect(line).toContain('冲突：Lv.')
  })
})

describe('mergeNpcEvalResults（UI 补全搭车落库，口径同独立评判）', () => {
  beforeEach(async () => { await db.affinity.clear() })

  it('新名字自动建档，直接采用本次评分', async () => {
    const out = await mergeNpcEvalResults('s1', [
      { npcName: '陆晴', interest: 70, trust: 60, attraction: 50, annoyance: 0, cringe: 0, disgust: 0, conflict: 0 },
    ])
    expect(out).toHaveLength(1)
    const rows = await listNpcAffinities('s1')
    expect(rows).toHaveLength(1)
    expect(rows[0].npcName).toBe('陆晴')
    expect(rows[0].interest).toBe(70)
    expect(rows[0].conflictOverride).toBe(0)
  })

  it('已有档案按 新60%/旧40% 平滑，避免跳变', async () => {
    await db.affinity.put({ ...defaultNpcAffinity('s1', '陆晴'), interest: 50 })
    const out = await mergeNpcEvalResults('s1', [
      { npcName: '陆晴', interest: 80, trust: 8, attraction: 5, annoyance: 0, cringe: 0, disgust: 0 },
    ])
    // 50*0.4 + 80*0.6 = 68
    expect(out[0].interest).toBe(68)
  })

  it('空名项被跳过；空数组不报错', async () => {
    const out = await mergeNpcEvalResults('s1', [{ npcName: '   ' } as never])
    expect(out).toHaveLength(0)
    expect(await listNpcAffinities('s1')).toHaveLength(0)
  })
})
