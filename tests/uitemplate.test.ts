import { describe, expect, it } from 'vitest'
import {
  normalizeUiTemplate,
  normalizeUiTemplates,
  renderUiTemplateHtml,
  stripCodeFence,
  type UiTemplate,
} from '../src/lib/uitemplate'

function tpl(html: string, vars: Record<string, unknown> = {}, extra: Partial<UiTemplate> = {}): UiTemplate {
  return {
    id: 't1',
    name: '测试模板',
    enabled: true,
    order: 100,
    placement: 'bottom',
    htmlTemplate: html,
    initialVariableState: vars,
    ...extra,
  }
}

describe('stripCodeFence', () => {
  it('剥离 ```html 围栏', () => {
    expect(stripCodeFence('```html\n<div>x</div>\n```')).toBe('<div>x</div>')
  })
  it('无围栏原样返回', () => {
    expect(stripCodeFence('<div>x</div>')).toBe('<div>x</div>')
  })
  it('非字符串输入', () => {
    expect(stripCodeFence(undefined)).toBe('')
    expect(stripCodeFence(null)).toBe('')
  })
})

describe('normalizeUiTemplate 宽松字段兼容', () => {
  it('template → htmlTemplate；variables → initialVariableState；enabled 字符串', () => {
    const t = normalizeUiTemplate({
      name: '面板',
      template: '<b>{{hp}}</b>',
      variables: { hp: 80 },
      enabled: 'false',
      placement: 'top',
    })
    expect(t.htmlTemplate).toBe('<b>{{hp}}</b>')
    expect(t.initialVariableState).toEqual({ hp: 80 })
    expect(t.enabled).toBe(false)
    expect(t.placement).toBe('top')
    expect(t.order).toBe(100)
  })

  it('缺 id 时自动生成，缺模板名默认「UI模板」', () => {
    const t = normalizeUiTemplate({ template: '<div/>' })
    expect(t.id).toMatch(/^tpl-/)
    expect(t.name).toBe('UI模板')
    expect(t.placement).toBe('bottom')
  })

  it('normalizeUiTemplates：过滤非对象与空模板', () => {
    const out = normalizeUiTemplates([{ template: '<div/>' }, null, 'x', { name: '空' }, { template: '   ' }])
    expect(out).toHaveLength(1)
    expect(normalizeUiTemplates('nope')).toEqual([])
  })
})

describe('renderUiTemplateHtml 变量引擎', () => {
  it('基础插值 + 缺省变量渲染为空串', () => {
    const html = renderUiTemplateHtml(tpl('<span>{{name}}/{{missing}}</span>', { name: '艾莉' }))
    expect(html).toContain('<span>艾莉/</span>')
  })

  it('输出自动 HTML 转义', () => {
    const html = renderUiTemplateHtml(tpl('<i>{{v}}</i>', { v: '<b onclick="x()">注入</b>' }))
    expect(html).toContain('&lt;b onclick=&quot;x()&quot;&gt;注入&lt;/b&gt;')
    expect(html).not.toContain('<b onclick')
  })

  it('#each 数组循环 + @index/@number/@first/@last', () => {
    const html = renderUiTemplateHtml(tpl(
      '<ul>{{#each items}}<li data-i="{{@index}}" data-n="{{@number}}">{{name}}</li>{{/each}}</ul>',
      { items: [{ name: '剑' }, { name: '盾' }] },
    ))
    expect(html).toContain('<li data-i="0" data-n="1">剑</li>')
    expect(html).toContain('<li data-i="1" data-n="2">盾</li>')
  })

  it('#each 空数组走 {{else}} 分支', () => {
    const html = renderUiTemplateHtml(tpl(
      '{{#each items}}有货{{else}}空空如也{{/each}}',
      { items: [] },
    ))
    expect(html).toBe('空空如也')
  })

  it('#each 对象循环 @key 取键名', () => {
    const html = renderUiTemplateHtml(tpl(
      '{{#each stats}}{{@key}}={{this}};{{/each}}',
      { stats: { hp: 10, mp: 5 } },
    ))
    expect(html).toBe('hp=10;mp=5;')
  })

  it('as 别名与 root. 根引用', () => {
    const html = renderUiTemplateHtml(tpl(
      '{{#each items as it}}{{it.name}}(持有者:{{root.owner}}){{/each}}',
      { items: [{ name: '药水' }], owner: '旅人' },
    ))
    expect(html).toBe('药水(持有者:旅人)')
  })

  it('状态覆盖优先于模板内置变量', () => {
    const t = tpl('<b>{{hp}}</b>', { hp: 10 })
    expect(renderUiTemplateHtml(t, { hp: 99 })).toContain('<b>99</b>')
    expect(renderUiTemplateHtml(t)).toContain('<b>10</b>')
  })
})
