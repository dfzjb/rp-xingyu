import { describe, expect, it } from 'vitest'
import { PARTY_LINE, sceneNarrator, type HallScene } from '../src/lib/hall/protocol'

const scenes: HallScene[] = [
  { id: 's1', name: '王五的个人线', member: '王五', generator: '王五', closed: false },
  { id: 's2', name: '老线（无指派）', member: '李四', closed: false },
  { id: 's3', name: '已收回', member: '', generator: '', closed: false },
]

describe('sceneNarrator（计费归属单一事实源）', () => {
  it('指派了叙述者的线归成员；缺省/空指派/全体线归房主', () => {
    expect(sceneNarrator(scenes, 's1')).toBe('王五')
    expect(sceneNarrator(scenes, 's2')).toBe('房主') // 旧数据只有 member 没有 generator
    expect(sceneNarrator(scenes, 's3')).toBe('房主') // 显式收回
    expect(sceneNarrator(scenes, PARTY_LINE)).toBe('房主')
    expect(sceneNarrator(scenes, '不存在')).toBe('房主')
  })

  it('房主名可自定义（跟随房间主昵称）', () => {
    expect(sceneNarrator(scenes, PARTY_LINE, '团长')).toBe('团长')
    expect(sceneNarrator(scenes, 's1', '团长')).toBe('王五')
  })
})
