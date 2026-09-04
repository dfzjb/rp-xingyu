import { describe, expect, it } from 'vitest'
import { pickLightModel } from '../src/lib/aux-model'
import {
  buildAuxAnalysisMessages,
  buildUiTemplateUpdateInstruction,
  parseUpdatesPayload,
  parseAuxPayload,
} from '../src/lib/ui-template-state'
import { normalizeUiTemplate, type UiTemplate } from '../src/lib/uitemplate'

function makeTpl(vars: Record<string, unknown>): UiTemplate {
  return normalizeUiTemplate({
    id: 't1',
    name: '状态面板',
    enabled: true,
    htmlTemplate: '<div>{{env_location}} {{choice_summary}}</div>',
    initialVariableState: vars,
  })
}

const VARS = {
  p_name: '林晓雨',
  p_appearance_full: '粉长发', // 静态资料，不应进必刷新清单
  env_location: '星巴克',
  env_time: '14:23',
  choice_summary: '你在星巴克遇到林雨薇',
  choice_a_label: '打招呼',
  npc1_name: '林雨薇',
  npc1_relation: '朋友',
  p_mood_text: '焦虑',
}

describe('pickLightModel 后台补全模型选择', () => {
  it('列表为空时回退主模型', () => {
    expect(pickLightModel([], 'deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(pickLightModel(undefined, 'x')).toBe('x')
  })
  it('优先选 deepseek flash（非 fast 精确版）', () => {
    const list = ['deepseek-v4-pro', 'deepseek-v4-flash', 'gemini-3.8-flash']
    expect(pickLightModel(list, 'deepseek-v4-pro')).toBe('deepseek-v4-flash')
    expect(pickLightModel(['deepseek-v4-flash-fast', 'deepseek-v4-flash'], 'pro')).toBe('deepseek-v4-flash')
  })
  it('排除 thinking/opus 等重型思考模型', () => {
    const list = ['[AN]gemini-3.8-flash-thinking', '[AN]claude-opus-4-6', 'gemini-3.8-flash']
    expect(pickLightModel(list, 'deepseek-v4-pro')).toBe('gemini-3.8-flash')
  })
  it('只有重型模型时回退主模型', () => {
    expect(pickLightModel(['[AN]claude-opus-4-6', 'gemini-3.1-pro-thinking'], 'deepseek-v4-pro')).toBe('deepseek-v4-pro')
  })
  it('非 fast 的精确 flash 优先于 flash-fast（fast 会全量回写易截断）', () => {
    expect(pickLightModel(['deepseek-v4-flash-fast', 'deepseek-v4-flash'], 'pro')).toBe('deepseek-v4-flash')
    // 只有 fast 变体时仍用它（好过重型思考模型）
    expect(pickLightModel(['deepseek-v4-flash-fast', 'deepseek-v4-pro'], 'deepseek-v4-pro')).toBe('deepseek-v4-flash-fast')
  })
  it('同优先级优先无 [渠道] 前缀的主渠道 id', () => {
    const list = ['[次][Cloud]DeepSeek-V4-Flash', 'deepseek-v4-flash'].sort()
    expect(pickLightModel(list, 'pro')).toBe('deepseek-v4-flash')
  })
})

describe('补全/主模型指令的「每幕必刷新」提示', () => {
  it('补全消息点名场景/选项/在场角色字段，且不把静态资料列入', () => {
    const tpl = makeTpl(VARS)
    const msgs = buildAuxAnalysisMessages([tpl], {}, [
      { role: 'user', name: '我', content: '深夜在卧室' },
      { role: 'assistant', name: 'AI', content: '陆晴抱着你' },
    ])
    const sys = msgs[0].content
    expect(sys).toContain('每幕必刷新')
    expect(sys).toContain('choice_summary')
    expect(sys).toContain('choice_a_label')
    expect(sys).toContain('env_location')
    expect(sys).toContain('npc1_name')
    // 静态外貌/姓名不属于每幕必刷新字段
    const refreshBlock = sys.slice(sys.indexOf('每幕必刷新'), sys.indexOf('模板与当前变量'))
    expect(refreshBlock).not.toContain('p_appearance_full')
    // 当前变量全量仍在（保证路径准确）
    expect(sys).toContain('林雨薇')
  })

  it('主模型更新指令同样携带必刷新提示', () => {
    const tpl = makeTpl(VARS)
    const instr = buildUiTemplateUpdateInstruction([tpl], {})
    expect(instr).toContain('每幕必刷新')
    expect(instr).toContain('choice_summary')
  })

  it('没有任何动态字段时不硬塞提示（返回指令仍可用）', () => {
    const tpl = makeTpl({ p_name: 'A', p_appearance_full: 'B' })
    const instr = buildUiTemplateUpdateInstruction([tpl], {})
    expect(instr).not.toContain('每幕必刷新')
    expect(instr).toContain('ui_template_updates')
  })
})

describe('parseUpdatesPayload 截断 JSON 抢救', () => {
  it('完整 JSON 正常解析', () => {
    const ups = parseUpdatesPayload('{"updates":[{"id":"t1","variables":{"a":"1"}}]}')
    expect(ups).toHaveLength(1)
    expect(ups[0].variables?.a).toBe('1')
  })
  it('尾部被 max_tokens 截断、缺闭合括号时救回已完整写出的字段', () => {
    // 最后字段 c 后本应有 }}，实际只剩 ]}（fast 模型全量回写被砍断的典型形态）
    const truncated = '{"updates":[{"id":"t1","variables":{"env_location":"卧室","choice_summary":"深夜","npc1_name":"陆晴"}]}'
    const ups = parseUpdatesPayload(truncated)
    expect(ups.length).toBe(1)
    const v = ups[0].variables || {}
    expect(v.env_location).toBe('卧室')
    expect(v.choice_summary).toBe('深夜')
  })
  it('彻底无法解析时返回空数组而非抛错', () => {
    expect(parseUpdatesPayload('完全不是JSON的一段解释文字')).toEqual([])
  })
})

describe('补全一次调用同时产出变量更新与 NPC 好感（方案C）', () => {
  it('补全指令携带 affinity 格式与已有 NPC 名册', () => {
    const tpl = makeTpl(VARS)
    const msgs = buildAuxAnalysisMessages(
      [tpl], {},
      [{ role: 'assistant', name: 'AI', content: '陆晴抱着你' }],
      [{ npcName: '陆晴', score: 62, stage: '亲密' }],
    )
    const sys = msgs[0].content
    expect(sys).toContain('affinity')
    expect(sys).toContain('interest')
    expect(sys).toContain('conflict')
    expect(sys).toContain('陆晴（综合62·亲密）')
    // 不传已有名册也不报错（第 4 参数可选，向后兼容）
    expect(buildAuxAnalysisMessages([tpl], {}, [{ role: 'user', name: '我', content: 'x' }])).toHaveLength(2)
  })

  it('parseAuxPayload 同时解析 updates 与 affinity', () => {
    const raw = JSON.stringify({
      updates: [{ id: 't1', variables: { env_location: '卧室', npc1_name: '陆晴' } }],
      affinity: [{ npcName: '陆晴', interest: 70, trust: 80, attraction: 60, conflict: 0 }],
    })
    const p = parseAuxPayload(raw)
    expect(p.updates).toHaveLength(1)
    expect(p.updates[0].variables?.npc1_name).toBe('陆晴')
    expect(p.affinity).toHaveLength(1)
    expect(p.affinity[0].npcName).toBe('陆晴')
    expect(p.affinity[0].trust).toBe(80)
  })

  it('只有 updates、缺 affinity 时 affinity 为空数组且不影响 updates', () => {
    const p = parseAuxPayload('{"updates":[{"id":"t1","variables":{"a":1}}]}')
    expect(p.updates).toHaveLength(1)
    expect(p.affinity).toEqual([])
  })

  it('affinity 中缺 npcName 的脏数据被过滤', () => {
    const p = parseAuxPayload(JSON.stringify({
      updates: [],
      affinity: [{ interest: 1 }, { npcName: '陆晴', trust: 50 }],
    }))
    expect(p.affinity).toHaveLength(1)
    expect(p.affinity[0].npcName).toBe('陆晴')
  })
})
