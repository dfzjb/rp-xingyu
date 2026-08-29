/**
 * 星屿·跑团 —— 无状态 WS 中继服务器
 *
 * 设计承诺（与 rp-site 项目书 11.4 A 档一致）：
 * - 零持久化：房间注册表（含元数据）只在进程内存里，重启即清空；不写文件、不写数据库
 * - 零日志：不记录任何帧内容，stdout 只输出不含内容的连接计数
 * - 零内容可见性：房间消息载荷为端到端密文；服务器只保存房主自愿公开的房间元数据
 *   （标题/简介/封面/是否上锁），上锁房间的密码校验串为单向散列，无法还原密码与密钥
 * - 房主权威：房主连接断开即关闭房间（战役状态只存在于房主浏览器本地）
 */
import { WebSocketServer } from 'ws'
import { randomUUID, randomInt } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz' // 去掉 0/o/1/l/i 等易混淆字符
const CODE_LEN = 6
const MAX_PEERS = 12
const MAX_ROOMS = 50
const MAX_COVER = 200_000 // 封面 data URI 上限（约 150KB 图片）

/** code -> { code, hostId, peers: Map<peerId, ws>, meta: {title,desc,cover,locked}, proof|null }（内存，重启即清空） */
export const rooms = new Map()
const sockets = new Set()

export function genCode() {
  let s = ''
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return s
}

export const isCode = (s) => typeof s === 'string' && new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`).test(s)

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
}

function broadcast(room, obj, exceptPeer = null) {
  const data = JSON.stringify(obj)
  for (const [pid, peer] of room.peers) {
    if (pid === exceptPeer) continue
    if (peer.readyState === peer.OPEN) peer.send(data)
  }
}

/** 房间列表变化（创建/加入/退出/关房）后通知所有连接刷新列表；只发信号，不带列表本体 */
function announceChange() {
  const data = JSON.stringify({ t: 'rooms-changed' })
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data)
}

function roomSummary(room) {
  return { code: room.code, ...room.meta, players: room.peers.size }
}

/** 元数据白名单清洗：长度上限 + 封面必须是 data:image */
function sanitizeMeta(raw) {
  const m = raw && typeof raw === 'object' ? raw : {}
  const title = String(m.title || '未命名房间').slice(0, 40)
  const desc = String(m.desc || '').slice(0, 200)
  const cover = typeof m.cover === 'string' && m.cover.startsWith('data:image/') && m.cover.length <= MAX_COVER ? m.cover : ''
  const locked = m.locked === true
  return { title, desc, cover, locked }
}

function roomList() {
  return [...rooms.values()].map(roomSummary)
}

/** 启动一个中继实例（测试用 port=0 拿临时端口；生产由 index 直启） */
export function startRelay(port) {
  const wss = new WebSocketServer({ port, maxPayload: 512 * 1024 })

  wss.on('connection', (ws) => {
    ws.peerId = randomUUID()
    ws.room = null
    ws.isHost = false
    ws.isAlive = true
    sockets.add(ws)
    ws.on('pong', () => { ws.isAlive = true })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      switch (msg.t) {
        case 'create': {
          if (ws.room) return
          if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: '房间数已达上限，稍后再试' })
          // 房间码由客户端生成（它要先用房间码/密码派生端到端密钥），服务器只校验格式与唯一性
          const code = isCode(msg.code) ? msg.code : genCode()
          if (rooms.has(code)) return send(ws, { t: 'error', msg: '房间码已被占用，请换一个' })
          const meta = sanitizeMeta(msg.meta)
          // 上锁房间：proof = 密码派生密钥的单向散列（服务器无法据此还原密码或密钥）
          const proof = typeof msg.proof === 'string' ? msg.proof.slice(0, 128) : ''
          if (meta.locked && !proof) return send(ws, { t: 'error', msg: '上锁房间缺少密码校验串' })
          const room = { code, hostId: ws.peerId, peers: new Map([[ws.peerId, ws]]), meta, proof: meta.locked ? proof : null }
          rooms.set(code, room)
          ws.room = room
          ws.isHost = true
          send(ws, { t: 'created', code, peerId: ws.peerId })
          announceChange()
          break
        }
        case 'join': {
          if (ws.room) return
          const code = String(msg.code || '').toLowerCase()
          const room = rooms.get(code)
          if (!room) return send(ws, { t: 'error', msg: '房间不存在或已关闭' })
          if (room.peers.size >= MAX_PEERS) return send(ws, { t: 'error', msg: '房间已满' })
          // 上锁房间必须通过密码校验串
          if (room.meta.locked && room.proof !== String(msg.proof || '')) {
            return send(ws, { t: 'error', msg: '密码错误' })
          }
          ws.room = room
          room.peers.set(ws.peerId, ws)
          // 成员列表只含不透明的 peerId；昵称/角色走加密的 hello 事件，服务器不可见
          send(ws, { t: 'joined', code, peerId: ws.peerId, hostId: room.hostId, peers: [...room.peers.keys()] })
          broadcast(room, { t: 'peer-joined', peerId: ws.peerId }, ws.peerId)
          announceChange()
          break
        }
        case 'list': {
          send(ws, { t: 'rooms', rooms: roomList() })
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
      sockets.delete(ws)
      const room = ws.room
      if (!room) return
      room.peers.delete(ws.peerId)
      if (ws.isHost) {
        rooms.delete(room.code)
        broadcast(room, { t: 'room-closed', reason: '房主已离开，房间关闭' })
      } else {
        broadcast(room, { t: 'peer-left', peerId: ws.peerId })
      }
      announceChange()
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
