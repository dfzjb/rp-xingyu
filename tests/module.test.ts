import { describe, expect, it } from 'vitest'
import {
  MAX_ENDINGS,
  MAX_FLAGS,
  emptyProgress,
  extractModuleUpdate,
  isEmptyProgress,
  mergeProgressUpdate,
  normalizeModule,
  normalizeProgress,
  pickWeighted,
  renderModuleBlock,
} from '../src/lib/hall/module'
import { buildKpMessages, renderSettingBlock } from '../src/lib/hall/kp'
import { mergeStateUpdate, normalizeGameState, emptyGameState, isEmptyGameState } from '../src/lib/hall/gamestate'
import { emptySetting } from '../src/lib/hall/rules'

const VALID_MODULE = {
  id: 'm1',
  name: '雾镇迷局',
  synopsis: '外来者抵达终年起雾的镇子，揭开祭典背后的失踪案。',
  chapters: [
    { id: 'c1', title: '抵达', summary: '雾夜入镇，客栈听见怪谈', goal: '收集三条线索' },
    { title: '祭典之夜', summary: '祭典当天失踪案重演', goal: '' },
  ],
  routes: [
    { id: 'r1', name: '调查员线', entry: '出身抽到外来者', summary: '与镇警合作，正面对抗教团' },
    { name: '教团线', entry: '出身抽到教团后裔', summary: '潜入内部，从内部瓦解' },
  ],
  endings: [
    { id: 'e1', name: '迷雾散尽', kind: 'good', condition: '终章前集齐三信物', epilogue: '雾散，镇子迎来晨光' },
    { id: 'e2', name: '成为新的雾', kind: 'bad', condition: '祭典之夜战败', epilogue: '' },
  ],
  tables: [
    {
      id: 't1',
      name: '出身转盘',
      usage: 'create',
      entries: [
        { label: '外来者', weight: 3, note: '自带外界线索' },
        { label: '镇民', weight: 5, note: '熟悉地形' },
        { label: '教团后裔', weight: 2, note: '可走隐藏路线' },
      ],
    },
  ],
  createdAt: 1,
  updatedAt: 1,
}

describe('normalizeModule', () => {
  it('保留合法字段；缺 id 自动补齐；缺 usage 归为通用', () => {
    const m = normalizeModule(VALID_MODULE)!
    expect(m).not.toBeNull()
    expect(m.name).toBe('雾镇迷局')
    expect(m.chapters.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(m.routes[1].id).toBe('r2')
    expect(m.tables[0].entries.map((e) => e.label)).toEqual(['外来者', '镇民', '教团后裔'])
  })

  it('垃圾输入返回 null；无名但有条目时补默认名', () => {
    expect(normalizeModule('oops')).toBeNull()
    expect(normalizeModule({})).toBeNull()
    const m = normalizeModule({ chapters: [{ title: '第一章', summary: 'x', goal: '' }] })!
    expect(m.name).toBe('未命名模组')
    expect(m.chapters[0].id).toBe('c1')
  })

  it('超长截断、非法权重回退 1、无条目/无名字的表被剔除', () => {
    const m = normalizeModule({
      name: 'x'.repeat(99),
      endings: Array.from({ length: MAX_ENDINGS + 4 }, (_, i) => ({ title: `结局${i}`, name: `结局${i}`, kind: 'hidden' })),
      tables: [
        { name: '空表', usage: 'no', entries: [] },
        { name: '烂权重', usage: 'action', entries: [{ label: 'a', weight: -5, note: 'ok' }, { label: '', weight: 9 }] },
      ],
    })!
    expect(m.name).toHaveLength(60)
    expect(m.endings).toHaveLength(MAX_ENDINGS)
    expect(m.endings[0].kind).toBe('normal') // 非法 kind 归普通结局
    expect(m.tables).toHaveLength(1)
    expect(m.tables[0].entries[0].weight).toBe(1)
  })
})

describe('normalizeProgress / isEmptyProgress', () => {
  it('垃圾输入归一为空进度；旗标去重截断', () => {
    const p = normalizeProgress('oops')
    expect(p).toEqual(emptyProgress())
    expect(isEmptyProgress(p)).toBe(true)

    const dirty = normalizeProgress({ chapterId: 'c1', day: -3, routeId: 'r1', flags: ['黑闪', '黑闪', 'x'.repeat(99)], ended: 1, endingId: 'e1' })
    expect(dirty.day).toBe(0)
    expect(dirty.flags).toEqual(['黑闪', 'x'.repeat(40)])
    expect(dirty.ended).toBe(true)
    expect(isEmptyProgress(dirty)).toBe(false)
  })

  it('旗标超上限丢最旧', () => {
    const p = normalizeProgress({ flags: Array.from({ length: MAX_FLAGS + 2 }, (_, i) => `旗${i}`) })
    expect(p.flags).toHaveLength(MAX_FLAGS)
    expect(p.flags[0]).toBe('旗2')
  })
})

describe('mergeProgressUpdate', () => {
  it('章节/天数/路线取绝对值；旗标增删去重；入参不被改动', () => {
    const base = normalizeProgress({ chapterId: 'c1', day: 3, routeId: '', flags: ['入场'] })
    const next = mergeProgressUpdate(base, { chapter: 'c2', day: 12, route: 'r1', addFlags: ['黑闪', '入场'], removeFlags: [] })
    expect(next.chapterId).toBe('c2')
    expect(next.day).toBe(12)
    expect(next.routeId).toBe('r1')
    expect(next.flags).toEqual(['入场', '黑闪'])
    expect(base.day).toBe(3) // 入参不变
  })

  it('ending 非空即锁定终局；空字段保持原值', () => {
    const next = mergeProgressUpdate(normalizeProgress({ chapterId: 'c3', day: 40 }), { ending: 'e2' })
    expect(next.ended).toBe(true)
    expect(next.endingId).toBe('e2')
    expect(next.chapterId).toBe('c3')
    expect(mergeProgressUpdate(null, {}).ended).toBe(false)
  })

  it('removeFlags 生效；天数四舍五入非负', () => {
    const next = mergeProgressUpdate(normalizeProgress({ flags: ['a', 'b'], day: 4 }), { removeFlags: ['a'], day: 5.7 })
    expect(next.flags).toEqual(['b'])
    expect(next.day).toBe(6)
  })
})

describe('extractModuleUpdate', () => {
  it('解析 <module> JSON：章节/天数/路线/旗标数组', () => {
    const text = '雾更浓了。<module>{"chapter":"c2","day":12,"route":"r1","addFlags":["拿到信物"]}</module>'
    expect(extractModuleUpdate(text)).toEqual({
      chapter: 'c2',
      day: 12,
      route: 'r1',
      addFlags: ['拿到信物'],
      removeFlags: [],
      ending: undefined,
    })
  })

  it('多个标记取最后一个；容忍围栏；字符串旗标按分隔符拆', () => {
    const text = '<module>{"chapter":"c1"}</module>中段<module>```json\n{"addFlags":"黑闪、反转术式"}\n```</module>'
    expect(extractModuleUpdate(text)?.addFlags).toEqual(['黑闪', '反转术式'])
    expect(extractModuleUpdate('<module>{oops</module>')).toBeNull()
    expect(extractModuleUpdate('没有标记')).toBeNull()
  })

  it('空上报与无标记一样返回 null', () => {
    expect(extractModuleUpdate('<module>{}</module>')).toBeNull()
    expect(extractModuleUpdate('<module>{"chapter":""}</module>')).toBeNull()
  })
})

describe('pickWeighted', () => {
  const entries = [
    { label: 'a', weight: 0 },
    { label: 'b', weight: 7 },
    { label: 'c', weight: 3 },
  ]

  it('按权重边界确定性抽取（注入 rng）；零权重项在有权重时不会被抽中', () => {
    expect(pickWeighted(entries, () => 0.99)?.label).toBe('c') // r=9.9 落在 c（b 占 [0,0.7)，c 占 [0.7,1)）
    expect(pickWeighted(entries, () => 0.69)?.label).toBe('b') // r=6.9 落在 b
    expect(pickWeighted(entries, () => 0.05)?.label).toBe('b') // r=0.5 越过零权重的 a 落在 b
  })

  it('全 0 权重退化为等概率；空表返回 null', () => {
    const zero = entries.map((e) => ({ ...e, weight: 0 }))
    expect(pickWeighted(zero, () => 0.5)?.label).toBe('b')
    expect(pickWeighted([], () => 0.5)).toBeNull()
  })
})

describe('renderModuleBlock / KP 注入', () => {
  const m = normalizeModule(VALID_MODULE)!
  const progress = normalizeProgress({ chapterId: 'c1', day: 2, routeId: 'r1', flags: ['拿到信物'] })

  it('渲染大纲/章节/路线/结局/出身转盘/当前进度与不剧透指令', () => {
    const block = renderModuleBlock(m, progress)
    expect(block).toContain('【剧情模组：雾镇迷局】')
    expect(block).toContain('不要提前剧透')
    expect(block).toContain('大致剧情：外来者抵达终年起雾的镇子')
    expect(block).toContain('[c1] 抵达（当前章节）')
    expect(block).toContain('[r1] 调查员线（当前路线）')
    expect(block).toContain('[e1] 迷雾散尽（好结局）')
    expect(block).toContain('出身转盘')
    expect(block).toContain('当前章节：抵达 | 时间线：第 2 天 | 当前路线：调查员线 | 关键旗标：拿到信物')
    expect(block).toContain('<module>')
  })

  it('无进度/无模组时的降级：不注入模组块', () => {
    expect(renderModuleBlock(m).split('\n').some((l) => l.includes('当前进度'))).toBe(false)
    const msgs = buildKpMessages({ events: [], members: [], module: m })
    expect(msgs[0].content).toContain('【剧情模组：雾镇迷局】')
    const noModule = buildKpMessages({ events: [], members: [] })
    expect(noModule[0].content).not.toContain('剧情模组')
  })

  it('KP 能从剧情流读到转盘结果；设定块照常注入', () => {
    const wheel = {
      k: 'wheel' as const, id: 'w1', name: '阿明', charName: '雾泽',
      tableId: 't1', tableName: '出身转盘', label: '教团后裔', note: '可走隐藏路线', at: 1,
    }
    const msgs = buildKpMessages({ events: [wheel], members: [], module: m, setting: { ...emptySetting(), era: '1930s 民国' } })
    expect(msgs[1].content).toContain('【转盘】雾泽 转动「出身转盘」：教团后裔（可走隐藏路线）') // 剧情事件在 user 消息的近期剧情里
    expect(msgs[0].content).toContain(renderSettingBlock({ ...emptySetting(), era: '1930s 民国' }).slice(0, 12))
  })
})

describe('进度搭战局状态顺风车（mergeStateUpdate）', () => {
  it('<module> 上报经 progress 字段并入状态并随 normalize 往返', () => {
    let s = mergeStateUpdate(null, { area: '雾镇入口', progress: { chapter: 'c1', day: 1, addFlags: ['入场'] } })
    expect(s.progress?.chapterId).toBe('c1')
    expect(s.progress?.flags).toEqual(['入场'])
    s = mergeStateUpdate(s, { progress: { day: 2, ending: 'e1' } })
    expect(s.area).toBe('雾镇入口') // 不丢
    expect(s.progress?.day).toBe(2)
    expect(s.progress?.ended).toBe(true)

    const back = normalizeGameState(JSON.parse(JSON.stringify(s)))
    expect(back.progress?.endingId).toBe('e1')
    expect(isEmptyGameState(emptyGameState())).toBe(true)
  })

  it('无 progress 字段的老状态保持兼容', () => {
    const legacy = normalizeGameState({ area: '酒馆', items: [], memories: [], updatedAt: 1 })
    expect(legacy.progress).toBeUndefined()
    expect(isEmptyGameState(legacy)).toBe(false) // area 非空所以非空状态；关键是 progress 缺省不炸
  })
})
