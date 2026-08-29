import { describe, expect, it } from 'vitest'
import { deriveRoomKey, genRoomCode, openEvent, sealEvent } from '../src/lib/hall/crypto'

describe('E2EE 房间密钥', () => {
  it('同一房间码派生同一密钥，能互相解密', async () => {
    const key1 = await deriveRoomKey('abc234')
    const key2 = await deriveRoomKey('ABC234') // 大小写归一化
    const sealed = await sealEvent(key1, { k: 'chat', text: '你好，密文里的秘密' })
    const opened = await openEvent<{ k: string; text: string }>(key2, sealed)
    expect(opened.text).toBe('你好，密文里的秘密')
  })

  it('不同房间码的密钥解不开彼此的密文', async () => {
    const k1 = await deriveRoomKey('abc234')
    const k2 = await deriveRoomKey('xyz789')
    const sealed = await sealEvent(k1, { secret: 1 })
    await expect(openEvent(k2, sealed)).rejects.toThrow()
  })

  it('载荷损坏/过短抛错而非崩溃', async () => {
    const key = await deriveRoomKey('abc234')
    await expect(openEvent(key, 'garbage!!')).rejects.toThrow()
    await expect(openEvent(key, 'AAAA')).rejects.toThrow('过短')
  })

  it('大体积战役快照往返一致', async () => {
    const key = await deriveRoomCodeKey()
    const big = { events: Array.from({ length: 500 }, (_, i) => ({ k: 'chat', text: `事件${i}——`.repeat(20) })) }
    const sealed = await sealEvent(key, big)
    expect((await openEvent<typeof big>(key, sealed)).events).toHaveLength(500)
  })

  async function deriveRoomCodeKey() {
    return deriveRoomKey('roundtrip')
  }
})

describe('genRoomCode', () => {
  it('6 位、小写字母表、多次生成不重复', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const code = genRoomCode()
      expect(code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/)
      seen.add(code)
    }
    expect(seen.size).toBeGreaterThan(40)
  })
})
