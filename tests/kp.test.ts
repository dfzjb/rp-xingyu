import { describe, expect, it } from 'vitest'
import {
  buildKpMessages,
  buildRollNudge,
  extractRollRequests,
  lineOf,
  renderSceneBlock,
  renderSettingBlock,
  stripRollRequests,
} from '../src/lib/hall/kp'
import { emptySetting, isEmptySetting, systemLabel, type RoomSetting } from '../src/lib/hall/rules'
import { PARTY_LINE, type HallScene, type MemberInfo, type RoomEvent } from '../src/lib/hall/protocol'

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

describe('分线', () => {
  const scenes: HallScene[] = [
    { id: 's1', name: '王五的个人线', member: '王五', closed: false },
    { id: 's2', name: '图书馆二人组', member: '', closed: true },
  ]
  const events: RoomEvent[] = [
    ev({ k: 'chat', from: 'p1', name: '小明', charName: '林小满', text: '我在酒馆打听。' }),
    ev({ k: 'narration', text: '旁白（全体线）。' }),
    ev({ k: 'chat', from: 'p2', name: '王五', charName: '王五', text: '我独自去码头。', scene: 's1' }),
    ev({ k: 'system', text: '某人 加入了房间' }),
  ]

  it('lineOf：无 scene 字段 = 全体主线（老事件兼容）', () => {
    expect(lineOf(events[0])).toBe(PARTY_LINE)
    expect(lineOf(events[2])).toBe('s1')
  })

  it('renderSceneBlock：全体 + 各线绑定成员与最近发言角色，收线标注', () => {
    const block = renderSceneBlock(scenes, events)
    expect(block).toContain('【分线动向】')
    expect(block).toContain('- 全体（主线）：林小满')
    expect(block).toContain('- 王五的个人线：王五')
    expect(block).toContain('- 图书馆二人组（已收线）：（还没有动静）')
  })

  it('只有全体线时不产出动向块', () => {
    expect(renderSceneBlock([], events)).toBe('')
  })

  it('buildKpMessages：自定义线注入当前叙事线，剧情只喂本线（由调用方过滤），空线给开线引导', () => {
    const msgs = buildKpMessages({
      events: events.filter((e) => lineOf(e) === 's1'),
      members,
      scene: '王五的个人线',
      sceneBlock: renderSceneBlock(scenes, events),
    })
    expect(msgs[0].content).toContain('当前叙事线：王五的个人线')
    expect(msgs[0].content).toContain('【分线动向】')
    expect(msgs[0].content).toContain('只叙事一条线')
    expect(msgs[1].content).toContain('当前叙事线：「王五的个人线」')
    expect(msgs[1].content).toContain('我独自去码头')
    expect(msgs[1].content).not.toContain('我在酒馆打听') // 别的线不进上下文
  })

  it('buildKpMessages：空的自定义线给开线引导（与开局引导区分）', () => {
    const msgs = buildKpMessages({ events: [], members: [], scene: '王五的个人线' })
    expect(msgs[1].content).toContain('「王五的个人线」这条线还没有动静')
    expect(msgs[1].content).not.toContain('请以一段开场旁白引入')
  })

  it('buildKpMessages：全体线保持原行为（无叙事线注入）', () => {
    const msgs = buildKpMessages({ events, members })
    expect(msgs[0].content).not.toContain('当前叙事线')
    expect(msgs[1].content).toContain('【玩家】林小满：我在酒馆打听。')
  })
})

describe('开团设定注入', () => {
  const setting: RoomSetting = {
    ...emptySetting(),
    system: 'coc7',
    era: '1920s 美国·阿卡姆',
    tones: ['恐怖悬疑', '克苏鲁神话'],
    players: 4,
    world: '雾镇米斯卡塔尼克，大学城表面平静。',
    module: '图书馆下埋着旧日支配者的石板。',
    opening: '暴雨夜，你们在图书馆门口躲雨。',
    npcs: '馆长 埃利奥特（学者：知道石板的下落）',
    houseRules: '大失败可花幸运重骰一次\n理智归零不即死改为濒疯',
    redlines: '回避虐待、儿童伤害\n不描写生理细节',
    kpStyle: 'narrative',
    sceneNotes: '图书馆一层阅览室，地下书库经Staff通道进入。',
  }

  it('renderSettingBlock 渲染规则约定与各设定字段', () => {
    const block = renderSettingBlock(setting)
    expect(block).toContain('【开团设定】')
    expect(block).toContain('COC 第七版')
    expect(block).toContain('<roll>1d100 技能名</roll>')
    expect(block).toContain('时代背景：1920s 美国·阿卡姆')
    expect(block).toContain('恐怖悬疑、克苏鲁神话')
    expect(block).toContain('预期玩家：4 人')
    expect(block).toContain('雾镇米斯卡塔尼克')
    expect(block).toContain('不要提前剧透')
    expect(block).toContain('开场场景：暴雨夜')
    expect(block).toContain('馆长 埃利奥特')
    expect(block).toContain('房规（优先级高于默认规则）')
    expect(block).toContain('大失败可花幸运重骰一次')
    expect(block).toContain('理智归零不即死改为濒疯')
    expect(block).toContain('内容红线（绝不在正文中出现的描写）')
    expect(block).toContain('回避虐待、儿童伤害')
    expect(block).toContain('不描写生理细节')
    expect(block).toContain('多用 NPC 台词') // narrative 风格提示
    expect(block).toContain('场景/地图备注')
  })

  it('空字段不渲染，custom 规则输出自定义名', () => {
    const block = renderSettingBlock({ ...emptySetting(), system: 'custom', systemCustom: '野火 GR' })
    expect(block).toContain('野火 GR')
    expect(block).not.toContain('时代背景')
    expect(block).not.toContain('关键 NPC')
  })

  it('buildKpMessages 注入设定块并用开场场景引导开局', () => {
    const msgs = buildKpMessages({ events: [], members, setting })
    expect(msgs[0].content).toContain('【开团设定】')
    expect(msgs[1].content).toContain('开场场景为起点')
    // 有设定时不再用通用开场引导
    expect(msgs[1].content).not.toContain('请以一段开场旁白引入')
  })

  it('无设定时保持原行为（不出现设定块）', () => {
    const msgs = buildKpMessages({ events: [], members })
    expect(msgs[0].content).not.toContain('【开团设定】')
    expect(msgs[1].content).toContain('请以一段开场旁白引入')
  })

  it('isEmptySetting：默认值判空，任一字段有值判非空', () => {
    expect(isEmptySetting(emptySetting())).toBe(true)
    expect(isEmptySetting({ ...emptySetting(), world: '有内容' })).toBe(false)
    expect(isEmptySetting({ ...emptySetting(), tones: ['欢乐日常'] })).toBe(false)
    expect(isEmptySetting({ ...emptySetting(), system: 'dnd5' })).toBe(false)
  })

  it('systemLabel：预设取主名，custom 取自定义名', () => {
    expect(systemLabel({ ...emptySetting(), system: 'coc7' })).toBe('COC7th')
    expect(systemLabel({ ...emptySetting(), system: 'custom', systemCustom: '野火 GR' })).toBe('野火 GR')
    expect(systemLabel(null)).toBe('')
  })
})
