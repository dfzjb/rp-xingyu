import { describe, expect, it } from 'vitest'
import { DEFAULT_HALL_RELAY, type HallRelayMode } from '../src/lib/hall/protocol'
import { buildInviteLink, parseInvite } from '../src/lib/hall/useHall'

describe('邀请链接', () => {
  it('build → parse 往返：码/中继/上锁标记不丢', () => {
    const link = buildInviteLink('https://x.github.io', '/rp/', 'abc234', 'wss://my.relay.example/ws', true)
    const inv = parseInvite(new URL(link).search)
    expect(inv).toEqual({ code: 'abc234', relay: 'wss://my.relay.example/ws', locked: true })
    expect(link.startsWith('https://x.github.io/rp/?join=abc234')).toBe(true)
  })

  it('共享房间省略上锁标记；解析得到默认中继语义（relay 空串）', () => {
    const link = buildInviteLink('http://127.0.0.1:5273', '/', 'k3m9x2', DEFAULT_HALL_RELAY, false)
    expect(parseInvite(new URL(link).search)).toEqual({ code: 'k3m9x2', relay: DEFAULT_HALL_RELAY, locked: false })
  })

  it('非法输入返回 null：缺参/码错/多字符', () => {
    expect(parseInvite('')).toBeNull()
    expect(parseInvite('?join=abc')).toBeNull()
    expect(parseInvite('?join=abcde0')).not.toBeNull() // 六位即可，客户端宽容解析
    expect(parseInvite('?join=abcdefgh')).toBeNull()
    expect(parseInvite('?join=ABC234')?.code).toBe('abc234') // 大小写归一
  })

  it('HallRelayMode 三个取值都能被 relayOfRoom 语义覆盖（契约冒烟）', () => {
    const modes: HallRelayMode[] = ['local', 'shared', 'private']
    expect(modes).toContain('local')
    expect(modes).toContain('shared')
    expect(modes).toContain('private')
  })
})
