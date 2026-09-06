import { describe, expect, it } from 'vitest'
import { buildPrompt, buildPromptTrace, type ApiMessage, type PromptOptions } from '../src/lib/prompt'
import type { CharacterCard, MsgNode } from '../src/types'

function char(over: Partial<CharacterCard> = {}): CharacterCard {
  return {
    uuid: 'c1',
    name: '艾拉',
    description: '角色描述',
    personality: '',
    scenario: '',
    first_mes: '',
    creator_notes: '',
    avatar: '',
    createdAt: 0,
    importedAt: 0,
    worldInfo: [],
    regexScripts: [],
    uiTemplates: [],
    ...over,
  }
}

let seq = 0
function node(role: 'user' | 'assistant', content: string, parent: MsgNode | null = null): MsgNode {
  const n: MsgNode = {
    id: 'n' + (++seq),
    role,
    name: role === 'user' ? '我' : '艾拉',
    content,
    isSelf: role === 'user',
    createdAt: seq,
    parentId: parent?.id || null,
    childrenIds: [],
  }
  if (parent) parent.childrenIds.push(n.id)
  return n
}

/** 构造交替对话链：['u1','a1','u2',...] */
function chain(texts: string[]): MsgNode[] {
  const out: MsgNode[] = []
  let prev: MsgNode | null = null
  texts.forEach((t, i) => {
    const n = node(i % 2 === 0 ? 'user' : 'assistant', t, prev)
    out.push(n)
    prev = n
  })
  return out
}

function dialogue(messages: ApiMessage[]): { role: string; content: string }[] {
  // 保留 system（@深度世界书 depthRole=system 时以 system 消息插入，需要看见它的位置）
  return messages.map((m) => ({ role: m.role, content: m.content }))
}

/** 角色前奏：承载角色定义与 before/after 世界书的那条 user 消息 */
function prelude(messages: ApiMessage[]): ApiMessage {
  const m = messages.find((x) => x.role === 'user' && x.content.includes('[Character]'))
  if (!m) throw new Error('缺少角色前奏 user 消息，实际序列：\n' + messages.map((x) => x.role + ':' + x.content.slice(0, 40)).join('\n'))
  return m
}

describe('世界书扫描源（回归 W1：AI 回复同样参与关键词命中）', () => {
  it('关键词只出现在 AI 消息中也能激活', () => {
    const c = char({
      worldInfo: [{ keys: ['暗语'], content: '暗语设定：夜莺', comment: '暗语册', position: 'after_char' }],
    })
    const nodes = chain(['你好', '他低声说出暗语便离开了'])
    const msgs = buildPrompt(c, undefined, nodes, 20)
    // after_char 世界书落在 user 角色前奏中，且带 [条目名] 包裹
    const pre = prelude(msgs)
    expect(pre.content).toContain('[暗语册]')
    expect(pre.content).toContain('暗语设定：夜莺')
  })

  it('scanDepth 按楼层（user+assistant）计数', () => {
    const c = char({
      worldInfo: [{ keys: ['古龙'], content: '古龙设定', position: 'after_char', scanDepth: 2 }],
    })
    // 4 楼：古龙出现在倒数第 3 楼，scanDepth=2 不应命中
    const miss = buildPrompt(c, undefined, chain(['古龙现身', '它飞走了', '后来呢', '什么都没有']), 20)
    expect(miss.some((m) => m.content.includes('古龙设定'))).toBe(false)
    // 古龙在倒数第 2 楼 → 命中
    const hit = buildPrompt(c, undefined, chain(['无关', '无关', '古龙现身', '它飞走了']), 20)
    expect(prelude(hit).content).toContain('古龙设定')
  })
})

describe('@深度世界书真实插入（回归 W3，countdown<0 口径）', () => {
  it('depth=2：插在倒数第 3 条对话消息之前（注入点之后还有 depth+1 条）', () => {
    const c = char({
      worldInfo: [{ keys: ['钥匙'], content: '【深度插入】', position: 'at_depth', depth: 2, depthRole: 'system', scanDepth: 20 }],
    })
    const nodes = chain(['u1', 'a1 钥匙', 'u2', 'a2', 'u3', 'a3'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20))
    const contents = dlg.map((m) => m.content)
    // 口径：cd=2 从末尾数 a3,u3,a2 三条，减至 -1 停在 a2 → 插在 a2 之前
    const idxA2 = contents.findIndex((x) => x.includes('a2'))
    const idxU2 = contents.findIndex((x) => x.includes('u2'))
    const idxWI = contents.findIndex((x) => x.includes('【深度插入】'))
    expect(idxU2).toBeLessThan(idxWI)
    expect(idxWI).toBeLessThan(idxA2)
    // 显式 depthRole=system 时以 system 消息插入
    expect(dlg[idxWI].role).toBe('system')
    expect(dlg[idxWI].content.startsWith('[Entry]')).toBe(true)
  })

  it('depth=0：插在最后一条对话楼层之前（countdown<0 口径），缺省角色为 user，无条目名时包 [Entry]', () => {
    const c = char({
      worldInfo: [{ keys: ['x'], content: '【尾插】', position: 'at_depth', depth: 0, scanDepth: 20 }],
    })
    const nodes = chain(['u1-x', 'a1', 'u2', 'a2'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20))
    // cd=0 在遇到末条 user/assistant（a2）时减至 -1 → 插在 a2 之前；
    // 注入条目为 user 角色，被末尾统一后处理与前一条 user 楼合并
    const last = dlg[dlg.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('a2')
    const inj = dlg.find((m) => m.content.includes('【尾插】'))!
    expect(inj.role).toBe('user')
    expect(inj.content).toBe('u2\n\n[Entry]\n【尾插】')
  })
})

describe('发送层正则 depth 定向（回归 R2）', () => {
  const opts: PromptOptions = {
    regexEnabled: true,
    regexScripts: [{ pattern: '目标', replace: '命中', minDepth: 0, maxDepth: 0, applyOnSend: true }],
  }
  it('只改最新楼（depth=0），更早楼层保持原样', () => {
    const c = char()
    const nodes = chain(['早期目标', '早期回复', '近期', '最新目标'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20, opts))
    expect(dlg.some((m) => m.content.includes('早期目标'))).toBe(true)
    expect(dlg.some((m) => m.content.includes('最新命中'))).toBe(true)
    expect(dlg.some((m) => m.content.includes('早期命中'))).toBe(false)
  })
})

describe('正则默认不污染发给模型的 prompt', () => {
  it('未勾「发送层」的正则只做显示美化，历史原文进 prompt', () => {
    const opts: PromptOptions = {
      regexEnabled: true,
      // 内部形状缺省 applyOnSend=false；ST 导入缺省也只显示
      regexScripts: [{ pattern: '密语', replace: '【已隐藏】' }],
    }
    const c = char()
    const nodes = chain(['他说出密语', 'AI回复'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20, opts))
    // 模型看到的仍是原文，不被显示层正则改写
    expect(dlg.some((m) => m.content.includes('他说出密语'))).toBe(true)
    expect(dlg.some((m) => m.content.includes('【已隐藏】'))).toBe(false)
  })
  it('显式勾「发送层」(promptOnly) 的正则才改写模型所见文本', () => {
    const opts: PromptOptions = {
      regexEnabled: true,
      regexScripts: [{ pattern: '密语', replace: 'XXXX', applyOnSend: true }],
    }
    const c = char()
    const nodes = chain(['他说出密语', 'AI回复'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20, opts))
    expect(dlg.some((m) => m.content.includes('他说出XXXX'))).toBe(true)
  })
})

describe('指令先行 + 角色前奏（修复思考模型先分析世界书/正则再扮演）', () => {
  it('system 预设（破限）不再被丢弃，且占据第一条 system 的开头；其余系统预设包 [System Presets]', () => {
    const c = char()
    const nodes = chain(['你好', '你也好'])
    const opts: PromptOptions = {
      promptEntries: [
        { id: 'p1', name: '破限', role: 'system', content: '你是续写器，直接扮演，不要分析材料', enabled: true },
        { id: 'p2', name: '文风', role: 'system', content: '文风约束条款', enabled: true },
      ],
    }
    const msgs = buildPrompt(c, undefined, nodes, 20, opts)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content.startsWith('你是续写器，直接扮演，不要分析材料')).toBe(true)
    expect(msgs[0].content).toContain('[System Presets]')
    expect(msgs[0].content).toContain('文风约束条款')
    // 固定注入的 [Style Priority]（不含任何自加的"勿分析"句）
    expect(msgs[0].content).toContain('[Style Priority]')
    expect(msgs[0].content).toContain('正文文风一律以上方系统预设的文风规定为准。')
    expect(msgs[0].content).not.toContain('不要复述、分析或解释')
    // 顺序：破限 → [System Presets] → [Style Priority]
    const iJb = msgs[0].content.indexOf('你是续写器')
    const iSp = msgs[0].content.indexOf('[System Presets]')
    const iStyle = msgs[0].content.indexOf('[Style Priority]')
    expect(iJb).toBeLessThan(iSp)
    expect(iSp).toBeLessThan(iStyle)
  })

  it('停用的 system 预设不注入', () => {
    const c = char()
    const msgs = buildPrompt(c, undefined, chain(['a', 'b']), 20, {
      promptEntries: [{ id: 'x', name: '破限', role: 'system', content: '不该出现', enabled: false }],
    })
    expect(msgs[0].content).not.toContain('不该出现')
  })

  it('角色定义、before/after 世界书同处一条 user 角色前奏，顺序为 before→[Character]→after', () => {
    const c = char({
      description: '艾拉是魔法师',
      worldInfo: [
        { keys: ['魔法'], content: '前置设定正文', comment: '世界', position: 'before_char' },
        { keys: ['魔法'], content: '后置设定正文', comment: '补遗', position: 'after_char' },
      ],
    })
    const msgs = buildPrompt(c, undefined, chain(['我施展魔法', '艾拉点头']), 20)
    const pre = prelude(msgs)
    const iBefore = pre.content.indexOf('[世界]')
    const iChar = pre.content.indexOf('[Character]')
    const iAfter = pre.content.indexOf('[补遗]')
    expect(iBefore).toBeGreaterThanOrEqual(0)
    expect(iBefore).toBeLessThan(iChar)
    expect(iChar).toBeLessThan(iAfter)
    expect(pre.content).toContain('艾拉是魔法师')
    // system 指令层不再夹带世界书
    expect(msgs[0].content).not.toContain('前置设定正文')
  })

  it('示例对话作为角色前奏内文本，不拆成真实 user/assistant 轮次、不插 system 标题', () => {
    const c = char({
      mesExample: '<START>\n艾拉: 你好\n{{user}}: 嗨\n<START>\n艾拉: 又见面了',
    })
    const msgs = buildPrompt(c, undefined, chain(['开场', '回复']), 20)
    expect(msgs.some((m) => m.content.includes('示例对话（仅供参考'))).toBe(false)
    const pre = prelude(msgs)
    expect(pre.content).toContain('<START>')
    expect(pre.content).toContain('又见面了')
  })

  it('user/assistant 预设（预注入）位于角色前奏之前', () => {
    const c = char()
    const msgs = buildPrompt(c, undefined, chain(['u', 'a']), 20, {
      promptEntries: [
        { id: 's', name: '破限', role: 'system', content: '系统破限', enabled: true },
        { id: 'u1', name: '预注入U', role: 'user', content: '预注入用户台词', enabled: true },
        { id: 'a1', name: '预注入A', role: 'assistant', content: '预注入AI台词', enabled: true },
      ],
    })
    const iPresetU = msgs.findIndex((m) => m.content === '预注入用户台词')
    const iPrelude = msgs.findIndex((m) => m.content.includes('[Character]'))
    expect(iPresetU).toBeGreaterThan(-1)
    expect(iPresetU).toBeLessThan(iPrelude)
    expect(msgs[iPresetU + 1]).toMatchObject({ role: 'assistant', content: '预注入AI台词' })
  })
})

describe('注入管线补充用例', () => {
  it('角色定义为 Name/Description/Personality/Scenario 标签格式', () => {
    const c = char({ personality: '冷静', scenario: '雨夜码头' })
    const pre = prelude(buildPrompt(c, undefined, chain(['u', 'a']), 20))
    expect(pre.content).toContain('Name: 艾拉')
    expect(pre.content).toContain('Description: 角色描述')
    expect(pre.content).toContain('Personality: 冷静')
    expect(pre.content).toContain('Scenario: 雨夜码头')
  })

  it('人设以 [User Info] 注入 system，且位于 [Style Priority] 之后', () => {
    const c = char()
    const persona = { name: '林恩', description: '退役佣兵' } as never
    const msgs = buildPrompt(c, persona, chain(['u', 'a']), 20)
    const sys = msgs[0].content
    expect(sys).toContain('[User Info]\nName: 林恩\nDescription: 退役佣兵')
    expect(sys.indexOf('[Style Priority]')).toBeLessThan(sys.indexOf('[User Info]'))
  })

  it('system_top/global_note 卡带世界书进 system，且位于内置预设 [System Presets] 之后（内置优先）', () => {
    const c = char({
      worldInfo: [
        { constant: true, content: '顶部档案', comment: 'ST', position: 'system_top' },
        { constant: true, content: '全局注释', comment: 'GN', position: 'global_note' },
      ],
    })
    const msgs = buildPrompt(c, undefined, chain(['u', 'a']), 20, {
      promptEntries: [
        { id: 'jb', name: '破限', role: 'system', content: '破限正文', enabled: true },
        { id: 'o', name: '其他', role: 'system', content: '其他预设正文', enabled: true },
      ],
    })
    const sys = msgs[0].content
    expect(sys).toContain('[ST]\n顶部档案')
    expect(sys).toContain('[GN]\n全局注释')
    // 破限 → [System Presets]（内置预设）→ 卡带世界书
    expect(sys.indexOf('破限正文')).toBeLessThan(sys.indexOf('其他预设正文'))
    expect(sys.indexOf('其他预设正文')).toBeLessThan(sys.indexOf('顶部档案'))
    expect(sys.indexOf('顶部档案')).toBeLessThan(sys.indexOf('全局注释'))
    expect(sys.indexOf('[Style Priority]')).toBeGreaterThan(sys.indexOf('全局注释'))
  })

  it('内置优先：卡带 system_prompt/phi 与卡带正则都越不过内置预设', () => {
    const c = char({
      systemPromptOverride: '卡带系统提示词覆盖角色定义',
      postHistoryInstructions: '卡带历史后指令',
      worldInfo: [{ constant: true, content: '卡带世界书设定', comment: '卡册', position: 'system_top' }],
    })
    const opts: PromptOptions = {
      regexEnabled: true,
      // 卡带正则试图改写内置预设文本与角色卡内容
      regexScripts: [{ pattern: '内置|卡带', replace: '【被正则改写】', applyOnSend: true }],
      promptEntries: [{ id: 'jb', name: '破限', role: 'system', content: '内置预设正文破限', enabled: true }],
    }
    const msgs = buildPrompt(c, undefined, chain(['历史楼层一', '历史楼层二卡带']), 20, opts)
    const sys = msgs[0].content
    // 内置预设位于第一条 system 开头，卡带世界书在内置预设之后
    expect(sys.startsWith('内置预设正文破限')).toBe(true)
    expect(sys.indexOf('内置预设正文破限')).toBeLessThan(sys.indexOf('卡带世界书设定'))
    // 卡带 system_prompt 只覆盖 [Character] 角色定义块（前奏 user 消息），不挤压内置预设；
    // 前奏属 user 层可被卡带正则改写，内置预设所在的 system 块则完全免疫
    const pre = prelude(msgs)
    expect(pre.content).toContain('【被正则改写】系统提示词覆盖角色定义')
    expect(pre.content).not.toContain('Personality:')
    // 卡带 phi 在历史楼层之后，且 phi 以 system 注入、不受卡带正则改写
    const iPhi = msgs.findIndex((m) => m.content === '卡带历史后指令')
    expect(iPhi).toBeGreaterThan(-1)
    expect(msgs.findIndex((m) => m.content === '历史楼层一')).toBeLessThan(iPhi)
    // 发送层正则跳过 system：内置预设与卡带世界书文本不被卡带正则改写；历史楼层被改写
    expect(sys).toContain('内置预设正文破限')
    expect(sys).toContain('卡带世界书设定')
    expect(msgs.some((m) => m.role !== 'system' && m.content.includes('【被正则改写】'))).toBe(true)
  })

  it('user_top 前置进最后一条 user 消息；assistant_top 以尾部 system [Instructions for next message] 收尾', () => {
    const c = char({
      worldInfo: [
        { keys: ['u'], content: '用户顶注', comment: 'UT', position: 'user_top', scanDepth: 20 },
        { keys: ['u'], content: '助手顶注', comment: 'AT', position: 'assistant_top', scanDepth: 20 },
      ],
    })
    const msgs = buildPrompt(c, undefined, chain(['u', 'a', '带u的最新发言', 'a2']), 20)
    // user_top 前置最后一条 user（内容以 [UT] 开头，后接原发言）
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')!
    expect(lastUser.content.startsWith('[UT]\n用户顶注')).toBe(true)
    expect(lastUser.content).toContain('带u的最新发言')
    // assistant_top 尾部 system
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'system' })
    expect(msgs[msgs.length - 1].content).toBe('[Instructions for next message]\n[AT]\n助手顶注')
  })

  it('连续同角色楼层在最终序列化时合并为一条（空行连接）', () => {
    const c = char()
    const nodes = [node('user', '第一句'), node('user', '第二句'), node('assistant', '回复')]
    const msgs = buildPrompt(c, undefined, nodes, 20)
    const merged = msgs.filter((m) => m.content.includes('第一句'))
    expect(merged).toHaveLength(1)
    expect(merged[0].content).toContain('第一句\n\n第二句')
  })

  it('发送层正则在组装末尾统一执行：改写角色前奏中的世界书文本，但跳过 system', () => {
    const c = char({
      worldInfo: [
        { constant: true, content: '前奏密语', comment: '册', position: 'before_char' },
        { constant: true, content: '系统密语', comment: '册2', position: 'global_note' },
      ],
    })
    const opts: PromptOptions = {
      regexEnabled: true,
      regexScripts: [{ pattern: '密语', replace: 'XXXX', applyOnSend: true }],
    }
    const msgs = buildPrompt(c, undefined, chain(['u', 'a']), 20, opts)
    // 角色前奏是 user（非 system）→ 被正则改写
    expect(prelude(msgs).content).toContain('前奏XXXX')
    expect(prelude(msgs).content).not.toContain('前奏密语')
    // system 消息一律不经过正则
    expect(msgs[0].content).toContain('系统密语')
    expect(msgs[0].content).not.toContain('系统XXXX')
  })

  it('世界书扫描源是正则发送层之前的原文：正则改写历史不影响关键词命中', () => {
    const c = char({
      // 条目内容刻意不含「暗语」二字，避免被同一正则改写，专注验证扫描时机
      worldInfo: [{ keys: ['暗语'], content: '夜莺档案', comment: '暗', position: 'after_char' }],
    })
    const opts: PromptOptions = {
      regexEnabled: true,
      // 发送层把历史里的「暗语」抹掉，但扫描发生在正则之前，世界书仍应激活
      regexScripts: [{ pattern: '暗语', replace: '隐去', applyOnSend: true }],
    }
    const msgs = buildPrompt(c, undefined, chain(['他说出暗语', 'AI回复']), 20, opts)
    expect(prelude(msgs).content).toContain('夜莺档案')
    // 历史楼中的暗语已被正则改写
    expect(msgs.some((m) => m.role === 'user' && m.content.includes('他说出隐去'))).toBe(true)
  })
})

describe('@深度多条目定位（回归 R1：逐条注入口径）', () => {
  it('depth=2 与 depth=4 并存：按 order 逐条处理，先前注入条目参与后续倒数', () => {
    const c = char({
      worldInfo: [
        { keys: ['x'], content: '【深4】', comment: 'D4', position: 'at_depth', depth: 4, scanDepth: 20 },
        { keys: ['x'], content: '【深2】', comment: 'D2', position: 'at_depth', depth: 2, scanDepth: 20 },
      ],
    })
    const nodes = chain(['u1 x', 'a1', 'u2', 'a2', 'u3', 'a3'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20))
    const contents = dlg.map((m) => m.content)
    // 先注入 D2（cd=2 → 插在 a2 前）；随后 D4 在含 D2 的数组上重新倒数：
    // a3,u3,a2 消耗 3 层，D2 自身（user 角色）再消耗 1 层，停在 u2 → 插在 u2 前；
    // 三条连续 user 消息（D4、u2、D2）被末尾后处理链式合并为一条
    const iA1 = contents.findIndex((x) => x.includes('a1'))
    const iMerged = contents.findIndex((x) => x.includes('【深4】'))
    const iA2 = contents.findIndex((x) => x.includes('a2'))
    const iU3 = contents.findIndex((x) => x.includes('u3'))
    const iA3 = contents.findIndex((x) => x.includes('a3'))
    expect(iA1).toBeLessThan(iMerged)
    expect(contents[iMerged]).toContain('u2')
    expect(contents[iMerged]).toContain('【深2】')
    expect(contents[iMerged]).not.toContain('a2')
    expect(iMerged).toBeLessThan(iA2)
    expect(iA2).toBeLessThan(iU3)
    expect(iU3).toBeLessThan(iA3)
  })

  it('同 depth 的多条目各自独立成消息，组内按 order 升序（合并交给末尾后处理）', () => {
    const c = char({
      worldInfo: [
        { keys: ['x'], content: '乙条目正文', comment: 'B', position: 'at_depth', depth: 1, order: 200, scanDepth: 20 },
        { keys: ['x'], content: '甲条目正文', comment: 'A', position: 'at_depth', depth: 1, order: 10, scanDepth: 20 },
      ],
    })
    const nodes = chain(['u1 x', 'a1', 'u2', 'a2'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20))
    // A(order 10) 先插在 u2 前；B(order 200) 在含 A 的数组上倒数，同样停在 u2 前 → A、B 相邻且 A 在前；
    // A、B、u2 三条连续 user 消息随后被后处理链式合并为一条
    const iA1 = dlg.findIndex((m) => m.content.includes('a1'))
    const iMerged = dlg.findIndex((m) => m.content.includes('甲条目正文'))
    const iA2 = dlg.findIndex((m) => m.content.includes('a2'))
    expect(iMerged).toBeGreaterThan(-1)
    const mergedContent = dlg[iMerged].content
    const idxA = mergedContent.indexOf('[A]\n甲条目正文')
    const idxB = mergedContent.indexOf('[B]\n乙条目正文')
    expect(idxA).toBeGreaterThan(-1)
    expect(idxA).toBeLessThan(idxB)
    expect(mergedContent).toContain('u2')
    expect(iA1).toBeLessThan(iMerged)
    expect(iMerged).toBeLessThan(iA2)
  })
})

describe('user_top 执行顺序（回归 R2）', () => {
  it('user_top 在 @深度注入之后执行：尾部 @深度 user 注入条目会先被当作最后一条 user 消息', () => {
    const c = char({
      worldInfo: [
        { keys: ['u'], content: '用户顶注', comment: 'UT', position: 'user_top', scanDepth: 20 },
        { keys: ['u'], content: '尾插内容', comment: 'TD', position: 'at_depth', depth: 0, scanDepth: 20 },
      ],
    })
    const msgs = buildPrompt(c, undefined, chain(['u', 'a', '带u的最新发言', 'a2']), 20)
    // TD（depth=0）先插在 a2 之前 → user_top 前置到 TD；随后 TD 与真实用户楼被后处理合并
    const merged = msgs.find((m) => m.content.includes('尾插内容'))!
    expect(merged.content).toContain('带u的最新发言')
    expect(merged.content).toContain('[UT]\n用户顶注')
    expect(merged.content).toContain('[TD]\n尾插内容')
    expect(msgs[msgs.length - 1].content).toBe('a2')
  })
})

describe('UI 模板主模型同步开关（主模型纯扮演模式）', () => {
  const uiTpls = [{
    id: 't1',
    name: '面板',
    enabled: true,
    htmlTemplate: '<b>{{npc1_favor}}</b>',
    variableSchema: 'npc1_favor: 好感',
    initialVariables: { npc1_favor: 20 },
  }] as never

  it('默认（不传开关，双保险模式）：注入更新指令与变量状态上下文', () => {
    const c = char({ uiTemplates: uiTpls })
    const msgs = buildPrompt(c, undefined, chain(['u', 'a']), 20, {
      uiTemplates: uiTpls,
      uiTemplateStates: { t1: { npc1_favor: 20 } },
    })
    expect(msgs.some((m) => m.content.includes('[UI模板变量更新]'))).toBe(true)
    expect(msgs.some((m) => m.content.includes('<ui_template_state_context>'))).toBe(true)
  })

  it('uiMainModelUpdates=false：主模型不接收任何面板指令与变量状态（纯扮演）', () => {
    const c = char({ uiTemplates: uiTpls })
    const msgs = buildPrompt(c, undefined, chain(['u', 'a']), 20, {
      uiTemplates: uiTpls,
      uiTemplateStates: { t1: { npc1_favor: 20 } },
      uiMainModelUpdates: false,
    })
    expect(msgs.some((m) => m.content.includes('[UI模板变量更新]'))).toBe(false)
    expect(msgs.some((m) => m.content.includes('<ui_template_state_context>'))).toBe(false)
    expect(msgs.some((m) => m.content.includes('npc1_favor'))).toBe(false)
  })
})

describe('buildPromptTrace 来源标注（P2-16）', () => {
  it('预设/世界书/角色前奏/楼层 各有来源，trace 与 messages 一一对应', () => {
    const c = char({
      description: '描述文本',
      worldInfo: [
        { constant: true, content: '顶部档案', comment: 'ST', position: 'system_top' },
        { keys: ['魔法'], content: '前置设定', comment: '前缀册', position: 'before_char' },
      ],
    })
    const { messages, trace } = buildPromptTrace(c, undefined, chain(['我施展魔法', '艾拉点头']), 20, {
      promptEntries: [{ id: 'p1', name: '破限', role: 'system', content: '破限正文', enabled: true }],
    })
    expect(trace).toHaveLength(messages.length)
    const sys = trace[0].origins.join('|')
    expect(sys).toContain('预设·破限')
    expect(sys).toContain('世界书·系统顶部（ST）')
    const preludeIdx = messages.findIndex((m) => m.content.includes('[Character]'))
    const prelude = trace[preludeIdx].origins.join('|')
    expect(prelude).toContain('角色前奏·[Character]')
    expect(prelude).toContain('世界书·角色前（前缀册）')
    // 前奏（user）与首条用户楼合并：合并消息的 origins 同时含前奏与开场白（根节点无父 → 开场白）
    const floorIdx = messages.findIndex((m) => m.content.includes('我施展魔法'))
    expect(trace[floorIdx].origins.join('|')).toContain('开场白（我）')
  })

  it('@深度注入 / user_top / phi 的来源标注', () => {
    const c = char({
      postHistoryInstructions: '结尾遵守事项',
      worldInfo: [
        { keys: ['x'], content: '深注内容', comment: '深册', position: 'at_depth', depth: 0, scanDepth: 20 },
        { keys: ['u'], content: '顶注内容', comment: '顶册', position: 'user_top', scanDepth: 20 },
      ],
    })
    const { messages, trace } = buildPromptTrace(c, undefined, chain(['u x', 'a1']), 20)
    const depthIdx = messages.findIndex((m) => m.content.includes('深注内容'))
    expect(trace[depthIdx].origins.join('|')).toContain('@深度注入（深册，depth=0，user）')
    // user_top 在 @深度之后执行，前置到注入条目上 → 合并消息同时带两个来源
    expect(trace[depthIdx].origins.join('|')).toContain('世界书·user_top 前置（顶册）')
    const phiIdx = messages.findIndex((m) => m.content.includes('结尾遵守事项'))
    expect(trace[phiIdx].origins).toEqual(['卡 phi·post_history_instructions'])
  })

  it('连续同角色合并后 origins 顺序拼接', () => {
    const nodes = [node('assistant', '第一句'), node('assistant', '第二句'), node('user', '回应')]
    const { messages, trace } = buildPromptTrace(char(), undefined, nodes, 20)
    const mergedIdx = messages.findIndex((m) => m.content.includes('第一句'))
    expect(messages[mergedIdx].content).toContain('第二句')
    expect(trace[mergedIdx].origins).toEqual(['开场白（艾拉）', '开场白（艾拉）'])
  })
})

describe('整页面板托管（副模型接管 AI 自画面板）', () => {
  const panel = '<!DOCTYPE html>\n<html><head><style>.p{color:red}</style></head><body><div>金库 <b>5000</b> 金币</div><script>var x=1;</script></body></html>'

  it('激活时：整页 HTML 楼层以纯文本摘要发送，注入 Policy 与状态摘要，来源带托管标注', () => {
    const c = char()
    const nodes = chain(['用户提问', panel, '继续剧情'])
    const { messages, trace } = buildPromptTrace(c, undefined, nodes, 20, {
      aiPanelTakeover: true,
      aiPanelDigest: '金库 5000 金币',
    })
    const sys = messages[0].content
    expect(sys).toContain('[UI Panel Policy]')
    expect(sys).toContain('严禁输出 <!DOCTYPE html>/<html> 整页文档')
    expect(sys).toContain('【UI 面板当前状态】\n金库 5000 金币')
    // 面板楼层 → 摘要：保留事实文本，剥掉标签/脚本，不再整段进上下文
    const panelIdx = messages.findIndex((m) => m.role === 'assistant' && m.content.includes('金库'))
    expect(panelIdx).toBeGreaterThan(-1)
    expect(messages[panelIdx].content).not.toContain('<div')
    expect(messages[panelIdx].content).not.toContain('var x=1')
    expect(messages[panelIdx].content).toContain('金库 5000 金币')
    expect(trace[panelIdx].origins.join('|')).toContain('托管面板摘要')
    // 普通楼层不受影响
    expect(messages.some((m) => m.content === '继续剧情')).toBe(true)
  })

  it('未激活时：整页 HTML 楼层原样透传，不注入 Policy', () => {
    const c = char()
    const { messages, trace } = buildPromptTrace(c, undefined, chain(['用户提问', panel, '继续剧情']), 20)
    expect(messages[0].content).not.toContain('[UI Panel Policy]')
    const panelIdx = messages.findIndex((m) => m.role === 'assistant' && m.content.includes('DOCTYPE'))
    expect(panelIdx).toBeGreaterThan(-1)
    expect(messages[panelIdx].content).toContain('<div>金库')
    expect(trace[panelIdx].origins.join('|')).not.toContain('托管面板摘要')
  })

  it('开启但无状态摘要时不注入【UI 面板当前状态】块', () => {
    const c = char()
    const sys = buildPrompt(c, undefined, chain(['u', 'a']), 20, { aiPanelTakeover: true })[0].content
    expect(sys).toContain('[UI Panel Policy]')
    expect(sys).not.toContain('【UI 面板当前状态】')
  })
})

describe('向量记忆注入（XML 分片格式）', () => {
  it('chunk 记忆按 memory_fragment XML 注入，summary 记忆维持原样式', () => {
    const c = char()
    const nodes = chain(['用户提问', '艾拉回应'])
    const opts: PromptOptions = {
      memories: [
        {
          id: 'v1', sessionId: 's', summary: '用户：我捡了 100 金币\n角色卡：艾拉收好',
          paragraph: '用户：我捡了 100 金币\n角色卡：艾拉收好',
          turn: 3, kind: 'chunk', enabled: true, classicMemory: true, source: 'ai', createdAt: 1,
          vectorScore: 0.834,
        },
        {
          id: 's1', sessionId: 's', summary: '主角与艾拉立约买药水',
          enabled: true, classicMemory: true, source: 'ai', createdAt: 2,
        },
      ],
    }
    const sys = buildPrompt(c, undefined, nodes, 20, opts)[0].content
    // XML 块
    expect(sys).toContain('<role_memory_vector_recall>')
    expect(sys).toContain('以下内容是从往期对话记录中按当前输入检索出的相关记忆分片，并非全部历史。')
    expect(sys).toContain('<memory_fragment turn="3" similarity="83.4%">')
    expect(sys).toContain('用户：我捡了 100 金币')
    expect(sys).toContain('</role_memory_vector_recall>')
    // summary 记忆维持原样式
    expect(sys).toContain('【此前剧情记忆】\n主角与艾拉立约买药水')
    // chunk 不再走【此前剧情记忆】
    expect(sys).not.toContain('【此前剧情记忆】\n用户：我捡了 100 金币')
  })
})
