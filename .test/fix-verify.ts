import { parseUiTemplateUpdates, applyUiTemplateUpdates, stripUiTemplateUpdates, buildUiTemplateUpdateInstruction, buildUiTemplateContextPrompt } from '../src/lib/ui-template-state'
import type { UiTemplate } from '../src/lib/uitemplate'

const tpl: UiTemplate = {
  id: 't1', name: '面板', enabled: true, order: 1, placement: 'bottom',
  htmlTemplate: '<div>{{items.0.name}}</div>',
  initialVariableState: { hp: 100, items: [{ name: '剑' }] },
}

// 1. 多块解析
const text = '正文A<ui_template_updates>{"updates":[{"id":"t1","variables":{"hp":80}}]}</ui_template_updates>中间<ui_template_updates>{"updates":[{"id":"t1","variables":{"items.0.name":"圣剑"}}]}</ui_template_updates>'
const ups = parseUiTemplateUpdates(text)
console.log('multi-block updates =', JSON.stringify(ups))
if (ups.length !== 2) throw new Error('multi-block parse failed')

// 2. 应用路径更新
const r = applyUiTemplateUpdates({}, [tpl], ups)
console.log('states =', JSON.stringify(r.states), 'changed =', r.changedCount)
if (r.states.t1.hp !== 80 || r.states.t1.items[0].name !== '圣剑') throw new Error('apply failed')

// 3. 剥离
const stripped = stripUiTemplateUpdates(text)
console.log('stripped =', JSON.stringify(stripped))
if (stripped.includes('ui_template_updates') || !stripped.includes('正文A')) throw new Error('strip failed')

// 4. 流式未闭合块剥离
if (!stripUiTemplateUpdates('正文<ui_template_updates>{"upd').includes('正文')) throw new Error('open-strip failed')

// 5. 更新指令用会话实时状态（而非卡内初始值）
const instr = buildUiTemplateUpdateInstruction([tpl], r.states)
if (!instr.includes('"hp": 80') || !instr.includes('圣剑')) throw new Error('instruction state override failed')
console.log('instruction has live state: OK')

// 6. 状态上下文同样优先实时状态
const ctx = buildUiTemplateContextPrompt([tpl], r.states)
if (!ctx.includes('圣剑')) throw new Error('context state override failed')
console.log('context has live state: OK')

// 7. 未传 states 时回退静态值（兼容）
const instr2 = buildUiTemplateUpdateInstruction([tpl])
if (!instr2.includes('"hp": 100')) throw new Error('fallback failed')
console.log('fallback to static: OK')
console.log('ALL PASS')
