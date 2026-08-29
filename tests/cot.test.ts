import { describe, expect, it } from 'vitest'
import { bodyLength, parseCot } from '../src/lib/cot'

describe('parseCot', () => {
  it('无思维链正文原样返回', () => {
    const r = parseCot('你好，世界')
    expect(r.main).toBe('你好，世界')
    expect(r.cot).toBe('')
    expect(r.cotFinished).toBe(false)
  })

  it('闭合 <think> 块：内容进 cot，正文剥离', () => {
    const r = parseCot('<think>让我想想</think>这是正文')
    expect(r.cot).toBe('让我想想')
    expect(r.main).toBe('这是正文')
    expect(r.cotFinished).toBe(true)
  })

  it('未闭合 <think> 块：cotFinished=false，流式态', () => {
    const r = parseCot('<think>正在推理中…')
    expect(r.cot).toBe('正在推理中…')
    expect(r.main).toBe('')
    expect(r.cotFinished).toBe(false)
  })

  it('<cot> 标签同样支持', () => {
    const r = parseCot('<cot>推理</cot>正文')
    expect(r.cot).toBe('推理')
    expect(r.main).toBe('正文')
  })

  it('尾部 [系统指令:] 段单独拆出', () => {
    const r = parseCot('正文内容\n\n[系统指令: 请继续]')
    expect(r.main).toBe('正文内容')
    expect(r.sys).toBe('请继续')
  })

  it('空输入', () => {
    expect(parseCot('')).toEqual({ cot: '', main: '', sys: '', cotFinished: false })
  })
})

describe('bodyLength', () => {
  it('只统计正文口径，思维链与系统指令不计入', () => {
    expect(bodyLength('<think>长长的推理内容</think>正文四字')).toBe(4)
    expect(bodyLength('正文\n\n[系统指令: x]')).toBe(2)
    expect(bodyLength('')).toBe(0)
  })
})
