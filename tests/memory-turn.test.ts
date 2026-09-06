import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MsgNode } from '../src/types'
import {
  autoIngestVectorFloors,
  buildTurnVectorFragments,
  distillTurnMemory,
  listMemories,
  memoryContentFingerprint,
  mergeSmallMemoryParagraphs,
  splitLongMemoryParagraph,
  splitMemoryParagraphs,
  stripMemoryCode,
} from '../src/lib/memories'

// mock 掉聊天/嵌入 API：提炼返回两行要点，embedding 返回固定维度向量
vi.mock('../src/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/api')>()
  return {
    ...orig,
    chatOnce: vi.fn(async () => '- 主角捡到 100 金币\n- 与铁匠立约明日交剑'),
    fetchEmbeddings: vi.fn(async (_cfg: unknown, inputs: string[]) => inputs.map(() => [0.1, 0.2, 0.3])),
  }
})

function node(role: 'user' | 'assistant', content: string, name?: string): MsgNode {
  return {
    id: `n${Math.random().toString(36).slice(2, 8)}`,
    role,
    name: name || (role === 'user' ? '我' : '艾拉'),
    content,
    isSelf: role === 'user',
    createdAt: Date.now(),
    parentId: null,
    childrenIds: [],
  }
}

const SESSION = 'sess-mem-turn'

beforeEach(async () => {
  const { db } = await import('../src/db')
  await db.memories.where('sessionId').equals(SESSION).delete()
})

describe('分片构造', () => {
  it('stripMemoryCode：剥思维链/UI 块/代码块/HTML 与代码样式行，解码实体', () => {
    const raw = [
      '<think>隐藏推理</think>',
      '<ui_template_updates>{"a":1}</ui_template_updates>',
      '金库剩余 &amp; 5000 金币',
      '```js\nconst a = 1;\n```',
      '<div class="panel">logo</div>',
      '新闻：码头开放',
      'const x = 1;',
    ].join('\n')
    const out = stripMemoryCode(raw)
    expect(out).toContain('金库剩余 & 5000 金币')
    expect(out).toContain('新闻：码头开放')
    expect(out).not.toContain('隐藏推理')
    expect(out).not.toContain('const')
    // 无标点的整行标签行整行剔除
    expect(out).not.toContain('logo')
    expect(out).not.toContain('<div')
  })

  it('splitLongMemoryParagraph：短段原样；超长段在句读处切且断点不早于 55%', () => {
    expect(splitLongMemoryParagraph('短段')).toEqual(['短段'])
    const long = '。'.repeat(60) + '句尾！' + '。'.repeat(60)
    const parts = splitLongMemoryParagraph(long, 100)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100)
  })

  it('splitMemoryParagraphs：按空行分段', () => {
    expect(splitMemoryParagraphs('第一段\n\n第二段')).toEqual(['第一段', '第二段'])
    expect(splitMemoryParagraphs('')).toEqual([])
  })

  it('mergeSmallMemoryParagraphs：小段合并到 400 以内并保留序号区间', () => {
    const merged = mergeSmallMemoryParagraphs(['甲', '乙', '丙'.repeat(400)])
    expect(merged[0].text).toContain('甲')
    expect(merged[0].text).toContain('乙')
    expect(merged[0].start).toBe(1)
    expect(merged[0].end).toBe(2)
    expect(merged[1].text.startsWith('丙')).toBe(true)
  })

  it('memoryContentFingerprint：归一化标点空白，≥80 字才有指纹且稳定', () => {
    // '内，。'.repeat(50) 归一化后只剩 50 个"内"（<80）→ 无指纹
    expect(memoryContentFingerprint('内，。'.repeat(50))).toBe('')
    const a = memoryContentFingerprint('内'.repeat(100))
    // '内，。'.repeat(100) 归一化后 = 100 个"内"，与 a 相同（标点不影响指纹）
    const b = memoryContentFingerprint('内，。'.repeat(100))
    expect(a).toBeTruthy()
    expect(a).toBe(b)
  })

  it('buildTurnVectorFragments：AI 段带"角色卡："前缀、用户行前置、sourceText 带"第 N 轮"', () => {
    const frags = buildTurnVectorFragments(
      [node('user', '我捡了 100 金币'), node('assistant', '艾拉点头收下金币，答应帮我去买药水。')],
      3,
    )
    expect(frags.length).toBeGreaterThan(0)
    const f = frags[0]
    expect(f.turn).toBe(3)
    expect(f.paragraph).toContain('用户：我捡了 100 金币')
    expect(f.paragraph).toContain('角色卡：')
    expect(f.sourceText).toContain('第 3 轮')
    expect(f.sourceRole).toBe('mixed')
    expect(f.ids).toHaveLength(2)
    // summary 截断上限 900
    expect(f.paragraph.length).toBeLessThan(950)
  })

  it('buildTurnVectorFragments：纯用户轮独立成片并自带"用户："前缀', () => {
    const frags = buildTurnVectorFragments([node('user', '只有用户输入的一轮')], 1)
    expect(frags).toHaveLength(1)
    expect(frags[0].paragraph).toBe('用户：只有用户输入的一轮')
    expect(frags[0].sourceRole).toBe('user')
  })
})

describe('每轮入库（向量模式）', () => {
  it('开场白（无前置用户输入）不入库；user+AI 轮按字段入库', async () => {
    const chain = [
      node('assistant', '欢迎来到星屿镇，冒险者。'),
      node('user', '我捡了 100 金币'),
      node('assistant', '艾拉帮你把金币收好。'),
    ]
    const added = await autoIngestVectorFloors(
      { baseUrl: 'https://x.test', apiKey: 'k', model: 'embed-x' },
      chain,
      SESSION,
    )
    expect(added).toBeGreaterThan(0)
    const rows = await listMemories(SESSION)
    expect(rows.every((r) => r.kind === 'chunk')).toBe(true)
    expect(rows.every((r) => !(r.summary || '').includes('欢迎来到星屿镇'))).toBe(true)
    const withUser = rows.find((r) => (r.paragraph || '').includes('用户：我捡了 100 金币'))
    expect(withUser).toBeTruthy()
    expect(withUser!.turn).toBe(1)
    expect(withUser!.sourceRole).toBe('mixed')
    // 归一化不足 80 字的片段没有指纹（不参与指纹去重，靠节点覆盖去重）
    expect(withUser!.contentFingerprint).toBe('')
  })

  it('幂等：同一链路重复调用不再新增', async () => {
    const chain = [node('user', '我捡了 100 金币'), node('assistant', '艾拉帮你收好。')]
    const first = await autoIngestVectorFloors(
      { baseUrl: 'https://x.test', apiKey: 'k', model: 'embed-x' },
      chain,
      SESSION,
    )
    const second = await autoIngestVectorFloors(
      { baseUrl: 'https://x.test', apiKey: 'k', model: 'embed-x' },
      chain,
      SESSION,
    )
    expect(first).toBeGreaterThan(0)
    expect(second).toBe(0)
  })
})

describe('每轮提炼（总结模式）', () => {
  it('本轮提炼为要点条目并绑定本轮最后 AI 节点', async () => {
    const turn = [node('user', '我捡了 100 金币'), node('assistant', '艾拉替你收好，并提醒明天去铁匠铺。')]
    const added = await distillTurnMemory(
      { baseUrl: 'https://x.test', apiKey: 'k', model: 'aux-x', temperature: 0.3, maxTokens: 1024, reasoningEffort: 'minimal' },
      turn,
      SESSION,
      1,
    )
    expect(added).toBe(2)
    const rows = await listMemories(SESSION)
    expect(rows.length).toBe(2)
    expect(rows[0].summary).toContain('100 金币')
    expect(rows[0].sourceAssistantIds).toEqual([turn[1].id])
    expect(rows[0].turn).toBe(1)
  })

  it('去重：轮内节点已被覆盖时跳过（续写/重 roll 不重复入库）', async () => {
    const turn = [node('user', '我捡了 100 金币'), node('assistant', '艾拉替你收好。')]
    await distillTurnMemory(
      { baseUrl: 'https://x.test', apiKey: 'k', model: 'aux-x', temperature: 0.3, maxTokens: 1024, reasoningEffort: 'minimal' },
      turn,
      SESSION,
      1,
    )
    const again = await distillTurnMemory(
      { baseUrl: 'https://x.test', apiKey: 'k', model: 'aux-x', temperature: 0.3, maxTokens: 1024, reasoningEffort: 'minimal' },
      turn,
      SESSION,
      1,
    )
    expect(again).toBe(0)
  })
})
