/**
 * 中继服务端 smoke：真实起服（临时端口），双客户端走完整房间生命周期。
 * 只验证信令路由，不验证内容（内容在客户端是密文）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { type WebSocketServer } from 'ws'
import { rooms, startRelay } from '../server/index.js'

const servers: WebSocketServer[] = []
const sockets: WebSocket[] = []

afterEach(() => {
  for (const s of sockets.splice(0)) s.close()
  for (const s of servers.splice(0)) s.close()
  rooms.clear()
})

async function startServer(): Promise<number> {
  const wss = startRelay(0)
  servers.push(wss)
  await new Promise<void>((resolve) => wss.on('listening', resolve))
  const addr = wss.address() as { port: number }
  return addr.port
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.push(ws)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

/** 收集帧直到断言器通过或超时 */
function nextFrame(ws: WebSocket, match: (m: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待帧超时')), timeoutMs)
    const onMsg = (raw: WebSocket.RawData) => {
      const m = JSON.parse(raw.toString())
      if (match(m)) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(m)
      }
    }
    ws.on('message', onMsg)
  })
}

function send(ws: WebSocket, obj: unknown) {
  ws.send(JSON.stringify(obj))
}

describe('中继服务端', () => {
  it('创建 → 加入 → 广播转发 → 定向转发 → 房主离开关房', async () => {
    const port = await startServer()
    const host = await connect(port)
    const guest = await connect(port)

    send(host, { t: 'create', code: 'abc234' })
    const created = await nextFrame(host, (m) => m.t === 'created')
    expect(created.code).toBe('abc234')
    const hostId = created.peerId as string

    send(guest, { t: 'join', code: 'ABC234' }) // 大小写归一化
    const joined = await nextFrame(guest, (m) => m.t === 'joined')
    expect(joined.hostId).toBe(hostId)
    expect((joined.peers as string[]).length).toBe(2)
    await nextFrame(host, (m) => m.t === 'peer-joined')

    // 广播：host → guest（密文 payload 原样转发）
    send(host, { t: 'relay', payload: 'SEALED-PAYLOAD-1' })
    const relayed = await nextFrame(guest, (m) => m.t === 'relay')
    expect(relayed.payload).toBe('SEALED-PAYLOAD-1')
    expect(relayed.from).toBe(hostId)

    // 广播不回发给发送者自己
    send(host, { t: 'relay', payload: 'SELF-CHECK' })
    await expect(nextFrame(host, (m) => m.t === 'relay', 300)).rejects.toThrow('超时')

    // 定向：guest → host
    send(guest, { t: 'relay-to', to: hostId, payload: 'DIRECT-PAYLOAD' })
    const direct = await nextFrame(host, (m) => m.t === 'relay' && m.payload === 'DIRECT-PAYLOAD')
    expect(direct.direct).toBe(true)

    // 房主关闭连接 → 房间注销 + guest 收到关房通知
    host.close()
    const closed = await nextFrame(guest, (m) => m.t === 'room-closed')
    expect(closed.reason).toContain('房主')
    expect(rooms.has('abc234')).toBe(false)
  })

  it('加入不存在的房间报错；普通成员离开只广播 peer-left', async () => {
    const port = await startServer()
    const a = await connect(port)
    send(a, { t: 'join', code: 'zzz999' })
    const err = await nextFrame(a, (m) => m.t === 'error')
    expect(err.msg).toContain('不存在')

    const host = await connect(port)
    send(host, { t: 'create', code: 'bcd345' })
    await nextFrame(host, (m) => m.t === 'created')

    const guest = await connect(port)
    send(guest, { t: 'join', code: 'bcd345' })
    await nextFrame(guest, (m) => m.t === 'joined')

    guest.close()
    const left = await nextFrame(host, (m) => m.t === 'peer-left')
    expect(left.peerId).toBeTruthy()
    expect(rooms.has('bcd345')).toBe(true) // 房主还在，房不关
  })

  it('重复房间码创建被拒绝', async () => {
    const port = await startServer()
    const a = await connect(port)
    send(a, { t: 'create', code: 'cde456' })
    await nextFrame(a, (m) => m.t === 'created')

    const b = await connect(port)
    send(b, { t: 'create', code: 'cde456' })
    const err = await nextFrame(b, (m) => m.t === 'error')
    expect(err.msg).toContain('占用')
  })
})
