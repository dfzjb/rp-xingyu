import { describe, expect, it } from 'vitest'
import {
  applyUiTemplateUpdates,
  buildUiTemplateContextPrompt,
  buildUiTemplateUpdateInstruction,
  parseUiTemplateUpdates,
  stripUiTemplateUpdates,
  type UiTemplateUpdate,
} from '../src/lib/ui-template-state'
import type { UiTemplate } from '../src/lib/uitemplate'

function tpl(id: string, name = id, vars: Record<string, unknown> = {}): UiTemplate {
  return {
    id,
    name,
    enabled: true,
    order: 100,
    placement: 'bottom',
    htmlTemplate: '<div>{{hp}}</div>',
    initialVariableState: vars,
  }
}

describe('parseUiTemplateUpdates', () => {
  it('标准块解析出 updates 列表', () => {
    const text = '正文\n<ui_template_updates>{"updates":[{"id":"t1","variables":{"hp":10}}]}</ui_template_updates>'
    const ups = parseUiTemplateUpdates(text)
    expect(ups).toEqual([{ id: 't1', variables: { hp: 10 } }])
  })

  it('多个块全部解析（回归：曾只取第一个）', () => {
    const text = [
      '<ui_template_updates>{"updates":[{"id":"a","variables":{"x":1}}]}</ui_template_updates>',
      '<ui_template_updates>{"updates":[{"id":"b","variables":{"y":2}}]}</ui_template_updates>',
    ].join('\n')
    const ups = parseUiTemplateUpdates(text)
    expect(ups).toHaveLength(2)
    expect(ups.map((u) => u.id)).toEqual(['a', 'b'])
  })

  it('JSON 带代码围栏或前后杂质时仍可解析', () => {
    const text = '<ui_template_updates>```json\n{"updates":[{"id":"t","variables":{"v":true}}]}\n```</ui_template_updates>'
    expect(parseUiTemplateUpdates(text)).toEqual([{ id: 't', variables: { v: true } }])
  })

  it('裸 {variables} 形状与坏 JSON', () => {
    expect(parseUiTemplateUpdates('<ui_template_updates>{"variables":{"a":1}}</ui_template_updates>'))
      .toEqual([{ variables: { a: 1 } }])
    expect(parseUiTemplateUpdates('<ui_template_updates>不是json</ui_template_updates>')).toEqual([])
    expect(parseUiTemplateUpdates('普通正文')).toEqual([])
  })
})

describe('applyUiTemplateUpdates', () => {
  it('按 id 定位模板并写入路径值（items.0.name 自动建数组）', () => {
    const t = tpl('t1', '面板', { hp: 1 })
    const r = applyUiTemplateUpdates({}, [t], [{ id: 't1', variables: { 'items.0.name': '短剑' } }])
    expect(r.states.t1).toEqual({ hp: 1, items: [{ name: '短剑' }] })
    expect(r.changedCount).toBe(1)
  })

  it('按 name 定位；单模板时可省略 id/name', () => {
    const a = tpl('a', 'A')
    const b = tpl('b', 'B')
    expect(applyUiTemplateUpdates({}, [a, b], [{ name: 'B', variables: { x: 1 } }]).states.b).toEqual({ x: 1 })
    expect(applyUiTemplateUpdates({}, [a], [{ variables: { x: 2 } }]).states.a).toEqual({ x: 2 })
  })

  it('值未变化不计入 changedCount；未知模板被跳过', () => {
    const t = tpl('t1', 'P', { hp: 5 })
    expect(applyUiTemplateUpdates({}, [t], [{ id: 't1', variables: { hp: 5 } }]).changedCount).toBe(0)
    const r = applyUiTemplateUpdates({}, [t], [{ id: 'nope', variables: { hp: 6 } }])
    expect(r.states).toEqual({})
    expect(r.changedCount).toBe(0)
  })

  it('已有会话状态在克隆上更新，不改动入参', () => {
    const t = tpl('t1', 'P', {})
    const states = { t1: { hp: 1 } as Record<string, unknown> }
    const r = applyUiTemplateUpdates(states, [t], [{ id: 't1', variables: { hp: 9 } }])
    expect(states.t1.hp).toBe(1)
    expect(r.states.t1.hp).toBe(9)
  })
})

describe('stripUiTemplateUpdates', () => {
  it('剥离完整块与流式中未闭合的尾部块', () => {
    expect(stripUiTemplateUpdates('正文A<ui_template_updates>{"updates":[]}</ui_template_updates>正文B'))
      .toBe('正文A正文B')
    expect(stripUiTemplateUpdates('正文C<ui_template_updates>{"updates":[{"id"'))
      .toBe('正文C')
  })
})

describe('提示词构建', () => {
  it('状态上下文包含模板名与实时变量；禁用模板被排除', () => {
    const on = tpl('t1', '面板', { hp: 10 })
    const off = { ...tpl('t2', '隐藏', { mp: 5 }), enabled: false }
    const ctx = buildUiTemplateContextPrompt([on, off], { t1: { hp: 66 } })
    expect(ctx).toContain('<ui_template_state_context>')
    expect(ctx).toContain('面板')
    expect(ctx).toContain('66')
    expect(ctx).not.toContain('隐藏')
    expect(buildUiTemplateContextPrompt([], {})).toBe('')
  })

  it('更新指令使用会话实时状态而非卡内静态初始值（回归：曾诱导 AI 回写旧值）', () => {
    const t = tpl('t1', '面板', { hp: 1 })
    const inst = buildUiTemplateUpdateInstruction([t], { t1: { hp: 77 } })
    expect(inst).toContain('"hp": 77')
    expect(inst).not.toContain('"hp": 1')
    expect(inst).toContain('<ui_template_updates>')
    // 未传状态时回退到静态初始值
    expect(buildUiTemplateUpdateInstruction([t])).toContain('"hp": 1')
  })

  it('默认 position=before：要求先输出更新块再写正文（免疫正文 max_tokens 截断）；after 可切回旧版后置语义', () => {
    const t = tpl('t1', '面板', { hp: 1 })
    const before = buildUiTemplateUpdateInstruction([t], {})
    expect(before).toContain('最开头')
    expect(before).toContain('先完整输出更新块')
    const after = buildUiTemplateUpdateInstruction([t], {}, 'after')
    expect(after).toContain('全部正文结束之后')
    expect(after).not.toContain('最开头')
  })
})

describe('update 对象健壮性', () => {
  it('缺 variables 的更新被忽略', () => {
    const t = tpl('t1')
    const r = applyUiTemplateUpdates({}, [t], [{ id: 't1' } as unknown as UiTemplateUpdate])
    expect(r.states).toEqual({})
  })
})
