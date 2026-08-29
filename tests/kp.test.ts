import { describe, expect, it } from 'vitest'
import {
  buildKpMessages,
  buildRollNudge,
  extractRollRequests,
  stripRollRequests,
} from '../src/lib/hall/kp'
import type { MemberInfo, RoomEvent } from '../src/lib/hall/protocol'

const members: MemberInfo[] = [
  { peerId: 'h', name: '团长', role: 'host', charName: '沈青', persona: '老练的驱魔人' },
  { peerId: 'p1', name: '小明', role: 'player', charName: '林小满', persona: '好奇心过剩的学生' },
]

function ev(partial: Record<string, unknown>): RoomEvent {
  return { id: 'e', at: 1, ...partial } as RoomEvent
}

describe('extractRollRequests', () => {
  it('提取检定请求：表达式 + 检定名', () => {
    const text = '你贴上墙壁聆听。<roll>1d100 侦查</roll>……'
    expect(extractRollRequests(text)).toEqual([{ expr: '1d100', label: '侦查' }])
  })

  it('无空格时整段作为表达式；多请求全提取', () => {
    expect(extractRollRequests('<roll>2d6</roll>和<roll>1d4+1 力量</roll>')).toEqual([
      { expr: '2d6', label: '' },
      { expr: '1d4+1', label: '力量' },
    ])
    expect(extractRollRequests('没有检定')).toEqual([])
  })

  it('stripRollRequests 移除标记', () => {
    expect(stripRollRequests('前文<roll>1d100 侦查</roll>后文')).toBe('前文后文')
  })
})

describe('buildKpMessages', () => {
  it('system 含规则与玩家名单，user 含近期剧情', () => {
    const events: RoomEvent[] = [
      ev({ k: 'system', text: '小明 加入了房间' }),
      ev({ k: 'narration', text: '暴雨夜的宅邸门前。' }),
      ev({ k: 'chat', from: 'p1', name: '小明', charName: '林小满', text: '我敲门。' }),
    ]
    const msgs = buildKpMessages({ events, members })
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('跑团主持人')
    expect(msgs[0].content).toContain('林小满')
    expect(msgs[0].content).toContain('好奇心过剩的学生')
    expect(msgs[1].role).toBe('user')
    expect(msgs[1].content).toContain('【旁白】暴雨夜的宅邸门前。')
    expect(msgs[1].content).toContain('【玩家】林小满：我敲门。')
    expect(msgs[1].content).not.toContain('加入了房间') // system 事件在末段被过滤后不进剧情
  })

  it('maxEvents 截断只保留最近剧情', () => {
    const events = Array.from({ length: 10 }, (_, i) => ev({ k: 'narration', text: `第${i}幕` }))
    const msgs = buildKpMessages({ events, members: [], maxEvents: 3 })
    expect(msgs[1].content).toContain('第9幕')
    expect(msgs[1].content).not.toContain('第0幕')
  })

  it('空剧情给 KP 开场引导', () => {
    const msgs = buildKpMessages({ events: [], members })
    expect(msgs[1].content).toContain('开场')
  })
})

describe('buildRollNudge', () => {
  it('把检定结果拼成续写指令', () => {
    const m = buildRollNudge([{ label: '侦查', detail: '1d100[55] = 55' }])
    expect(m.role).toBe('user')
    expect(m.content).toContain('侦查：1d100[55] = 55')
  })
})
