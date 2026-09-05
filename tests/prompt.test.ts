import { describe, expect, it } from 'vitest'
import { buildPrompt, type ApiMessage, type PromptOptions } from '../src/lib/prompt'
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

describe('@深度世界书真实插入（回归 W3，旧版 countdown<0 口径）', () => {
  it('depth=2：插在倒数第 3 条对话消息之前（注入点之后还有 depth+1 条）', () => {
    const c = char({
      worldInfo: [{ keys: ['钥匙'], content: '【深度插入】', position: 'at_depth', depth: 2, depthRole: 'system', scanDepth: 20 }],
    })
    const nodes = chain(['u1', 'a1 钥匙', 'u2', 'a2', 'u3', 'a3'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20))
    const contents = dlg.map((m) => m.content)
    // 旧版口径：cd=2 从末尾数 a3,u3,a2 三条，减至 -1 停在 a2 → 插在 a2 之前
    const idxA2 = contents.findIndex((x) => x.includes('a2'))
    const idxU2 = contents.findIndex((x) => x.includes('u2'))
    const idxWI = contents.findIndex((x) => x.includes('【深度插入】'))
    expect(idxU2).toBeLessThan(idxWI)
    expect(idxWI).toBeLessThan(idxA2)
    // 显式 depthRole=system 时以 system 消息插入
    expect(dlg[idxWI].role).toBe('system')
    expect(dlg[idxWI].content.startsWith('[Entry]')).toBe(true)
  })

  it('depth=0：插在最后一条对话楼层之前（旧版 countdown<0 口径），缺省角色为 user，无条目名时包 [Entry]', () => {
    const c = char({
      worldInfo: [{ keys: ['x'], content: '【尾插】', position: 'at_depth', depth: 0, scanDepth: 20 }],
    })
    const nodes = chain(['u1-x', 'a1', 'u2', 'a2'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20))
    // cd=0 在遇到末条 user/assistant（a2）时减至 -1 → 插在 a2 之前；
    // 注入条目为 user 角色，被末尾统一后处理与前一条 user 楼合并（旧版 5707 同款）
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

describe('正则默认不污染发给模型的 prompt（对齐旧版 processRegex）', () => {
  it('未勾「发送层」的正则只做显示美化，历史原文进 prompt', () => {
    const opts: PromptOptions = {
      regexEnabled: true,
      // 内部形状缺省 applyOnSend=false；ST/旧版导入缺省也只显示
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

describe('对齐旧版：指令先行 + 角色前奏（修复思考模型先分析世界书/正则再扮演）', () => {
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
    // 固定注入旧版 [Style Priority] 原文（不含任何自加的"勿分析"句）
    expect(msgs[0].content).toContain('[Style Priority]')
    expect(msgs[0].content).toContain('最终回复的文风必须优先遵守上方系统预设中的规定文风。')
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

describe('第二轮严格对齐旧版', () => {
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

  it('system_top/global_note 世界书进 system（破限之后、其他预设之前）', () => {
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
    expect(sys.indexOf('破限正文')).toBeLessThan(sys.indexOf('顶部档案'))
    expect(sys.indexOf('全局注释')).toBeLessThan(sys.indexOf('[System Presets]'))
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
    // system 消息一律不经过正则（旧版 processRegex 首行 system return）
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

describe('@深度多条目定位（回归 R1：逐字对齐旧版逐条注入口径）', () => {
  it('depth=2 与 depth=4 并存：按 order 逐条处理，先前注入条目参与后续倒数（旧版行为）', () => {
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
    // 三条连续 user 消息（D4、u2、D2）被旧版 5707 式后处理链式合并为一条
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

describe('user_top 执行顺序（回归 R2：与旧版 5669-5680 逐字一致）', () => {
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
