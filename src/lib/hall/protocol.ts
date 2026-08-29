/**
 * 房间事件协议（内层帧，全部走 E2EE 密文通道）。
 * 外层信令帧（create/join/relay/peer-joined/room-closed…）见 server/index.js，明文但只含不透明 peerId。
 */
export type PeerRole = 'host' | 'player'

export interface MemberInfo {
  peerId: string
  name: string // 房间昵称
  role: PeerRole
  charName: string // 临时角色名
  persona: string // 一句话人设
}

export type RoomEvent =
  /** 入场自我介绍（join/create 后各发一次，成员表据此建立） */
  | { k: 'hello'; member: Omit<MemberInfo, 'peerId'> }
  /** 玩家发言（含描述动作/台词，KP 视为剧情输入） */
  | { k: 'chat'; id: string; from: string; name: string; charName: string; text: string; at: number }
  /** 旁白（房主手动，或 KP 的叙事产出） */
  | { k: 'narration'; id: string; text: string; at: number }
  /** 检定结果（明骰，全员可见） */
  | { k: 'roll'; id: string; name: string; charName: string; expr: string; detail: string; total: number; at: number }
  /** 系统事件（成员进出、房间状态等） */
  | { k: 'system'; id: string; text: string; at: number }
  /** KP 流式生成的临时帧：不落库，结束后以 narration 定稿 */
  | { k: 'kp-start'; id: string; at: number }
  | { k: 'kp-chunk'; id: string; delta: string }
  | { k: 'kp-end'; id: string; aborted?: boolean }
  /** 新成员向房主要战役快照（定向直发） */
  | { k: 'sync-request' }
  /** 房主回快照：全量剧情事件 + 成员名单（含 peerId，供成员表对齐） */
  | { k: 'sync'; events: RoomEvent[]; members: MemberInfo[] }

export type RoomEventK = RoomEvent['k']

/** 需要永久进入剧情流（房主落库、快照回放）的事件类型 */
export const PERSISTED_KINDS: readonly RoomEventK[] = ['chat', 'narration', 'roll', 'system']

export function isPersisted(e: RoomEvent): boolean {
  return PERSISTED_KINDS.includes(e.k)
}

export function newEventId(): string {
  return crypto.randomUUID()
}

/** 房主本地战役持久化文档（IndexedDB campaigns 表；服务器零存储，只有房主持有） */
export interface HallCampaign {
  id: string
  name: string
  roomCode: string
  createdAt: number
  updatedAt: number
  events: RoomEvent[]
  /** KP 世界观/团规备注 */
  worldNote: string
  /** 房间是否上锁（创建时状态） */
  locked: boolean
  /** 房间密码（仅存房主本地 IndexedDB，恢复战役重进时重新派生密钥；服务器永远不知道） */
  password: string
  /** 房间简介（恢复战役时回填列表展示） */
  desc: string
  /** 房间封面（恢复战役时回填列表展示） */
  cover: string
}

/** 大厅房间条目（服务器广播的元数据：不含密码，密文内容永远不可见） */
export interface RoomMeta {
  code: string
  title: string
  desc: string
  cover: string
  locked: boolean
  players: number
}
