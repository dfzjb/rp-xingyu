/**
 * 房间事件协议（内层帧，全部走 E2EE 密文通道）。
 * 外层信令帧（create/join/relay/peer-joined/room-closed…）见 server/index.js，明文但只含不透明 peerId。
 */
import type { RoomSetting } from './rules'
import type { HallGameState } from './gamestate'
import type { GameModule } from './module'

export type PeerRole = 'host' | 'player'

export interface MemberInfo {
  peerId: string
  name: string // 房间昵称
  role: PeerRole
  charName: string // 临时角色名
  persona: string // 一句话人设
}

/** 分线（剧情线）：party = 全体主线（内置，不存表）；自定义线覆盖个人线与合作线（如「图书馆二人组」） */
export interface HallScene {
  id: string
  name: string
  /** 绑定成员（charName || 房间昵称），纯展示与 KP 动向提示；不限制谁能在该线发言 */
  member: string
  /** 叙述者（charName || 房间昵称）：这条线的 KP 旁白由谁的本机 API 生成、谁付 token；空 = 房主 */
  generator?: string
  /** 收线后仍在页签里可回看，可重开 */
  closed: boolean
}

/** 内置主线 id：事件不带 scene 字段即视为全体线（老存档天然兼容） */
export const PARTY_LINE = 'party'

export function sceneNameOf(scenes: HallScene[], id: string): string {
  return id === PARTY_LINE ? '全体' : scenes.find((s) => s.id === id)?.name || '未知线'
}

/** 某条线的叙述者显示名：自定义线看 generator，缺省/全体线 = 房主（计费归属的单一事实源） */
export function sceneNarrator(scenes: HallScene[], id: string, hostName = '房主'): string {
  if (id !== PARTY_LINE) {
    const s = scenes.find((x) => x.id === id)
    if (s?.generator?.trim()) return s.generator.trim()
  }
  return hostName
}

export type RoomEvent =
  /** 入场自我介绍（join/create 后各发一次，成员表据此建立） */
  | { k: 'hello'; member: Omit<MemberInfo, 'peerId'> }
  /** 玩家发言（含描述动作/台词，KP 视为剧情输入）；scene 缺省 = 全体线 */
  | { k: 'chat'; id: string; from: string; name: string; charName: string; text: string; at: number; scene?: string }
  /** 旁白（房主手动，或 KP 的叙事产出）；scene 缺省 = 全体线 */
  | { k: 'narration'; id: string; text: string; at: number; scene?: string }
  /** 检定结果（明骰，全员可见）；scene 缺省 = 全体线 */
  | { k: 'roll'; id: string; name: string; charName: string; expr: string; detail: string; total: number; at: number; scene?: string }
  /** 系统事件（成员进出、房间状态、叙述计费留痕等） */
  | { k: 'system'; id: string; text: string; at: number; scene?: string }
  /** 命运转盘抽取结果（模组随机表，明牌全员可见并进剧情流，KP 据此融入剧情）；scene 缺省 = 全体线 */
  | { k: 'wheel'; id: string; name: string; charName: string; tableId: string; tableName: string; label: string; note: string; at: number; scene?: string }
  /** 战局状态全量广播（当前区域/道具/记忆，KP 自动维护或房主手动改）；事件本身不落库——权威值存房主战役文档 */
  | { k: 'state'; state: HallGameState }
  /** 成员叙述者的战局上报：交给房主校验合并（战局权威仍在房主），合并后以 state 广播 */
  | { k: 'state-propose'; state: HallGameState }
  /** 分线表全量广播（房主建线/收线/重开时发）；不落库——权威值存房主战役文档 */
  | { k: 'scene-sync'; scenes: HallScene[] }
  /** KP 流式生成的临时帧：不落库，结束后以 narration 定稿；scene 标明这轮叙事属于哪条线 */
  | { k: 'kp-start'; id: string; at: number; scene?: string }
  | { k: 'kp-chunk'; id: string; delta: string }
  | { k: 'kp-end'; id: string; aborted?: boolean }
  /** 新成员向房主要战役快照（定向直发） */
  | { k: 'sync-request' }
  /** 房主回快照：全量剧情事件 + 成员名单（含 peerId，供成员表对齐）+ 开团设定（成员只读展示）+ 战局状态 + 分线表 + 世界观备注（成员叙述者生成要用）+ 剧情模组定义 */
  | { k: 'sync'; events: RoomEvent[]; members: MemberInfo[]; setting?: RoomSetting | null; state?: HallGameState | null; scenes?: HallScene[]; worldNote?: string; module?: GameModule | null }

export type RoomEventK = RoomEvent['k']

/** 需要永久进入剧情流（房主落库、快照回放）的事件类型 */
export const PERSISTED_KINDS: readonly RoomEventK[] = ['chat', 'narration', 'roll', 'system', 'wheel']

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
  /** 详细模式的开团设定（创建时填写，仅存房主本地 + E2EE 快照同步，不出中继） */
  setting: RoomSetting | null
  /** 战局状态：当前区域/道具/关键记忆（KP 自动维护 + 房主手动编辑；缺省视为空，老存档天然兼容） */
  state?: HallGameState | null
  /** 分线表（缺省 = 只有全体主线，老存档天然兼容） */
  scenes?: HallScene[]
  /** 剧情模组定义（创建时从模组库挂载；缺省 = 无模组自由团，老存档天然兼容） */
  module?: GameModule | null
  /** 中继模式（老存档缺省：跟随「我的中继」设置） */
  relay?: HallRelayMode
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

/** 房间中继模式：local = 单机团（本机回环中继，无其他成员）；shared = 公共共享中继（开在「我的中继」）；private = 房主自己的中继（不在公共列表，凭邀请链接进入） */
export type HallRelayMode = 'shared' | 'private' | 'local'

/** 公共共享中继默认地址（已停用：站主服务器 2026-09-13 下线）。留空 = 未配置联机，大厅与共享房间不可用，单机团不受影响 */
export const DEFAULT_HALL_RELAY = ''
