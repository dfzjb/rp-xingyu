/**
 * 表达式骰子：支持 NdM 组合与加减常数，如 1d100、2d6+1d4-1+2。
 * 不做规则书集成（见项目书 11.4 规则系统条目），rng 可注入以便测试。
 */
export interface DiceGroup {
  n: number // 骰数
  m: number // 骰面
  sign: 1 | -1
}

export interface ParsedDice {
  groups: DiceGroup[]
  mod: number
}

export function parseDice(input: string): ParsedDice {
  const s = input.trim().toLowerCase().replace(/\s+/g, '')
  if (!s) throw new Error('骰子表达式为空')
  let mod = 0
  const groups: DiceGroup[] = []
  const tokens = s.match(/[+-]?[^+-]+/g) ?? []
  for (const tok of tokens) {
    const sign: 1 | -1 = tok.startsWith('-') ? -1 : 1
    const body = tok.replace(/^[+-]/, '')
    const dm = body.match(/^(\d*)d(\d+)$/)
    if (dm) {
      const n = dm[1] === '' ? 1 : parseInt(dm[1], 10)
      const m = parseInt(dm[2], 10)
      if (n < 1 || n > 100) throw new Error(`骰数超出范围（1-100）：${tok}`)
      if (m < 2 || m > 1000) throw new Error(`骰面超出范围（2-1000）：${tok}`)
      groups.push({ n, m, sign })
    } else if (/^\d+$/.test(body)) {
      mod += sign * parseInt(body, 10)
    } else {
      throw new Error(`无法识别的表达式：${tok}`)
    }
  }
  if (!groups.length && mod === 0) throw new Error('骰子表达式为空')
  return { groups, mod }
}

export interface RolledGroup extends DiceGroup {
  values: number[]
}

export interface RollResult {
  expr: string
  groups: RolledGroup[]
  mod: number
  total: number
}

export function rollDice(expr: string, rng: () => number = Math.random): RollResult {
  const { groups, mod } = parseDice(expr)
  let total = mod
  const rolled: RolledGroup[] = groups.map((g) => {
    const values: number[] = []
    for (let i = 0; i < g.n; i++) values.push(1 + Math.floor(rng() * g.m))
    total += g.sign * values.reduce((a, b) => a + b, 0)
    return { ...g, values }
  })
  return { expr: expr.trim(), groups: rolled, mod, total }
}

/** 人读格式：2d6+3 → 「2d6[4,2]+3 = 9」 */
export function formatRoll(r: RollResult): string {
  const parts: string[] = []
  for (const g of r.groups) {
    const sign = g.sign < 0 ? '-' : parts.length ? '+' : ''
    parts.push(`${sign}${g.n}d${g.m}[${g.values.join(',')}]`)
  }
  if (r.mod !== 0 || !parts.length) parts.push(`${r.mod >= 0 && parts.length ? '+' : ''}${r.mod}`)
  return `${r.expr}：${parts.join('')} = ${r.total}`
}
