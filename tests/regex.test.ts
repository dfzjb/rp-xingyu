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
    // 未指定 markdownOnly/promptOnly → 双层生效（酒馆默认行为）
    expect(s.applyOnDisplay).toBe(true)
    expect(s.applyOnSend).toBe(true)
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
