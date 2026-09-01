import { describe, expect, it } from 'vitest'
import {
  MAX_ITEMS,
  MAX_MEMORIES,
  emptyGameState,
  isEmptyGameState,
  mergeStateUpdate,
  normalizeGameState,
  sameGameState,
} from '../src/lib/hall/gamestate'
import { buildKpMessages, extractStateUpdate, renderStateBlock, stripKpMarkup, stripStateBlocks } from '../src/lib/hall/kp'

describe('extractStateUpdate / stripStateBlocks', () => {
  it('解析 KP 的 <state> JSON：区域/道具/移除/记忆', () => {
    const text = '你们推门走进书库。<state>{"area":"地下书库","add":[{"name":"铜钥匙","note":"馆长给的"}],"remove":["旧地图"],"mem":["石板埋在书库下"]}</state>'
    expect(extractStateUpdate(text)).toEqual({
      area: '地下书库',
      add: [{ name: '铜钥匙', note: '馆长给的' }],
      remove: ['旧地图'],
      mem: ['石板埋在书库下'],
    })
    expect(stripStateBlocks(text)).toBe('你们推门走进书库。')
    expect(stripKpMarkup(text)).toBe('你们推门走进书库。')
  })

  it('多个标记取最后一个；坏 JSON 返回 null', () => {
    const text = '<state>{"area":"酒馆"}</state>中间的话<state>{"area":"码头"}</state>'
    expect(extractStateUpdate(text)?.area).toBe('码头')
    expect(extractStateUpdate('没有标记')).toBeNull()
    expect(extractStateUpdate('<state>{oops</state>')).toBeNull()
  })

  it('容忍 markdown 围栏、add 字符串简写、缺字段', () => {
    const fenced = '<state>```json\n{"area":"酒馆"}\n```</state>'
    expect(extractStateUpdate(fenced)?.area).toBe('酒馆')
    expect(extractStateUpdate('<state>{"add":["火把"]}</state>')?.add).toEqual([{ name: '火把', note: '' }])
    expect(extractStateUpdate('<state>{}</state>')).toEqual({ area: undefined, add: [], remove: [], mem: [] })
  })

  it('stripKpMarkup 同时剥掉检定与战局标记', () => {
    expect(stripKpMarkup('前<roll>1d100 侦查</roll>中<state>{"area":"x"}</state>后')).toBe('前中后')
  })
})

describe('mergeStateUpdate', () => {
  it('地点取新值；道具按名去重（重名更新备注）；记忆按文本去重', () => {
    const base = normalizeGameState({
      area: '酒馆',
      items: [{ id: 'a', name: '旧地图', note: '' }],
      memories: [{ id: 'm1', text: '老磨坊的传闻', at: 1 }],
      updatedAt: 1,
    })
    const next = mergeStateUpdate(base, {
      area: '老磨坊',
      add: [{ name: '旧地图', note: '标记了密道' }, { name: '煤油灯', note: '' }],
      mem: ['老磨坊的传闻', '磨坊主是共犯'],
    })
    expect(next.area).toBe('老磨坊')
    expect(next.items).toHaveLength(2)
    expect(next.items.find((x) => x.name === '旧地图')?.note).toBe('标记了密道')
    expect(next.memories.map((m) => m.text)).toEqual(['老磨坊的传闻', '磨坊主是共犯'])
    expect(base.items).toHaveLength(1) // 入参不被改动
  })

  it('不传 area 保持原值；remove 按名移除', () => {
    let s = mergeStateUpdate(null, { area: '酒馆', add: [{ name: '火把', note: '' }, { name: '绳子', note: '' }] })
    s = mergeStateUpdate(s, { add: [{ name: '煤油灯', note: '' }], remove: ['火把'] })
    expect(s.area).toBe('酒馆')
    expect(s.items.map((x) => x.name)).toEqual(['绳子', '煤油灯'])
  })

  it('超上限丢最旧', () => {
    let s = emptyGameState()
    for (let i = 0; i < MAX_MEMORIES + 3; i++) s = mergeStateUpdate(s, { mem: [`记忆${i}`] })
    expect(s.memories).toHaveLength(MAX_MEMORIES)
    expect(s.memories[0].text).toBe('记忆3')
    for (let i = 0; i < MAX_ITEMS + 2; i++) s = mergeStateUpdate(s, { add: [{ name: `道具${i}`, note: '' }] })
    expect(s.items).toHaveLength(MAX_ITEMS)
    expect(s.items[0].name).toBe('道具2')
  })
})

describe('normalizeGameState / sameGameState', () => {
  it('垃圾输入归一为空状态并补 id；忽略 updatedAt 的实质比较', () => {
    const s = normalizeGameState('oops')
    expect(s.area).toBe('')
    expect(s.items).toEqual([])
    expect(s.memories).toEqual([])
    expect(isEmptyGameState(s)).toBe(true)

    const dirty = normalizeGameState({ area: 'x'.repeat(99), items: ['垃圾', { name: '钥匙', note: 42 }], memories: [{ text: '线索' }] })
    expect(dirty.area).toHaveLength(60)
    expect(dirty.items).toEqual([{ id: expect.any(String), name: '钥匙', note: '42' }])
    expect(dirty.memories[0].id).toBeTruthy()

    expect(sameGameState({ ...emptyGameState(), updatedAt: 1 }, emptyGameState())).toBe(true)
    expect(sameGameState({ ...emptyGameState(), area: '酒馆' }, emptyGameState())).toBe(false)
    expect(sameGameState(null, emptyGameState())).toBe(true)
  })
})

describe('战局状态注入 KP 提示词', () => {
  const gs = normalizeGameState({
    area: '地下书库',
    items: [{ name: '煤油灯', note: '还剩半壶油' }, { name: '铜钥匙', note: '' }],
    memories: [{ text: '石板埋在书库下' }, { text: '馆长知道入口' }],
  })

  it('renderStateBlock 渲染区域/道具/记忆；buildKpMessages 注入 system', () => {
    const block = renderStateBlock(gs)
    expect(block).toContain('【战局状态】')
    expect(block).toContain('当前区域：地下书库')
    expect(block).toContain('煤油灯（还剩半壶油）')
    expect(block).toContain('铜钥匙')
    expect(block).toContain('1. 石板埋在书库下')

    const msgs = buildKpMessages({ events: [], members: [], state: gs })
    expect(msgs[0].content).toContain('【战局状态】')
    expect(msgs[0].content).toContain('战局状态（当前区域/随身道具/关键记忆）由系统为你持久化') // 维护约定进 system
  })

  it('空状态不注入状态块', () => {
    const msgs = buildKpMessages({ events: [], members: [], state: emptyGameState() })
    expect(msgs[0].content).not.toContain('【战局状态】')
    const msgs2 = buildKpMessages({ events: [], members: [] })
    expect(msgs2[0].content).not.toContain('【战局状态】')
  })
})
