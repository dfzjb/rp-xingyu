import { describe, expect, it } from 'vitest'
import { resolveWorldInfo, type WorldInfoEntry } from '../src/lib/worldinfo'

const msgs = (...t: string[]) => t

describe('resolveWorldInfo 基础激活', () => {
  it('主关键词命中 → after_char 注入', () => {
    const entries: WorldInfoEntry[] = [
      { keys: ['魔法'], content: '这个世界魔法常见。', position: 'after_char' },
    ]
    const r = resolveWorldInfo(entries, msgs('他在练习魔法'))
    expect(r.afterChar).toEqual(['这个世界魔法常见。'])
    expect(r.beforeChar).toEqual([])
  })

  it('未命中 / 禁用 / 空内容 不激活', () => {
    const entries: WorldInfoEntry[] = [
      { keys: ['魔法'], content: 'A' },
      { keys: ['魔法'], content: 'B', enabled: false },
      { keys: ['魔法'], content: '   ' },
    ]
    const r = resolveWorldInfo(entries, msgs('今天天气不错'))
    expect(r.afterChar).toEqual([])
  })

  it('constant 常驻条目无需关键词', () => {
    const r = resolveWorldInfo(
      [{ constant: true, content: '世界观设定', position: 'before_char' }],
      msgs('随便什么'),
    )
    expect(r.beforeChar).toEqual(['世界观设定'])
  })

  it('扫描深度：关键词只出现在窗口外不激活', () => {
    const entries: WorldInfoEntry[] = [
      { keys: ['古龙'], content: '龙设定', scanDepth: 1 },
    ]
    // 只有 1 层窗口：仅最后一条消息参与扫描
    const miss = resolveWorldInfo(entries, msgs('古龙出现了', '今天吃饭'))
    expect(miss.afterChar).toEqual([])
    const hit = resolveWorldInfo(entries, msgs('今天吃饭', '古龙出现了'))
    expect(hit.afterChar).toEqual(['龙设定'])
  })

  it('大小写敏感开关', () => {
    const ins = [{ keys: ['Dragon'], content: 'X', caseSensitive: true }]
    expect(resolveWorldInfo(ins, msgs('a dragon b')).afterChar).toEqual([])
    expect(resolveWorldInfo(ins, msgs('a Dragon b')).afterChar).toEqual(['X'])
  })

  it('正则关键词（/…/ 形式）', () => {
    const r = resolveWorldInfo(
      [{ keys: ['/\\d{4}-\\d{2}/'], content: '日期设定' }],
      msgs('今天是 2026-08-29'),
    )
    expect(r.afterChar).toEqual(['日期设定'])
  })
})

describe('过滤词与逻辑组合', () => {
  const base = { content: 'X', keys: ['魔法'] }

  it('AND_ANY：主关键词命中且任一次要命中', () => {
    const e: WorldInfoEntry = { ...base, secondaryKeys: ['火', '冰'], selectiveLogic: 'AND_ANY' }
    expect(resolveWorldInfo([e], msgs('练习火魔法')).afterChar).toEqual(['X'])
    expect(resolveWorldInfo([e], msgs('练习魔法')).afterChar).toEqual([])
  })

  it('AND_ALL：全部次要词都需命中', () => {
    const e: WorldInfoEntry = { ...base, secondaryKeys: ['火', '冰'], selectiveLogic: 'AND_ALL' }
    expect(resolveWorldInfo([e], msgs('冰火魔法')).afterChar).toEqual(['X'])
    expect(resolveWorldInfo([e], msgs('火魔法')).afterChar).toEqual([])
  })

  it('NOT_ANY：出现任一禁止词则不激活', () => {
    const e: WorldInfoEntry = { ...base, secondaryKeys: ['禁忌'], selectiveLogic: 'NOT_ANY' }
    expect(resolveWorldInfo([e], msgs('练习魔法')).afterChar).toEqual(['X'])
    expect(resolveWorldInfo([e], msgs('练习禁忌魔法')).afterChar).toEqual([])
  })

  it('NOT_ALL：并非全部禁止词出现即可激活', () => {
    const e: WorldInfoEntry = { ...base, secondaryKeys: ['禁忌', '封印'], selectiveLogic: 'NOT_ALL' }
    expect(resolveWorldInfo([e], msgs('练习禁忌魔法')).afterChar).toEqual(['X'])
    expect(resolveWorldInfo([e], msgs('禁忌与封印的魔法')).afterChar).toEqual([])
  })
})

describe('概率触发', () => {
  it('probability=100 必激活，probability=0 永不激活', () => {
    const always = { keys: ['魔法'], content: 'A', useProbability: true, probability: 100 }
    const never = { keys: ['魔法'], content: 'B', useProbability: true, probability: 0 }
    const r = resolveWorldInfo([always, never], msgs('魔法'))
    expect(r.afterChar).toEqual(['A'])
  })
})

describe('注入位置', () => {
  it('@depth 条目进 byDepth 并按深度排序', () => {
    const r = resolveWorldInfo(
      [
        { keys: ['魔法'], content: '深层', position: '@depth', depth: 2, depthRole: 'system' },
        { keys: ['魔法'], content: '浅层', position: '@depth', depth: 0, depthRole: 'user' },
        { keys: ['魔法'], content: '前置', position: 'before_char' },
      ],
      msgs('魔法'),
    )
    expect(r.beforeChar).toEqual(['前置'])
    expect(r.byDepth.map((d) => d.content)).toEqual(['浅层', '深层'])
    expect(r.byDepth[1].role).toBe('system')
  })

  it('order 决定同组内顺序', () => {
    const r = resolveWorldInfo(
      [
        { keys: ['魔法'], content: '第二', order: 200 },
        { keys: ['魔法'], content: '第一', order: 50 },
      ],
      msgs('魔法'),
    )
    expect(r.afterChar).toEqual(['第一', '第二'])
  })
})

describe('递归激活', () => {
  it('A 的内容里包含 B 的关键词时，B 在递归轮被激活', () => {
    const a = { keys: ['魔法'], content: '这个国家禁用火焰法术。', order: 1 }
    const b = { keys: ['火焰法术'], content: '火焰法术设定', order: 2 }
    expect(resolveWorldInfo([a, b], msgs('魔法'), 0).afterChar).toEqual(['这个国家禁用火焰法术。'])
    expect(resolveWorldInfo([a, b], msgs('魔法'), 1).afterChar).toEqual([
      '这个国家禁用火焰法术。',
      '火焰法术设定',
    ])
  })
})
