/**
 * 单机团：LocalRelay 信令路由 + useHall 本地建房冒烟。
 * 不需要真实服务器与网络：单机中继在本进程内回环，剧情只落本机 IndexedDB。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { LocalRelay, LOCAL_RELAY_URL } from '../src/lib/hall/localRelay'
import { db } from '../src/db'
import { hall, connect, leaveRoom, sendChat, sendRoll } from '../src/lib/hall/useHall'

// connect / enterRoomAsHost 会写 localStorage（node 环境没有）：内存桩
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

describe('LocalRelay 信令路由', () => {
  it('create → created；relay/relay-to 不回显；list → 空列表；join → 报错；close → 异步 onclose', async () => {
    const relay = new LocalRelay()
    const opened = vi.fn()
    const frames: Record<string, unknown>[] = []
    relay.onopen = opened
    relay.onmessage = (ev) => frames.push(JSON.parse(ev.data as string))

    await flush()
    expect(opened).toHaveBeenCalledTimes(1)

    relay.send(JSON.stringify({ t: 'create', code: 'abc234' }))
    expect(frames[0]).toMatchObject({ t: 'created', code: 'abc234' })

    // 与真实中继一致：广播不回显给发送者（单机没有其他成员）
    relay.send(JSON.stringify({ t: 'relay', payload: 'SEALED-1' }))
    relay.send(JSON.stringify({ t: 'relay-to', to: 'someone', payload: 'SEALED-2' }))
    expect(frames.length).toBe(1)

    relay.send(JSON.stringify({ t: 'list' }))
    expect(frames[1]).toEqual({ t: 'rooms', rooms: [] })

    relay.send(JSON.stringify({ t: 'join', code: 'abc234' }))
    expect(frames[2].t).toBe('error')

    const closed = vi.fn()
    relay.onclose = closed
    relay.close()
    await flush()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

describe('单机团冒烟', () => {
  it('本地中继建房 → 进房 → 发言/掷骰落剧情流 → 战役入库 → 退出', async () => {
    setActivePinia(createPinia())
    await connect({
      mode: 'create',
      code: 'solo01',
      profile: { name: 'KP', charName: 'KP', persona: '冒烟测试' },
      meta: { title: '单机测试团', desc: '', cover: '', locked: false, relay: 'local' },
    })
    await flush()
    expect(hall.state.phase).toBe('room')
    expect(hall.state.isHost).toBe(true)
    expect(hall.state.roomRelay).toBe(LOCAL_RELAY_URL)
    expect(Object.keys(hall.state.members).length).toBe(1)

    await sendChat('我推开门，雾灌了进来。')
    expect(await sendRoll('1d20')).toBeNull()
    await flush()

    const kinds = hall.state.events.map((e) => e.k)
    expect(kinds).toContain('chat')
    expect(kinds).toContain('roll')

    // 战役只存房主本机（campaigns 表），中继模式标记为 local
    const camps = await db.campaigns.toArray()
    expect(camps.length).toBe(1)
    expect(camps[0].relay).toBe('local')
    expect(camps[0].events.some((e) => e.k === 'chat')).toBe(true)

    leaveRoom()
    await flush()
    expect(hall.state.phase).toBe('idle')
  })
})
