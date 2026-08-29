import { describe, expect, it } from 'vitest'
import { replaceMacros } from '../src/lib/macros'

describe('replaceMacros', () => {
  it('{{char}} / {{user}} 替换，缺省时用默认值', () => {
    expect(replaceMacros('{{char}}看着{{user}}', { charName: '艾莉', userName: '旅人' })).toBe('艾莉看着旅人')
    expect(replaceMacros('{{char}}和{{user}}')).toBe('char和我')
  })

  it('未知宏原样保留', () => {
    expect(replaceMacros('{{unknown_macro}}')).toBe('{{unknown_macro}}')
  })

  it('random/pick 从候选中取值', () => {
    const r = replaceMacros('{{random:红|绿|蓝}}')
    expect(['红', '绿', '蓝']).toContain(r)
    expect(replaceMacros('{{pick:甲|乙}}')).toMatch(/^(甲|乙)$/)
    expect(replaceMacros('{{random:|}}')).toBe('')
  })

  it('roll 掷骰结果在 1..N 范围', () => {
    for (let i = 0; i < 20; i++) {
      const v = Number(replaceMacros('{{roll:d20}}'))
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(20)
    }
  })

  it('time/date 宏形如 HH:MM 与 YYYY-MM-DD', () => {
    expect(replaceMacros('{{time}}')).toMatch(/^\d{2}:\d{2}$/)
    expect(replaceMacros('{{date}}')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('空串原样返回', () => {
    expect(replaceMacros('')).toBe('')
  })
})
