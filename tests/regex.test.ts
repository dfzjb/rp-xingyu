import { describe, expect, it } from 'vitest'
import {
  PLACEMENT_AI_OUTPUT,
  PLACEMENT_USER_INPUT,
  applyRegexScripts,
  normalizeRegexScript,
  toStRegexExport,
} from '../src/lib/regex'

describe('normalizeRegexScript', () => {
  it('非对象输入返回 null', () => {
    expect(normalizeRegexScript(null)).toBeNull()
    expect(normalizeRegexScript('x')).toBeNull()
  })

  it('酒馆格式：/…/flags 斜杠模式解析 + placement 决定影响面', () => {
    const s = normalizeRegexScript({
      scriptName: '去水印',
      findRegex: '/<a>.*?<\\/a>/gi',
      replaceString: '',
      placement: [2],
    })!
    expect(s.pattern).toBe('<a>.*?<\\/a>')
    expect(s.flags).toBe('gi')
    expect(s.affectsUser).toBe(false)
    expect(s.affectsAI).toBe(true)
    // 未指定 markdownOnly/promptOnly → 对齐旧版/ST：默认仅显示层，不进发给模型的 prompt
    expect(s.applyOnDisplay).toBe(true)
    expect(s.applyOnSend).toBe(false)
  })

  it('酒馆格式：显式 promptOnly 才在发送层执行', () => {
    const p = normalizeRegexScript({ scriptName: 'p', findRegex: 'x', replaceString: 'y', promptOnly: true })!
    expect(p.applyOnDisplay).toBe(false)
    expect(p.applyOnSend).toBe(true)
  })

  it('酒馆格式：markdownOnly / promptOnly 各自只开一层', () => {
    const md = normalizeRegexScript({ scriptName: 'a', findRegex: 'x', replaceString: 'y', markdownOnly: true })!
    expect(md.applyOnDisplay).toBe(true)
    expect(md.applyOnSend).toBe(false)
    const pr = normalizeRegexScript({ scriptName: 'b', findRegex: 'x', replaceString: 'y', promptOnly: true })!
    expect(pr.applyOnDisplay).toBe(false)
    expect(pr.applyOnSend).toBe(true)
  })

  it('旧版格式：regex/replacement 字段 + placement [1用户 2AI]', () => {
    const s = normalizeRegexScript({ name: '旧脚本', regex: '旧', replacement: '新', placement: [1] })!
    expect(s.pattern).toBe('旧')
    expect(s.replace).toBe('新')
    expect(s.affectsUser).toBe(true)
    expect(s.affectsAI).toBe(false)
    // 旧版脚本默认 markdownOnly/promptOnly 都不勾 → 仅显示层，发送层不执行（对齐旧版 processRegex）
    expect(s.applyOnDisplay).toBe(true)
    expect(s.applyOnSend).toBe(false)
    // 旧版脚本显式 promptOnly 时才进发送层
    const p = normalizeRegexScript({ name: '进prompt', regex: 'a', replacement: 'b', promptOnly: true })!
    expect(p.applyOnDisplay).toBe(false)
    expect(p.applyOnSend).toBe(true)
  })
})

describe('toStRegexExport 往返一致', () => {
  it('内部模型 → 酒馆导出 → 归一化回来，语义不变', () => {
    // 直接构造内部模型形状（正则编辑器保存的形状）
    const s = {
      name: '清理',
      pattern: '\\s+',
      replace: ' ',
      flags: 'g',
      affectsUser: false,
      affectsAI: true,
      applyOnDisplay: true,
      applyOnSend: false,
    }
    const exported = toStRegexExport(s)
    expect(exported.placement).toEqual([2])
    expect(exported.markdownOnly).toBe(true)
    expect(exported.promptOnly).toBe(false)
    const back = normalizeRegexScript(exported)!
    expect(back.pattern).toBe('\\s+')
    expect(back.replace).toBe(' ')
    expect(back.flags).toBe('g')
    expect(back.affectsUser).toBe(false)
    expect(back.applyOnDisplay).toBe(true)
    expect(back.applyOnSend).toBe(false)
  })
})

describe('applyRegexScripts 应用管线', () => {
  const scripts = [
    { id: '1', name: '双端', pattern: 'foo', replace: 'bar', affectsUser: true, affectsAI: true, applyOnDisplay: true, applyOnSend: true },
    { id: '2', name: '仅显示', pattern: 'baz', replace: 'qux', applyOnDisplay: true, applyOnSend: false },
    { id: '3', name: '已停用', pattern: 'skip', replace: 'nope', disabled: true },
    { id: '4', name: '非法正则', pattern: '([bad', replace: 'x' },
  ]

  it('显示层生效的脚本：替换、跳过停用与非法正则', () => {
    expect(applyRegexScripts('foo baz skip ([bad', scripts, PLACEMENT_AI_OUTPUT, 'display')).toBe('bar qux skip ([bad')
  })

  it('发送层：仅显示层脚本不生效', () => {
    expect(applyRegexScripts('foo baz', scripts, PLACEMENT_AI_OUTPUT, 'send')).toBe('bar baz')
  })

  it('影响面过滤：仅 AI 的脚本不作用于用户输入', () => {
    const aiOnly = [{ pattern: 'hi', replace: 'hello', affectsUser: false, affectsAI: true }]
    expect(applyRegexScripts('hi', aiOnly, PLACEMENT_USER_INPUT, 'display')).toBe('hi')
    expect(applyRegexScripts('hi', aiOnly, PLACEMENT_AI_OUTPUT, 'display')).toBe('hello')
  })

  it('替换串含 $ 序列异常时跳过该脚本而非崩溃', () => {
    const bad = [{ pattern: 'a', replace: '$&$&$&$&$&]]]]' }]
    expect(() => applyRegexScripts('abc', bad, PLACEMENT_AI_OUTPUT, 'display')).not.toThrow()
  })
})

describe('内联修饰符兼容（(?i)(?s)(?m)，对齐旧版）', () => {
  it('(?i) 内联忽略大小写：JS 原生会 SyntaxError，剥离后正常匹配', () => {
    const s = [{ pattern: '(?i)dragon', replace: '龙' }]
    // 不剥离时 new RegExp('(?i)dragon') 直接抛错 → 脚本静默失效
    expect(applyRegexScripts('a DRAGON b', s, PLACEMENT_AI_OUTPUT, 'display')).toBe('a 龙 b')
  })

  it('(?s) 内联 dotAll：点可跨行', () => {
    const s = [{ pattern: '(?s)<note>.*?</note>', replace: '' }]
    expect(applyRegexScripts('前<note>a\nb</note>后', s, PLACEMENT_AI_OUTPUT, 'display')).toBe('前后')
  })

  it('组合修饰符 (?im) 同时生效', () => {
    const s = [{ pattern: '(?im)^abc$', replace: 'X' }]
    expect(applyRegexScripts('ABC\nabc', s, PLACEMENT_AI_OUTPUT, 'display')).toBe('X\nX')
  })
})

describe('minDepth/maxDepth 深度定向', () => {
  // 本组专门验证发送层深度定向，需显式开启 applyOnSend（默认仅显示层）
  const scripts = [{ pattern: '旧', replace: '新', minDepth: 1, maxDepth: 2, applyOnSend: true }]
  it('落在深度区间内才替换', () => {
    expect(applyRegexScripts('旧', scripts, PLACEMENT_AI_OUTPUT, 'send', { depth: 0 })).toBe('旧')
    expect(applyRegexScripts('旧', scripts, PLACEMENT_AI_OUTPUT, 'send', { depth: 1 })).toBe('新')
    expect(applyRegexScripts('旧', scripts, PLACEMENT_AI_OUTPUT, 'send', { depth: 2 })).toBe('新')
    expect(applyRegexScripts('旧', scripts, PLACEMENT_AI_OUTPUT, 'send', { depth: 3 })).toBe('旧')
  })
  it('不传 depth 时不做深度限制（向后兼容）', () => {
    expect(applyRegexScripts('旧', scripts, PLACEMENT_AI_OUTPUT, 'send')).toBe('新')
  })
})

describe('HTML / 代码块保护', () => {
  it('普通正则不进入代码块与行内代码', () => {
    const s = [{ pattern: 'foo', replace: 'bar', flags: 'g' }]
    const input = 'foo 文本 ```code foo 内``` 行内 `foo` 结尾 foo'
    const out = applyRegexScripts(input, s, PLACEMENT_AI_OUTPUT, 'display')
    expect(out).toContain('```code foo 内```')
    expect(out).toContain('`foo`')
    // 普通文本处仍被替换
    expect(out.startsWith('bar 文本')).toBe(true)
    expect(out.endsWith('结尾 bar')).toBe(true)
  })

  it('普通正则不改 HTML 标签内部', () => {
    const s = [{ pattern: 'data', replace: 'X', flags: 'g' }]
    const input = '可见 data <div data-id="1">data 文本</div>'
    const out = applyRegexScripts(input, s, PLACEMENT_AI_OUTPUT, 'display')
    expect(out).toContain('data-id') // 属性受保护
    expect(out).toContain('>X 文本<') // 标签外文本照常替换
  })

  it('正则自身含 <> 时视为有意操作 HTML，跳过保护', () => {
    const s = [{ pattern: '<b>foo</b>', replace: '<b>bar</b>' }]
    expect(applyRegexScripts('<b>foo</b>', s, PLACEMENT_AI_OUTPUT, 'display')).toBe('<b>bar</b>')
  })
})
