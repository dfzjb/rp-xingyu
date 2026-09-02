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

describe('世界书扫描源（回归 W1：AI 回复同样参与关键词命中）', () => {
  it('关键词只出现在 AI 消息中也能激活', () => {
    const c = char({
      worldInfo: [{ keys: ['暗语'], content: '暗语设定：夜莺', position: 'after_char' }],
    })
    const nodes = chain(['你好', '他低声说出暗语便离开了'])
    const msgs = buildPrompt(c, undefined, nodes, 20)
    const sys = msgs.find((m) => m.role === 'system')!
    expect(sys.content).toContain('暗语设定：夜莺')
  })

  it('scanDepth 按楼层（user+assistant）计数', () => {
    const c = char({
      worldInfo: [{ keys: ['古龙'], content: '古龙设定', position: 'after_char', scanDepth: 2 }],
    })
    // 4 楼：古龙出现在倒数第 3 楼，scanDepth=2 不应命中
    const miss = buildPrompt(c, undefined, chain(['古龙现身', '它飞走了', '后来呢', '什么都没有']), 20)
    expect(miss.find((m) => m.role === 'system')!.content).not.toContain('古龙设定')
    // 古龙在倒数第 2 楼 → 命中
    const hit = buildPrompt(c, undefined, chain(['无关', '无关', '古龙现身', '它飞走了']), 20)
    expect(hit.find((m) => m.role === 'system')!.content).toContain('古龙设定')
  })
})

describe('@深度世界书真实插入（回归 W3）', () => {
  it('depth=2：插在倒数第 2 个对话楼层之后，而非消息尾部', () => {
    const c = char({
      worldInfo: [{ keys: ['钥匙'], content: '【深度插入】', position: 'at_depth', depth: 2, depthRole: 'system', scanDepth: 20 }],
    })
    const nodes = chain(['u1', 'a1 钥匙', 'u2', 'a2', 'u3', 'a3'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20))
    const contents = dlg.map((m) => m.content)
    // 倒数第 2 楼 = a2（序列 u1 a1 u2 a2 u3 a3，倒数：a3=0,u3=1,a2=2）
    const idxA2 = contents.indexOf('a2')
    const idxU3 = contents.indexOf('u3')
    const idxWI = contents.indexOf('【深度插入】')
    expect(idxA2).toBeLessThan(idxWI)
    expect(idxWI).toBeLessThan(idxU3)
  })

  it('depth=0：插在最新楼层之后（尾部）', () => {
    const c = char({
      worldInfo: [{ keys: ['x'], content: '【尾插】', position: 'at_depth', depth: 0, depthRole: 'user', scanDepth: 20 }],
    })
    const nodes = chain(['u1-x', 'a1', 'u2', 'a2'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20))
    expect(dlg[dlg.length - 1]).toMatchObject({ role: 'user', content: '【尾插】' })
  })
})

describe('发送层正则 depth 定向（回归 R2）', () => {
  const opts: PromptOptions = {
    regexEnabled: true,
    regexScripts: [{ pattern: '目标', replace: '命中', minDepth: 0, maxDepth: 0 }],
  }
  it('只改最新楼（depth=0），更早楼层保持原样', () => {
    const c = char()
    const nodes = chain(['早期目标', '早期回复', '近期', '最新目标'])
    const dlg = dialogue(buildPrompt(c, undefined, nodes, 20, opts))
    expect(dlg.find((m) => m.content === '早期目标')).toBeTruthy()
    expect(dlg.find((m) => m.content === '最新命中')).toBeTruthy()
  })
})
