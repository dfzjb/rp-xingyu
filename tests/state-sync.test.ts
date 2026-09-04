import { describe, expect, it } from 'vitest'
import {
  builtinStateSyncRules,
  extractStateSyncUpdates,
  normalizeStateSyncRule,
  normalizeStateSyncRules,
  stripStateSyncBlocks,
  hasUnclosedSyncBlock,
  type StateSyncRule,
} from '../src/lib/state-sync'
import { applyUiTemplateUpdates, buildAuxAnalysisMessages, parseUpdatesPayload } from '../src/lib/ui-template-state'
import { parseCot } from '../src/lib/cot'
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

const builtins = builtinStateSyncRules()

describe('builtinStateSyncRules', () => {
  it('内置三种方言；setvar 宏默认关闭，其余启用', () => {
    expect(builtins.map((r) => r.dialect)).toEqual(['legacy_json', 'json_block', 'macro_setvar'])
    expect(builtins.find((r) => r.dialect === 'macro_setvar')?.disabled).toBe(true)
    expect(builtins.filter((r) => !r.disabled)).toHaveLength(2)
  })
})

describe('extractStateSyncUpdates（内置规则）', () => {
  it('原生 <ui_template_updates> 块照常解析（与旧管线等价）', () => {
    const text = '正文\n<ui_template_updates>{"updates":[{"id":"t1","variables":{"hp":10}}]}</ui_template_updates>'
    const ups = extractStateSyncUpdates(text, builtins)
    expect(ups).toEqual([{ id: 't1', variables: { hp: 10 } }])
  })

  it('酒馆 <UpdateVariable> 平铺 JSON：键即变量路径', () => {
    const text = '正文\n<UpdateVariable>\n{"hp": 80, "env_weather": "小雨"}\n</UpdateVariable>'
    const ups = extractStateSyncUpdates(text, builtins)
    expect(ups).toEqual([{ id: undefined, name: undefined, variables: { hp: 80, env_weather: '小雨' } }])
  })

  it('<UpdateVariable> 带 id/name 元字段或 variables 包装时按语义解析', () => {
    const withMeta = '<UpdateVariable>{"name":"面板","hp":5}</UpdateVariable>'
    expect(extractStateSyncUpdates(withMeta, builtins)).toEqual([{ id: undefined, name: '面板', variables: { hp: 5 } }])
    const wrapped = '<UpdateVariable>{"variables":{"hp":5}}</UpdateVariable>'
    expect(extractStateSyncUpdates(wrapped, builtins)).toEqual([{ variables: { hp: 5 } }])
  })

  it('卡级自定义标签块（json_block）可接入任意方言（含中文标签名）', () => {
    const rule: StateSyncRule = { name: '自定义', pattern: '<状态(?=[\\s>/])[^>]*>([\\s\\S]*?)</状态>', flags: 'gi', dialect: 'json_block' }
    const ups = extractStateSyncUpdates('正文<状态>{"金币": 100}</状态>', [rule])
    expect(ups).toEqual([{ variables: { 金币: 100 } }])
  })

  it('规则 template 字段固定目标模板（id 形态 / 名称形态）', () => {
    const byId = extractStateSyncUpdates('<UpdateVariable>{"hp":1}</UpdateVariable>', [
      { name: 'r', pattern: '<UpdateVariable\\b[^>]*>([\\s\\S]*?)</UpdateVariable>', dialect: 'json_block', template: 'abc12345-aaaa' },
    ])
    expect(byId[0].id).toBe('abc12345-aaaa')
    const byName = extractStateSyncUpdates('<UpdateVariable>{"hp":1}</UpdateVariable>', [
      { name: 'r', pattern: '<UpdateVariable\\b[^>]*>([\\s\\S]*?)</UpdateVariable>', dialect: 'json_block', template: '状态面板' },
    ])
    expect(byName[0].name).toBe('状态面板')
  })

  it('setvar 宏：内置默认关闭不提取；卡级启用后按命名组提取并矫正类型', () => {
    const text = '她说「好的」。{{setvar::玩家.金钱::250}}{{setglobalvar::flag_open::true}}'
    expect(extractStateSyncUpdates(text, builtins)).toEqual([])
    const rules = [...builtins, { name: '宏', pattern: '\\{\\{set(?:global)?var::(?<path>[^:{}]+)::(?<value>[\\s\\S]*?)\\}\\}', flags: 'g', dialect: 'macro_setvar' as const }]
    const ups = extractStateSyncUpdates(text, rules)
    expect(ups).toHaveLength(2)
    expect(ups[0].variables).toEqual({ '玩家.金钱': 250 })
    expect(ups[1].variables).toEqual({ flag_open: true })
  })

  it('坏 JSON / 非匹配文本安静返回空', () => {
    expect(extractStateSyncUpdates('<UpdateVariable>不是json</UpdateVariable>', builtins)).toEqual([])
    expect(extractStateSyncUpdates('普通正文，无任何块', builtins)).toEqual([])
  })
})

describe('stripStateSyncBlocks', () => {
  it('剥离全部方言的更新块，正文保留', () => {
    const text = [
      '开头',
      '<ui_template_updates>{"updates":[]}</ui_template_updates>',
      '中间',
      '<UpdateVariable>{"hp":1}</UpdateVariable>',
      '结尾',
    ].join('\n')
    // 块整体移除，块两侧的换行保留（markdown 渲染时空行无害）
    expect(stripStateSyncBlocks(text, builtins).replace(/\n+/g, '\n')).toBe(['开头', '中间', '结尾'].join('\n'))
  })

  it('自定义规则同样剥离；大小写按 flags 处理', () => {
    const rules = [builtinStateSyncRules()[1]]
    expect(stripStateSyncBlocks('A<updatevariable>{"hp":1}</updatevariable>B', rules)).toBe('AB')
  })
})

describe('残缺更新块（输出被 max_tokens 截断）', () => {
  it('只有开标签、没有闭合标签时，开标签到文末全部剥掉', () => {
    const text = '正文写到一半，困意涌上来。\n<ui_template_updates>\n{"updates":[{"id":"t1","variables":{"time":"22:3'
    const out = stripStateSyncBlocks(text, builtins)
    expect(out).not.toContain('ui_template_updates')
    expect(out).not.toContain('updates')
    expect(out.trim()).toBe('正文写到一半，困意涌上来。')
  })

  it('UpdateVariable 残缺开块同样剥离', () => {
    const text = '正文<UpdateVariable>{"hp":'
    expect(stripStateSyncBlocks(text, builtins)).toBe('正文')
  })

  it('完整闭合块不受 openPattern 影响', () => {
    const text = '正文<ui_template_updates>{"updates":[]}</ui_template_updates>结尾'
    expect(stripStateSyncBlocks(text, builtins)).toBe('正文结尾')
  })

  it('hasUnclosedSyncBlock：残缺块返回 true，完整块/无块返回 false', () => {
    expect(hasUnclosedSyncBlock('正文<ui_template_updates>{"updates":[', builtins)).toBe(true)
    expect(hasUnclosedSyncBlock('正文<ui_template_updates>{"updates":[]}</ui_template_updates>', builtins)).toBe(false)
    expect(hasUnclosedSyncBlock('纯正文', builtins)).toBe(false)
  })

  it('前置更新块被 max_tokens 截断时，extract 抢救已完整写出的字段（块在正文前、正文尚未开始）', () => {
    // 模型先输出更新块，第三个字段写一半就 finish=length，闭合标签与正文都还没来得及输出
    const text = '<ui_template_updates>\n{"updates":[{"id":"t1","variables":{"time":"22:30","weather":"晴","scene":"卧'
    const ups = extractStateSyncUpdates(text, builtins)
    expect(ups).toHaveLength(1)
    expect(ups[0].id).toBe('t1')
    expect(ups[0].variables).toMatchObject({ time: '22:30', weather: '晴' })
  })

  it('已有完整闭合块时，残缺抢救不重复解析同一份', () => {
    const text = '<ui_template_updates>{"updates":[{"id":"t1","variables":{"hp":10}}]}</ui_template_updates>'
    const ups = extractStateSyncUpdates(text, builtins)
    expect(ups).toEqual([{ id: 't1', variables: { hp: 10 } }])
  })
})

describe('normalizeStateSyncRule', () => {
  it('宽松归一化：enabled:false 视为禁用；正则编译失败返回 null', () => {
    expect(normalizeStateSyncRule({ name: 'x', pattern: '[unclosed', dialect: 'json_block' })).toBeNull()
    expect(normalizeStateSyncRule({ name: 'x', enabled: false, pattern: 'a', dialect: 'json_block' })?.disabled).toBe(true)
    expect(normalizeStateSyncRule({ regex: 'a', parser: 'legacy_json' })).toMatchObject({ pattern: 'a', dialect: 'legacy_json' })
    expect(normalizeStateSyncRules([{ name: 'ok', pattern: 'a' }, '垃圾', null])).toHaveLength(1)
  })
})

describe('applyUiTemplateUpdates 深合并（解析回写端加固）', () => {
  it('嵌套对象部分更新保留兄弟键；数组与标量整体替换', () => {
    const t = tpl('t1', '面板', { stats: { hp: 100, mp: 50 }, bag: ['旧'], name: '甲' })
    const r = applyUiTemplateUpdates({}, [t], [{ id: 't1', variables: { stats: { hp: 80 }, bag: ['新'], name: '乙' } }])
    expect(r.states.t1.stats).toEqual({ hp: 80, mp: 50 })
    expect(r.states.t1.bag).toEqual(['新'])
    expect(r.states.t1.name).toBe('乙')
    expect(r.changedCount).toBe(3)
  })

  it('深路径写值同样支持合并', () => {
    const t = tpl('t1', '面板', { a: { b: { x: 1, y: 2 } } })
    const r = applyUiTemplateUpdates({}, [t], [{ id: 't1', variables: { 'a.b': { x: 9 } } }])
    expect(r.states.t1.a).toEqual({ b: { x: 9, y: 2 } })
  })

  it('值完全一致时 changedCount 为 0（对象合并无差异）', () => {
    const t = tpl('t1', '面板', { stats: { hp: 1 } })
    expect(applyUiTemplateUpdates({}, [t], [{ id: 't1', variables: { stats: { hp: 1 } } }]).changedCount).toBe(0)
  })
})

describe('端到端：规则提取 → 回写 → 与旧链路互通', () => {
  it('混合方言的多块回复一次性回写', () => {
    const t = tpl('t1', '状态面板', { hp: 1, env_weather: '晴' })
    const text = [
      '剧情正文。',
      '<ui_template_updates>{"updates":[{"id":"t1","variables":{"hp":77}}]}</ui_template_updates>',
      '<UpdateVariable>{"env_weather":"暴雨"}</UpdateVariable>',
    ].join('\n')
    const ups = extractStateSyncUpdates(text, builtins)
    const r = applyUiTemplateUpdates({}, [t], ups)
    expect(r.states.t1).toEqual({ hp: 77, env_weather: '暴雨' })
    expect(stripStateSyncBlocks(text, builtins).trim()).toBe('剧情正文。')
  })
})

describe('buildAuxAnalysisMessages（副模型兜底分析）', () => {
  it('带全部启用模板的当前变量与最近楼层；无模板或无楼层返回空', () => {
    const t = tpl('t1', '状态面板', { hp: 5 })
    const msgs = buildAuxAnalysisMessages(
      [t],
      { t1: { hp: 66 } },
      [
        { role: 'user', name: '我', content: '我推开门' },
        { role: 'assistant', name: 'AI', content: '屋里有雨声' },
      ],
    )
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('状态面板')
    expect(msgs[0].content).toContain('"hp": 66')
    expect(msgs[0].content).toContain('"id"')
    expect(msgs[1].content).toContain('我推开门')
    expect(buildAuxAnalysisMessages([], {}, [{ role: 'user', name: '我', content: 'x' }])).toEqual([])
    expect(buildAuxAnalysisMessages([t], {}, [])).toEqual([])
  })

  it('禁用模板被排除', () => {
    const on = tpl('t1', '启用', { hp: 1 })
    const off = { ...tpl('t2', '停用', { mp: 1 }), enabled: false }
    const msgs = buildAuxAnalysisMessages([on, off], {}, [{ role: 'user', name: '我', content: 'x' }])
    expect(msgs[0].content).toContain('启用')
    expect(msgs[0].content).not.toContain('停用')
  })

  it('副模型返回的裸 JSON / 围栏 / 标签 / think 包裹都能解析', () => {
    const bare = '{"updates":[{"id":"t1","variables":{"hp":9}}]}'
    const want = [{ id: 't1', variables: { hp: 9 } }]
    expect(parseUpdatesPayload(bare)).toEqual(want)
    expect(parseUpdatesPayload('```json\n' + bare + '\n```')).toEqual(want)
    expect(parseUpdatesPayload('<ui_template_updates>' + bare + '</ui_template_updates>')).toEqual(want)
    expect(parseUpdatesPayload(parseCot('<think>推理</think>' + bare).main)).toEqual(want)
  })
})
