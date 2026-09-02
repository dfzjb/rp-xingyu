/**
 * 跑团中继真机联调（ws://127.0.0.1:18787）
 * 覆盖：建房(上锁) → 错误密码拒绝 → 正确密码加入 → 广播转发 → 定向转发 →
 *       房间列表 → 成员离开 → 房主离开关房 → 房间清空 → 非法房间码
 */
import WebSocket from 'ws'

const URL = 'ws://127.0.0.1:18787'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`) }
}

class Client {
  constructor(tag = '?') {
    this.tag = tag
    this.ws = new WebSocket(URL)
    this.queue = []
    this.waiters = [] // { pred, res, timer }：持久等待器，新消息对所有等待器重新匹配
    this.opened = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej) })
    this.ws.on('message', (raw) => {
      this.queue.push(JSON.parse(raw.toString()))
      this.#pump()
    })
  }
  /** 用队列里的消息按序喂等待器，命中即消费 */
  #pump() {
    for (let i = 0; i < this.queue.length; i++) {
      const w = this.waiters.find((x) => x.pred(this.queue[i]))
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        clearTimeout(w.timer)
        w.res(this.queue.splice(i, 1)[0])
        i--
      }
    }
  }
  send(obj) { this.ws.send(JSON.stringify(obj)) }
  next(pred, timeout = 3000) {
    for (let i = 0; i < this.queue.length; i++) {
      if (pred(this.queue[i])) return Promise.resolve(this.queue.splice(i, 1)[0])
    }
    return new Promise((res, rej) => {
      const w = {
        pred,
        res,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(w)
          if (idx >= 0) this.waiters.splice(idx, 1)
          rej(new Error(`[${this.tag}] 等待消息超时, queue=${JSON.stringify(this.queue)}`))
        }, timeout),
      }
      this.waiters.push(w)
      this.#pump()
    })
  }
  close() { this.ws.close() }
}

const host = new Client('host'); await host.opened
const peer = new Client('peer'); await peer.opened

console.log('== 跑团中继真机 E2E ==')
{
  host.send({ t: 'create', code: 'testrm', meta: { title: '真机测试团', desc: 'E2E', locked: true }, proof: 'proof-abc' })
  const m = await host.next((x) => x.t === 'created' || x.t === 'error')
  ok('房主创建上锁房间', m.t === 'created' && m.code === 'testrm')
  globalThis.hostId = m.peerId
}
{
  peer.send({ t: 'join', code: 'testrm', proof: 'wrong' })
  const m = await peer.next((x) => x.t === 'error' || x.t === 'joined')
  ok('错误密码被拒绝', m.t === 'error' && String(m.msg).includes('密码'))
}
{
  peer.send({ t: 'join', code: 'testrm', proof: 'proof-abc' })
  const m = await peer.next((x) => x.t === 'joined')
  ok('正确密码加入，拿到 peers 列表', m.hostId === globalThis.hostId && Array.isArray(m.peers) && m.peers.length === 2)
  globalThis.peerId = m.peerId
}
{
  host.send({ t: 'relay', payload: 'ENC:host->all' })
  const m = await peer.next((x) => x.t === 'relay')
  ok('广播转发（服务器只见密文）', m.from === globalThis.hostId && m.payload === 'ENC:host->all' && m.direct === undefined)
}
{
  peer.send({ t: 'relay-to', to: globalThis.hostId, payload: 'ENC:peer->host' })
  const m = await host.next((x) => x.t === 'relay')
  ok('定向转发', m.from === globalThis.peerId && m.payload === 'ENC:peer->host' && m.direct === true)
}
{
  const watcher = new Client('watch'); await watcher.opened
  watcher.send({ t: 'list' })
  const m = await watcher.next((x) => x.t === 'rooms')
  const room = m.rooms.find((r) => r.code === 'testrm')
  ok('房间列表可见：标题/人数/上锁', room && room.title === '真机测试团' && room.players === 2 && room.locked === true)
  watcher.close()
}
{
  const late = new Client('late'); await late.opened
  late.send({ t: 'join', code: 'testrm', proof: 'proof-abc' })
  await late.next((x) => x.t === 'joined')
  late.close()
  const left = await peer.next((x) => x.t === 'peer-left')
  ok('成员离开广播 peer-left', left.t === 'peer-left')
}
{
  host.close()
  const m = await peer.next((x) => x.t === 'room-closed')
  ok('房主离开 → 房间关闭通知', m.t === 'room-closed')
  const watcher = new Client('watch'); await watcher.opened
  watcher.send({ t: 'list' })
  const lm = await watcher.next((x) => x.t === 'rooms')
  ok('关房后列表清空', Array.isArray(lm.rooms) && lm.rooms.length === 0)
  watcher.close()
}
{
  const c = new Client('c'); await c.opened
  c.send({ t: 'join', code: 'zzzzzz' })
  const m = await c.next((x) => x.t === 'error')
  ok('不存在的房间报错', String(m.msg).includes('不存在'))
  c.send({ t: 'create', code: 'BadCode!' })
  const m2 = await c.next((x) => x.t === 'created')
  ok('非法房间码被服务端重新生成', m2.t === 'created' && m2.code !== 'BadCode!' && /^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/.test(m2.code))
  c.close()
}
host.close(); peer.close()
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
