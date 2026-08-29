/**
 * 星屿·跑团 —— 无状态 WS 中继服务器
 *
 * 设计承诺（与 rp-site 项目书 11.4 A 档一致）：
 * - 零持久化：房间注册表只在进程内存里，重启即清空；不写文件、不写数据库
 * - 零日志：不记录任何帧内容，stdout 只输出不含内容的连接计数
 * - 零内容可见性：客户端帧载荷（payload）为端到端密文，服务器只按房间码路由，无从解密
 * - 无公开目录：只有拿到 6 位房间码的人能进房，房间没有可发现性
 * - 房主权威：房主连接断开即关闭房间（战役状态只存在于房主浏览器本地）
 */
import { WebSocketServer } from 'ws'
import { randomUUID, randomInt } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz' // 去掉 0/o/1/l/i 等易混淆字符
const CODE_LEN = 6
const MAX_PEERS = 12

/** code -> { code, hostId, peers: Map<peerId, ws> }（进程内存，重启即清空） */
export const rooms = new Map()

export function genCode() {
  let s = ''
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return s
}

export const isCode = (s) => typeof s === 'string' && new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`).test(s)

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
}

/** 广播给房间成员；exceptPeer 传 peerId 时跳过该成员 */
function broadcast(room, obj, exceptPeer = null) {
  const data = JSON.stringify(obj)
  for (const [pid, peer] of room.peers) {
    if (pid === exceptPeer) continue
    if (peer.readyState === peer.OPEN) peer.send(data)
  }
}

/** 启动一个中继实例（测试用 port=0 拿临时端口；生产由 index 直启） */
export function startRelay(port) {
  const wss = new WebSocketServer({ port, maxPayload: 256 * 1024 })

  wss.on('connection', (ws) => {
    ws.peerId = randomUUID()
    ws.room = null
    ws.isHost = false
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      switch (msg.t) {
        case 'create': {
          if (ws.room) return
          // 房间码由客户端生成（它要先用房间码派生端到端密钥），服务器只校验格式与唯一性
          const code = isCode(msg.code) ? msg.code : genCode()
          if (rooms.has(code)) return send(ws, { t: 'error', msg: '房间码已被占用，请换一个' })
          const room = { code, hostId: ws.peerId, peers: new Map([[ws.peerId, ws]]) }
          rooms.set(code, room)
          ws.room = room
          ws.isHost = true
          send(ws, { t: 'created', code, peerId: ws.peerId })
          break
        }
        case 'join': {
          if (ws.room) return
          const code = String(msg.code || '').toLowerCase()
          const room = rooms.get(code)
          if (!room) return send(ws, { t: 'error', msg: '房间不存在或已关闭' })
          if (room.peers.size >= MAX_PEERS) return send(ws, { t: 'error', msg: '房间已满' })
          ws.room = room
          room.peers.set(ws.peerId, ws)
          // 成员列表只含不透明的 peerId；昵称/角色走加密的 hello 事件，服务器不可见
          send(ws, { t: 'joined', code, peerId: ws.peerId, hostId: room.hostId, peers: [...room.peers.keys()] })
          broadcast(room, { t: 'peer-joined', peerId: ws.peerId }, ws.peerId)
          break
        }
        case 'relay': {
          // 广播：payload 为客户端加密的密文，服务器不解析不缓存
          if (!ws.room || typeof msg.payload !== 'string') return
          broadcast(ws.room, { t: 'relay', from: ws.peerId, payload: msg.payload }, ws.peerId)
          break
        }
        case 'relay-to': {
          // 定向：主要用于房主给新成员补发战役快照
          if (!ws.room || typeof msg.payload !== 'string') return
          const target = ws.room.peers.get(msg.to)
          if (target) send(target, { t: 'relay', from: ws.peerId, payload: msg.payload, direct: true })
          break
        }
        default:
          break
      }
    })

    ws.on('close', () => {
      const room = ws.room
      if (!room) return
      room.peers.delete(ws.peerId)
      if (ws.isHost) {
        rooms.delete(room.code)
        broadcast(room, { t: 'room-closed', reason: '房主已离开，房间关闭' })
      } else {
        broadcast(room, { t: 'peer-left', peerId: ws.peerId })
      }
    })

    ws.on('error', () => { /* 单连接异常交给 close 兜底清理 */ })
  })

  // 心跳：剔除断链假死连接
  const heartbeat = setInterval(() => {
    for (const peer of wss.clients) {
      if (!peer.isAlive) { peer.terminate(); continue }
      peer.isAlive = false
      peer.ping()
    }
  }, 30_000)
  wss.on('close', () => clearInterval(heartbeat))

  return wss
}

// 直接运行时启动生产监听（被测试导入时不自动监听固定端口）
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const port = Number(process.env.PORT || 8787)
  startRelay(port)
  // 只输出无内容的运行状态（房间/连接计数），绝不输出帧内容
  setInterval(() => {
    let peers = 0
    for (const r of rooms.values()) peers += r.peers.size
    if (rooms.size > 0) console.log(`[rp-hall] rooms=${rooms.size} peers=${peers}`)
  }, 60_000).unref()
  console.log(`[rp-hall] relay listening on ws://0.0.0.0:${port}  (stateless: nothing is persisted)`)
}
