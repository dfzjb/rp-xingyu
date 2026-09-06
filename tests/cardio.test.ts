import { describe, expect, it } from 'vitest'
import {
  buildPngCard,
  importCardFile,
  oursCardToSt,
  parsePngCard,
  pngBytesToDataUri,
  stCardToOurs,
} from '../src/lib/cardio'

/** 手工拼一个最小合法 PNG（签名 + IHDR + IEND），供 chunk 插入测试用 */
function minimalPng(): Uint8Array {
  const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    out.set(enc(type), 4)
    out.set(data, 8)
    // 解析器按长度走 chunk，不校验 CRC，填 0 即可
    return out
  }
  const parts = [
    enc('\x89PNG\r\n\x1a\n'),
    chunk('IHDR', new Uint8Array(13)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

const ST_V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '冰霜法师',
    description: '一位旅居雪镇的法师',
    personality: '冷静',
    scenario: '暴风雪夜的小酒馆',
    first_mes: '*她抬头看了你一眼*',
    alternate_greetings: ['开场A', ' ', '开场B'],
    mes_example: '<START>\n{{user}}: 你好\n{{char}}: 嗯。',
    system_prompt: '保持角色',
    post_history_instructions: '收束剧情',
    creator: '作者甲',
    character_version: '1.1',
    tags: ['奇幻'],
    character_book: {
      entries: [
        { keys: ['雪镇'], content: '雪镇常年下雪', comment: '地点', enabled: true },
      ],
    },
    extensions: {
      rp_site_ui_templates: [
        { id: 'tpl-a', name: '状态栏', htmlTemplate: '<b>{{hp}}</b>', initialVariableState: { hp: 10 } },
      ],
      regex_scripts: [{ scriptName: '清理', findRegex: '/x/g', replaceString: 'y' }],
    },
  },
}

describe('PNG 卡读写往返', () => {
  it('buildPngCard → parsePngCard 提取出原卡对象', async () => {
    const uri = pngBytesToDataUri(minimalPng())
    const bytes = await buildPngCard(uri, ST_V2_CARD)
    const file = new File([bytes as BlobPart], 'card.png', { type: 'image/png' })
    const parsed = await parsePngCard(file)
    expect(parsed.card).toEqual(ST_V2_CARD)
  })

  it('非 PNG 文件抛错；无 chara 块的 PNG 抛错', async () => {
    await expect(parsePngCard(new File(['not png'], 'a.png'))).rejects.toThrow('不是 PNG')
    const plain = await buildPngCard(pngBytesToDataUri(minimalPng()), { x: 1 })
    // 正常含 chara 块；构造无块版本：直接用原始 png
    await expect(parsePngCard(new File([minimalPng() as BlobPart], 'b.png')))
      .rejects.toThrow('角色卡数据')
    void plain
  })
})

describe('ST 卡 ↔ 新站卡转换', () => {
  it('v2 JSON 文件导入：字段、世界书、UI 模板、正则归位', async () => {
    const file = new File([JSON.stringify(ST_V2_CARD)], 'card.json', { type: 'application/json' })
    const card = await importCardFile(file)
    expect(card.name).toBe('冰霜法师')
    expect(card.alternateGreetings).toEqual(['开场A', '开场B']) // 空白开场白被过滤
    expect(card.systemPromptOverride).toBe('保持角色')
    expect(card.worldInfo).toHaveLength(1)
    expect((card.worldInfo[0] as Record<string, unknown>).keys).toEqual(['雪镇'])
    expect(card.uiTemplates).toHaveLength(1)
    expect(card.uiTemplates![0].htmlTemplate).toBe('<b>{{hp}}</b>')
    expect(card.regexScripts).toHaveLength(1)
    expect(card.avatar).toBe('')
  })

  it('新站卡 → ST v3 → 再导入，关键字段幂等', () => {
    const card = stCardToOurs(ST_V2_CARD, 'data:image/png;base64,AAA')
    const st = oursCardToSt(card)
    expect(st.spec).toBe('chara_card_v3')
    const back = stCardToOurs(st, '')
    expect(back.name).toBe(card.name)
    expect(back.description).toBe(card.description)
    expect(back.alternateGreetings).toEqual(card.alternateGreetings)
    expect(back.systemPromptOverride).toBe(card.systemPromptOverride)
    expect(back.uiTemplates!.map((t) => t.id)).toEqual(card.uiTemplates!.map((t) => t.id))
    expect(back.worldInfo).toHaveLength(card.worldInfo.length)
  })

  it('根层 V1 平面卡也能导入', () => {
    const v1 = { name: '老卡', description: 'd', greeting: '你好' }
    const card = stCardToOurs(v1, '')
    expect(card.name).toBe('老卡')
    expect(card.first_mes).toBe('你好')
  })

  it('无效对象抛错', () => {
    expect(() => stCardToOurs(null, '')).toThrow('卡数据无效')
  })
})
