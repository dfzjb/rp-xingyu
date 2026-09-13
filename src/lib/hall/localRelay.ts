/**
 * 单机团本地中继：进程内「哑中继」，实现与 server/index.js 相同的信令协议子集。
 *
 * 单机房间里只有房主一个连接：create 即建房即入房；relay / relay-to 没有其他成员可转发，
 * 与真实中继「广播不回显发送者」的语义一致——房主事件本来就经 appendLocal 落本地，
 * 剧情数据不出浏览器，战役照旧只存房主 IndexedDB（v1 边界不变）。
 * 接口对齐 useHall 用到的 WebSocket 子集（RelaySocket），connect() 里与真实 WebSocket 可互换。
 */

export const LOCAL_RELAY_URL = 'local:solo'

/** useHall 依赖的连接子集：真实 WebSocket 与 LocalRelay 都满足 */
export interface RelaySocket {
  readonly OPEN: number
  readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

/** 与 WebSocket 对齐的 readyState 常量（useHall 判断连接态用） */
export const RS_CONNECTING = 0
export const RS_OPEN = 1
export const RS_CLOSED = 3

export class LocalRelay implements RelaySocket {
  readonly OPEN = RS_OPEN
  readyState = RS_CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  private peerId = `solo-${crypto.randomUUID().slice(0, 8)}`
  private code = ''
  private closed = false

  constructor() {
    // 模拟真实握手的异步性：onopen 与构造不同步触发
    setTimeout(() => {
      if (this.closed || this.readyState !== RS_CONNECTING) return
      this.readyState = RS_OPEN
      this.onopen?.()
    }, 0)
  }

  send(data: string) {
    if (this.readyState !== RS_OPEN) return
    let msg: Record<string, unknown>
    try { msg = JSON.parse(data) as Record<string, unknown> } catch { return }
    this.route(msg)
  }

  /** 信令路由：server/index.js 的单客户端等价实现（元数据校验/房间表对单机无意义，从简） */
  private route(msg: Record<string, unknown>) {
    switch (msg.t) {
      case 'create': {
        if (this.code) return
        this.code = String(msg.code || 'solo00')
        this.emit({ t: 'created', code: this.code, peerId: this.peerId })
        break
      }
      case 'join':
        this.emit({ t: 'error', msg: '单机团没有其他房间——想联机请用共享大厅或私人中继' })
        break
      case 'relay':
      case 'relay-to':
        // 无其他成员：不回显发送者（与真实中继一致）
        break
      case 'list':
        this.emit({ t: 'rooms', rooms: [] })
        break
      default:
        break
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = RS_CLOSED
    // 异步触发，让 leaveRoom 的状态重置先于 onclose 完成（与真实 WS 的异步 close 一致）
    setTimeout(() => this.onclose?.(), 0)
  }

  private emit(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}
