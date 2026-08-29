import { describe, expect, it } from 'vitest'
import { formatRoll, parseDice, rollDice } from '../src/lib/hall/dice'

describe('parseDice 表达式解析', () => {
  it('基础 NdM 与常数加减', () => {
    expect(parseDice('1d100')).toEqual({ groups: [{ n: 1, m: 100, sign: 1 }], mod: 0 })
    expect(parseDice('2d6+1d4-1+3')).toEqual({
      groups: [
        { n: 2, m: 6, sign: 1 },
        { n: 1, m: 4, sign: 1 },
      ],
      mod: 2,
    })
    expect(parseDice('d20')).toEqual({ groups: [{ n: 1, m: 20, sign: 1 }], mod: 0 })
    expect(parseDice('5')).toEqual({ groups: [], mod: 5 })
  })

  it('大小写与空格归一化', () => {
    expect(parseDice(' 2D6 + 3 ')).toEqual({ groups: [{ n: 2, m: 6, sign: 1 }], mod: 3 })
  })

  it('非法表达式抛错', () => {
    expect(() => parseDice('')).toThrow()
    expect(() => parseDice('abc')).toThrow()
    expect(() => parseDice('2d')).toThrow()
    expect(() => parseDice('0d6')).toThrow(/骰数/)
    expect(() => parseDice('101d6')).toThrow(/骰数/)
    expect(() => parseDice('1d1')).toThrow(/骰面/)
  })
})

describe('rollDice 掷骰', () => {
  it('rng 可注入：确定性结果', () => {
    // rng=0.5 → d6 出 1+floor(0.5*6)=4，d4 出 1+floor(0.5*4)=3
    const r = rollDice('2d6+1d4+1', () => 0.5)
    expect(r.groups[0].values).toEqual([4, 4])
    expect(r.groups[1].values).toEqual([3])
    expect(r.total).toBe(4 + 4 + 3 + 1)
  })

  it('随机掷骰落在合法区间', () => {
    for (let i = 0; i < 30; i++) {
      const r = rollDice('3d6')
      expect(r.total).toBeGreaterThanOrEqual(3)
      expect(r.total).toBeLessThanOrEqual(18)
    }
  })

  it('负符号组减值', () => {
    const r = rollDice('-2d6', () => 0.999) // 每颗出 6
    expect(r.total).toBe(-12)
  })

  it('formatRoll 人读格式', () => {
    const r = rollDice('2d6+3', () => 0.5)
    expect(formatRoll(r)).toBe('2d6+3：2d6[4,4]+3 = 11')
  })
})
