/**
 * 在线跑团房间状态机（单例 composable）。
 *
 * 角色划分：房主 = 权威节点，持有战役、执行 KP 流式生成（复用主站模型设置与 streamChat）、
 * 给中途加入者补发快照；中继只转发端到端密文与房间公开元数据（标题/简介/封面/是否上锁），
 * 服务器零存储。上锁房间密钥种子 = 房间码:密码，密码不出本机。
 * 联机不可用时可选「单机团」：LocalRelay 本机回环中继顶替 WebSocket，协议与持久化路径完全一致。
 */
import { computed, reactive } from 'vue'
import { deriveRoomKey, keyProof, genRoomCode, openEvent, sealEvent, roomSecret } from './crypto'
import { isPersisted, newEventId, PARTY_LINE, type HallCampaign, type HallRelayMode, type HallScene, type MemberInfo, type RoomEvent, type RoomMeta } from './protocol'
import { LocalRelay, LOCAL_RELAY_URL, RS_CONNECTING, RS_OPEN, type RelaySocket } from './localRelay'
import { formatRoll, rollDice } from './dice'
import { buildKpMessages, buildRollNudge, extractRollRequests, extractStateUpdate, lineOf, renderSceneBlock, stripKpOutput } from './kp'
import { emptySetting, KP_STYLES, RULE_PRESETS, type RoomSetting } from './rules'
import { emptyGameState, mergeStateUpdate, normalizeGameState, sameGameState, type HallGameState, type StateUpdate } from './gamestate'
import { emptyProgress, extractModuleUpdate, MAX_FLAGS, mergeProgressUpdate, normalizeModule, normalizeProgress, pickWeighted, type GameModule } from './module'
import { streamChat, type ApiConfig } from '../api'
import { useSettingsStore } from '../../stores/settings'
import { db } from '../../db'
import { deepPlain } from '../plain'

export type Phase = 'idle' | 'connecting' | 'room' | 'closed' | 'error'
export type LobbyStatus = 'off' | 'connecting' | 'on'

export interface Profile {
  name: string // 房间昵称
  charName: string // 临时角色名
  persona: string // 一句话人设
}

export interface CreateMeta {
  title: string
  desc: string
  cover: string // data:image URI 或空
  locked: boolean
  /** 详细模式的开团设定（只走房主本地持久化与 E2EE 同步，不发给中继） */
  setting?: RoomSetting | null
  /** 剧情模组（创建时从模组库挂载或导入；只走房主本地持久化与 E2EE 同步，不发给中继） */
  module?: GameModule | null
  /** 中继模式：local = 单机团（默认）；shared = 公共共享中继；private = 房主自己的中继，凭邀请链接进入 */
  relay?: HallRelayMode
}

const LS_PROFILE = 'hall.profile'

// ── 战役持久化（主站 Dexie 的 campaigns 表，仅房主写入）──

export function newCampaign(name: string, roomCode: string, meta?: Partial<CreateMeta>, password = ''): HallCampaign {
  return {
    id: newEventId(),
    name: name || '新战役',
    roomCode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    events: [],
    worldNote: '',
    scenes: [],
    locked: meta?.locked ?? false,
    password,
    desc: meta?.desc ?? '',
    cover: meta?.cover ?? '',
    setting: meta?.setting ?? null,
    module: meta?.module ?? null,
    relay: meta?.relay ?? 'local',
  }
}

export async function appendEvents(campaign: HallCampaign, events: RoomEvent[]): Promise<HallCampaign> {
  campaign.events.push(...events)
  if (campaign.events.length > 2000) campaign.events.splice(0, campaign.events.length - 2000)
  campaign.updatedAt = Date.now()
  await db.campaigns.put(deepPlain(campaign))
  return campaign
}

export async function saveCampaign(campaign: HallCampaign): Promise<void> {
  campaign.updatedAt = Date.now()
  await db.campaigns.put(deepPlain(campaign))
}

export async function listCampaigns(): Promise<HallCampaign[]> {
  return db.campaigns.orderBy('updatedAt').reverse().toArray()
}

/** 删除本地战役（房主动作，剧情记录不可恢复） */
export async function deleteCampaign(id: string): Promise<void> {
  await db.campaigns.delete(id)
  hall.campaigns = hall.campaigns.filter((c) => c.id !== id)
}

/**
 * 保留最近 keep 场战役，删除更旧的（updatedAt 降序第 keep 场之后）。
 * keep <= 0 视为全部保留；protectId 指定的战役（如正在房内的当前战役）永不删除。
 * 返回删除的场数。
 */
export async function pruneCampaigns(keep: number, protectId = ''): Promise<number> {
  if (!Number.isFinite(keep) || keep <= 0) return 0
  const all = await listCampaigns()
  if (all.length <= keep) return 0
  const doomed = all.slice(keep).filter((c) => c.id !== protectId)
  for (const c of doomed) await db.campaigns.delete(c.id)
  hall.campaigns = await listCampaigns()
  return doomed.length
}

// ── 中继地址与玩家档案 ──

function wsSameOrigin(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

/** 我的中继：大厅列表与共享房间连接的地址；留空 = 未配置联机（单机团不受影响） */
export function myRelayUrl(): string {
  const s = useSettingsStore()
  return s.settings.hallWsUrl.trim()
}

/** 私人中继：房主自己的；留空 = 同源 /ws（自托管站点可用；GitHub Pages 部署必须填写） */
export function ownRelayUrl(): string {
  const s = useSettingsStore()
  return s.settings.hallWsUrl.trim() || wsSameOrigin()
}

/** 房间实际使用的中继：local = 本机单机中继，shared = 「我的中继」，private = 房主自己的，未标记（老存档）= 跟随我的设置 */
export function relayOfRoom(mode: HallRelayMode | null | undefined): string {
  if (mode === 'local') return LOCAL_RELAY_URL
  if (mode === 'shared') return myRelayUrl()
  if (mode === 'private') return ownRelayUrl()
  return myRelayUrl()
}

// ── 邀请链接：?join=房间码&relay=中继地址&l=1（私人房间 / 跨中继进房的唯一入口）──

export interface InviteInfo {
  code: string
  relay: string
  locked: boolean
}

/** 拼邀请链接（relay 原样编码进参数，成员端不必预先配置任何中继地址） */
export function buildInviteLink(origin: string, path: string, code: string, relayUrl: string, locked: boolean): string {
  const u = new URL(origin + path)
  u.searchParams.set('join', code)
  if (relayUrl) u.searchParams.set('relay', relayUrl)
  if (locked) u.searchParams.set('l', '1')
  return u.toString()
}

/** 解析邀请链接参数；房间码不合法返回 null */
export function parseInvite(search: string): InviteInfo | null {
  const q = new URLSearchParams(search)
  const code = (q.get('join') || '').toLowerCase()
  if (!/^[a-z0-9]{6}$/.test(code)) return null
  return { code, relay: q.get('relay') || '', locked: q.get('l') === '1' }
}

/** App 启动期解析邀请链接（地址栏立即清理，避免刷新重复弹窗）；进大厅页后消费，只弹一次 */
let pendingBootInvite: InviteInfo | null = typeof location !== 'undefined' ? parseInvite(location.search) : null
if (typeof location !== 'undefined' && pendingBootInvite) history.replaceState(null, '', location.pathname)

export function hasBootInvite(): boolean {
  return pendingBootInvite !== null
}

export function consumeBootInvite(): InviteInfo | null {
  const inv = pendingBootInvite
  pendingBootInvite = null
  return inv
}

function loadProfile(): Profile {
  try {
    const j = JSON.parse(localStorage.getItem(LS_PROFILE) || '{}')
    return { name: j.name || '', charName: j.charName || '', persona: j.persona || '' }
  } catch {
    return { name: '', charName: '', persona: '' }
  }
}

/** KP 模型配置：优先用跑团「模型设置」里的专用配置（只对跑团生效）；未启用或未填完整时回退主站「语言模型」当前激活槽位。
 *  除 KP 生成外，开团弹窗内 AI 锻造剧情模组也复用这份配置（烧谁的 key 与叙述生成同源）。 */
export function kpApiConfig(): ApiConfig | null {
  const s = useSettingsStore()
  const h = s.settings.hallModel
  if (h?.enabled && h.baseUrl.trim() && h.apiKey.trim() && h.model.trim()) {
    return {
      baseUrl: h.baseUrl.trim(),
      apiKey: h.apiKey.trim(),
      model: h.model.trim(),
      temperature: h.temperature,
      maxTokens: h.maxTokens,
      reasoningEffort: h.reasoningEffort,
    }
  }
  const model = s.settings.modelSlots?.[s.settings.activeSlot]?.model || ''
  if (!s.settings.apiBaseUrl || !s.settings.apiKey || !model) return null
  return {
    baseUrl: s.settings.apiBaseUrl,
    apiKey: s.settings.apiKey,
    model,
    temperature: s.settings.temperature,
    maxTokens: s.settings.maxTokens,
    reasoningEffort: s.settings.reasoningEffort,
  }
}

// ── 状态 ──

const state = reactive({
  phase: 'idle' as Phase,
  error: '',
  roomCode: '',
  /** 房间实际使用的中继地址（邀请链接用）；房主/成员在 connect 时各自解析 */
  roomRelay: '',
  /** 房间是否上锁（房主来自创建/存档；成员来自邀请链接参数） */
  roomLocked: false,
  isHost: false,
  myPeerId: '',
  members: {} as Record<string, MemberInfo>,
  events: [] as RoomEvent[],
  streaming: null as { id: string; text: string; scene: string } | null,
  /** 分线表（party 主线内置不存表）；房主来自战役，成员经 scene-sync/快照同步 */
  scenes: [] as HallScene[],
  /** 世界观备注镜像（成员叙述者生成 KP 上下文要用；房主来自战役，成员经快照同步） */
  worldNote: '',
  /** 本机正在查看的线（只影响本机视图与发言落点，不广播） */
  currentScene: PARTY_LINE,
  campaignName: '',
  kpBusy: false,
  /** 开团设定（房主来自战役，成员来自快照同步；成员只读） */
  setting: null as RoomSetting | null,
  /** 战局状态（当前区域/道具/记忆）：房主来自战役并落库，成员经 state 事件/快照实时同步 */
  gameState: null as HallGameState | null,
  /** 剧情模组定义：房主来自战役，成员经快照同步（进度在 gameState.progress 里） */
  module: null as GameModule | null,
})

const lobby = reactive({
  status: 'off' as LobbyStatus,
  rooms: [] as RoomMeta[],
})

let ws: RelaySocket | null = null // 房间连接（真实 WebSocket 或单机 LocalRelay）
let lobbyWs: RelaySocket | null = null // 大厅列表连接
let lobbyRetry: ReturnType<typeof setTimeout> | null = null
let key: CryptoKey | null = null
let campaign: HallCampaign | null = null // 仅房主持有
let kpAbort: { abort: () => void } | null = null
let kpTimer: ReturnType<typeof setTimeout> | null = null
let profile: Profile = loadProfile()
let pendingInit: { campaignId?: string; meta?: CreateMeta; password: string } | null = null

export const hall = {
  state,
  lobby,
  profile,
  memberList: computed(() => Object.values(state.members)),
  campaigns: [] as HallCampaign[],
}

function myMember(): MemberInfo {
  return {
    peerId: state.myPeerId,
    name: profile.name,
    role: state.isHost ? 'host' : 'player',
    charName: profile.charName,
    persona: profile.persona,
  }
}

function roster(): MemberInfo[] {
  return Object.values(state.members)
}

// ── 大厅：在线房间列表 ──

export function connectLobby() {
  if (lobbyWs && (lobbyWs.readyState === RS_OPEN || lobbyWs.readyState === RS_CONNECTING)) return
  const url = myRelayUrl()
  if (!url) {
    // 未配置联机中继：大厅保持离线，不重试（单机团不经过这里）
    lobby.status = 'off'
    lobby.rooms = []
    return
  }
  lobby.status = 'connecting'
  try {
    lobbyWs = new WebSocket(url) as unknown as RelaySocket
  } catch {
    lobby.status = 'off'
    return
  }
  lobbyWs.onopen = () => {
    lobby.status = 'on'
    lobbyWs!.send(JSON.stringify({ t: 'list' }))
  }
  lobbyWs.onmessage = (ev) => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(ev.data as string) } catch { return }
    if (msg.t === 'rooms') {
      lobby.rooms = (msg.rooms as RoomMeta[]) || []
    } else if (msg.t === 'rooms-changed') {
      lobbyWs?.send(JSON.stringify({ t: 'list' }))
    } else if (msg.t === 'error') {
      lobby.status = 'on' // 列表请求出错不致命，保持连接
    }
  }
  lobbyWs.onclose = () => {
    lobby.status = 'off'
    lobby.rooms = []
    // 大厅开着时自动重连（房主退出/关房后回到列表页）
    if (!state.isHost && state.phase !== 'room') {
      lobbyRetry = setTimeout(() => connectLobby(), 2000)
    }
  }
  lobbyWs.onerror = () => { /* close 兜底 */ }
}

export function disconnectLobby() {
  if (lobbyRetry) clearTimeout(lobbyRetry)
  lobbyRetry = null
  try { lobbyWs?.close() } catch { /* noop */ }
  lobbyWs = null
  lobby.status = 'off'
  lobby.rooms = []
}

// ── 收发 ──

async function sendEvent(e: RoomEvent, to?: string): Promise<void> {
  if (!key || !ws || ws.readyState !== ws.OPEN) return
  const payload = await sealEvent(key, e)
  ws.send(JSON.stringify(to ? { t: 'relay-to', to, payload } : { t: 'relay', payload }))
}

function appendLocal(e: RoomEvent) {
  state.events.push(e)
  if (state.isHost && campaign && isPersisted(e)) void appendEvents(campaign, [e])
}

async function handleEvent(e: RoomEvent, from: string) {
  switch (e.k) {
    case 'hello':
      state.members[from] = { ...e.member, peerId: from }
      break
    case 'chat': {
      appendLocal(e)
      // 谁是这条线的叙述者，谁就在本机触发 KP 生成（房主收到成员发言同理——原先只有房主自己的发言会触发）
      const line = lineOf(e)
      if (isLineNarrator(line)) scheduleKp(line)
      break
    }
    case 'narration':
    case 'roll':
    case 'system':
      appendLocal(e)
      break
    case 'kp-start':
      state.streaming = { id: e.id, text: '', scene: e.scene || PARTY_LINE }
      touchStreamWatch()
      break
    case 'kp-chunk':
      if (state.streaming?.id === e.id) {
        state.streaming.text += e.delta
        touchStreamWatch()
      }
      break
    case 'kp-end':
      if (state.streaming?.id === e.id) state.streaming = null
      break
    case 'sync-request':
      if (state.isHost && campaign) {
        void sendEvent({ k: 'sync', events: [...campaign.events], members: roster(), setting: campaign.setting, state: campaign.state ?? null, scenes: campaign.scenes ?? [], worldNote: campaign.worldNote, module: campaign.module ?? null }, from)
      }
      break
    case 'sync': {
      if (e.events.length > state.events.length) {
        state.events.splice(0, state.events.length, ...e.events)
      }
      for (const m of e.members) state.members[m.peerId] = { ...m }
      if (e.setting) state.setting = e.setting
      state.gameState = e.state ? normalizeGameState(e.state) : null
      state.scenes = e.scenes ? [...e.scenes] : []
      if (e.worldNote !== undefined) state.worldNote = e.worldNote
      if (e.module !== undefined) state.module = e.module ? normalizeModule(e.module) : null
      break
    }
    case 'state':
      state.gameState = normalizeGameState(e.state)
      break
    case 'scene-sync':
      state.scenes = [...e.scenes]
      break
    case 'state-propose':
      // 成员叙述者的战局上报：房主校验合并（权威在房主），再以 state 广播回全员
      if (state.isHost && campaign) await commitGameState(normalizeGameState(e.state))
      break
  }
}

// ── 连接生命周期 ──

export async function connect(opts: {
  mode: 'create' | 'join'
  code?: string
  profile: Profile
  campaignId?: string // create + campaignId = 恢复指定战役（沿用其剧情/房间码）；不带 = 全新战役
  meta?: CreateMeta // create 时携带（title/desc/cover/locked/setting/relay）
  password?: string // create+locked 或 join 上锁房间时必填
  relayOverride?: string // 邀请链接携带的中继地址：私人房间 / 跨中继进房用，优先级最高
}) {
  if (state.phase === 'connecting' || state.phase === 'room') return
  profile = opts.profile
  localStorage.setItem(LS_PROFILE, JSON.stringify(profile))
  if (!profile.name.trim()) {
    state.phase = 'error'
    state.error = '请先填一个房间昵称'
    return
  }

  const code = (opts.mode === 'create' ? opts.code || genRoomCode() : opts.code || '').trim().toLowerCase()
  if (opts.mode === 'create' && code.length !== 6) {
    state.phase = 'error'
    state.error = '房间码是 6 位字符'
    return
  }

  const password = opts.password || ''
  const locked = opts.mode === 'create' ? !!opts.meta?.locked : !!password
  // 中继解析：邀请链接 > 房间中继模式（恢复战役读存档标记，老存档跟随「我的中继」）
  let relayMode: HallRelayMode | null = opts.meta?.relay ?? null
  if (opts.mode === 'create' && opts.campaignId) {
    const prior = await db.campaigns.get(opts.campaignId)
    if (prior) relayMode = prior.relay ?? null
  }
  const relayUrl = opts.relayOverride?.trim() || relayOfRoom(relayMode)
  const secret = roomSecret(code, locked ? password : '')
  state.phase = 'connecting'
  state.error = ''
  state.roomLocked = locked
  key = await deriveRoomKey(secret)
  pendingInit = { campaignId: opts.campaignId, meta: opts.meta, password }

  const frame: Record<string, unknown> = opts.mode === 'create'
    // setting 不出本机/中继只收公开元数据：发信令帧前剥掉
    ? { t: 'create', code, meta: opts.meta
        ? { title: opts.meta.title, desc: opts.meta.desc, cover: opts.meta.cover, locked: opts.meta.locked }
        : { title: '未命名房间', desc: '', cover: '', locked: false } }
    : { t: 'join', code }
  if (locked) frame.proof = await keyProof(secret)

  state.roomRelay = relayUrl
  if (relayUrl === LOCAL_RELAY_URL) {
    // 单机团：本机回环中继，握手与信令路由在本进程内完成
    ws = new LocalRelay()
  } else {
    if (!relayUrl) {
      state.phase = 'error'
      state.error = '未配置联机中继——单机团请在创建房间时选「单机团」；要联机先在「模型 → 高级」里填好「我的中继」地址'
      return
    }
    try {
      ws = new WebSocket(relayUrl) as unknown as RelaySocket
    } catch (err) {
      state.phase = 'error'
      state.error = `无法连接中继：${(err as Error).message}`
      return
    }
  }

  ws.onopen = () => ws!.send(JSON.stringify(frame))
  ws.onmessage = (ev) => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(ev.data as string) } catch { return }
    onSignal(msg)
  }
  ws.onclose = () => {
    if (state.phase === 'room') {
      state.phase = 'closed'
      state.error = '与中继的连接已断开'
    }
    connectLobby() // 房间结束后回大厅自动刷新列表
  }
  ws.onerror = () => {
    if (state.phase !== 'room') {
      state.phase = 'error'
      state.error = '无法连接中继服务器——请确认中继已启动，并在跑团设置里填好中继地址'
    }
  }
}

function onSignal(msg: Record<string, unknown>) {
  switch (msg.t) {
    case 'created': {
      state.roomCode = String(msg.code)
      state.myPeerId = String(msg.peerId)
      state.isHost = true
      state.members[state.myPeerId] = myMember()
      void enterRoomAsHost()
      break
    }
    case 'joined': {
      state.roomCode = String(msg.code)
      state.myPeerId = String(msg.peerId)
      state.isHost = false
      state.members[state.myPeerId] = myMember()
      state.phase = 'room'
      void sendEvent({ k: 'hello', member: stripPeer(myMember()) })
      void sendEvent({ k: 'sync-request' }, String(msg.hostId))
      break
    }
    case 'error': {
      state.phase = 'error'
      state.error = String(msg.msg || '未知错误')
      try { ws?.close() } catch { /* noop */ }
      break
    }
    case 'room-closed': {
      state.phase = 'closed'
      state.error = String(msg.reason || '房间已关闭')
      break
    }
    case 'relay': {
      if (!key) return
      void openEvent<RoomEvent>(key, String(msg.payload))
        .then((e) => handleEvent(e, String(msg.from)))
        .catch(() => { /* 密钥不匹配的帧：丢弃 */ })
      break
    }
    default:
      break
  }
}

function stripPeer(m: MemberInfo): Omit<MemberInfo, 'peerId'> {
  const { peerId: _p, ...rest } = m
  return rest
}

/** 房主就位：按 campaignId 恢复战役（未带则开全新战役），进房并自我介绍 */
async function enterRoomAsHost() {
  const resumeId = pendingInit?.campaignId
  campaign = resumeId ? ((await db.campaigns.get(resumeId)) || null) : null
  const meta = pendingInit?.meta
  if (!campaign) {
    campaign = newCampaign(meta?.title || '新战役', state.roomCode, meta, pendingInit?.password || '')
  } else {
    // 恢复战役：剧情/设定沿用存档，仅同步本次的锁与密码；未带 meta 时保持原样
    if (meta) {
      campaign.locked = meta.locked ?? campaign.locked
      campaign.password = pendingInit?.password || campaign.password
      if (meta.setting) campaign.setting = meta.setting
    }
    state.campaignName = campaign.name
  }
  // 每次进房都落库一次：确保新战役的房间名/团设即使零剧情也不丢
  await saveCampaign(campaign)
  void pruneCampaigns(useSettingsStore().settings.hallKeepCampaigns || 0, campaign.id)
  if (!campaign.worldNote) campaign.worldNote = localStorage.getItem('hall.worldNote') || ''
  state.campaignName = campaign.name
  state.setting = campaign.setting ? { ...campaign.setting, tones: [...campaign.setting.tones] } : null
  state.gameState = campaign.state ? normalizeGameState(campaign.state) : null
  state.module = campaign.module ? normalizeModule(campaign.module) : null
  state.scenes = campaign.scenes ? campaign.scenes.map((s) => ({ ...s })) : []
  state.worldNote = campaign.worldNote
  state.currentScene = PARTY_LINE
  state.events.splice(0, state.events.length, ...campaign.events)
  state.phase = 'room'
  // 新战役配了开场白：作为第一段旁白发出（随事件持久化，后进房成员经快照可见）
  if (campaign.events.length === 0 && campaign.setting?.openingNarration.trim()) {
    const opening: RoomEvent = { k: 'narration', id: newEventId(), text: campaign.setting.openingNarration.trim(), at: Date.now() }
    appendLocal(opening)
    await sendEvent(opening)
  }
  await sendEvent({ k: 'hello', member: stripPeer(myMember()) })
}

export function leaveRoom() {
  try { ws?.close() } catch { /* noop */ }
  kpAbort?.abort()
  if (kpTimer) clearTimeout(kpTimer)
  ws = null
  key = null
  campaign = null
  state.phase = 'idle'
  state.error = ''
  state.roomCode = ''
  state.members = {}
  state.events.splice(0, state.events.length)
  state.streaming = null
  state.isHost = false
  state.kpBusy = false
  state.setting = null
  state.gameState = null
  state.module = null
  state.scenes = []
  state.worldNote = ''
  state.currentScene = PARTY_LINE
  state.roomRelay = ''
  state.roomLocked = false
  // 房主离开即关房，回大厅
  connectLobby()
}

export async function refreshCampaigns() {
  hall.campaigns = await listCampaigns()
}

// ── 玩家动作（scene 缺省 = 全体主线；自定义线时事件带 scene 字段）──

/** 事件落线：party 主线不带 scene 字段，保持与老事件/老存档同构 */
function lineTag(scene: string): string | undefined {
  return scene === PARTY_LINE ? undefined : scene
}

export async function sendChat(text: string, scene = PARTY_LINE) {
  const t = text.trim()
  if (!t || state.phase !== 'room') return
  const e: RoomEvent = {
    k: 'chat', id: newEventId(), from: state.myPeerId,
    name: profile.name, charName: profile.charName, text: t, at: Date.now(),
    scene: lineTag(scene),
  }
  appendLocal(e)
  await sendEvent(e)
  // 自己的帧不会被中继回显：本机触发交给这里，别人的发言由 handleEvent 触发
  if (isLineNarrator(scene)) scheduleKp(scene)
}

export async function sendNarration(text: string, scene = PARTY_LINE) {
  const t = text.trim()
  if (!t || state.phase !== 'room') return
  const e: RoomEvent = { k: 'narration', id: newEventId(), text: t, at: Date.now(), scene: lineTag(scene) }
  appendLocal(e)
  await sendEvent(e)
}

export async function sendRoll(expr: string, scene = PARTY_LINE): Promise<string | null> {
  try {
    const r = rollDice(expr)
    const e: RoomEvent = {
      k: 'roll', id: newEventId(), name: profile.name, charName: profile.charName,
      expr: r.expr, detail: formatRoll(r), total: r.total, at: Date.now(),
      scene: lineTag(scene),
    }
    appendLocal(e)
    await sendEvent(e)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/** 命运转盘：本机对模组随机表做加权抽取，结果以 wheel 事件明牌广播（全员可见、进剧情流，KP 会读到） */
export async function sendWheel(tableId: string, scene = PARTY_LINE): Promise<string | null> {
  if (state.phase !== 'room') return null
  const table = state.module?.tables.find((t) => t.id === tableId)
  if (!table) return '找不到这张随机表'
  const picked = pickWeighted(table.entries)
  if (!picked) return '这张随机表还没有条目'
  const e: RoomEvent = {
    k: 'wheel', id: newEventId(), name: profile.name, charName: profile.charName,
    tableId: table.id, tableName: table.name, label: picked.label, note: picked.note, at: Date.now(),
    scene: lineTag(scene),
  }
  appendLocal(e)
  await sendEvent(e)
  return null
}

export async function saveWorldNote(note: string) {
  localStorage.setItem('hall.worldNote', note)
  if (campaign) {
    campaign.worldNote = note
    await saveCampaign(campaign)
  }
}

export function loadWorldNote(): string {
  return localStorage.getItem('hall.worldNote') || campaign?.worldNote || ''
}

// ── 叙述者路由：每条线的 KP 旁白由谁的本机 API 生成、谁付 token ──

/** 本机在房间里的成员标识（与 scene.generator 同一口径） */
function myName(): string {
  return profile.charName || profile.name
}

/** 这条线的叙述者是不是本机：缺省/全体线 = 房主；指派了成员则按成员标识匹配 */
export function isLineNarrator(line = state.currentScene || PARTY_LINE): boolean {
  const s = state.scenes.find((x) => x.id === line)
  const gen = s?.generator?.trim() || ''
  if (!gen) return state.isHost
  return gen === myName()
}

/** ── 战局状态（当前区域/道具/记忆）：KP 自动维护 + 房主手动编辑，全量广播 ── */

/** 提交一份战局状态：落房主战役文档 + 同步到本机 UI + 全量广播全员（无实质变化则跳过） */
async function commitGameState(next: HallGameState): Promise<void> {
  if (!state.isHost || !campaign) return
  if (sameGameState(campaign.state, next)) return
  campaign.state = next
  state.gameState = next
  await saveCampaign(campaign)
  await sendEvent({ k: 'state', state: next })
}

/** 房主手动改战局：在当前状态副本上应用变更并提交 */
async function editGameState(mutate: (s: HallGameState) => void): Promise<void> {
  if (!state.isHost || !campaign) return
  const s = normalizeGameState(campaign.state ?? emptyGameState())
  mutate(s)
  s.updatedAt = Date.now()
  await commitGameState(s)
}

/** 把一次状态变更合并进当前战局（KP 自动维护走这里） */
async function mergeGameState(upd: StateUpdate): Promise<void> {
  if (!state.isHost || !campaign) return
  await commitGameState(mergeStateUpdate(campaign.state ?? null, upd))
}

/** 设置当前所在区域（房主侧栏手动改） */
export async function setGameArea(area: string): Promise<void> {
  await editGameState((s) => { s.area = area.trim().slice(0, 60) })
}

export async function addGameItem(name: string, note = ''): Promise<void> {
  if (!name.trim()) return
  await mergeGameState({ add: [{ name, note }] })
}

export async function removeGameItem(id: string): Promise<void> {
  await editGameState((s) => { s.items = s.items.filter((x) => x.id !== id) })
}

export async function addGameMemory(text: string): Promise<void> {
  if (!text.trim()) return
  await mergeGameState({ mem: [text] })
}

export async function removeGameMemory(id: string): Promise<void> {
  await editGameState((s) => { s.memories = s.memories.filter((x) => x.id !== id) })
}

// ── 剧情模组进度：存在战局状态 progress 里，随 state 事件同步与持久化；房主可手动微调 ──

export async function setProgressChapter(chapterId: string): Promise<void> {
  await editGameState((s) => { s.progress = mergeProgressUpdate(s.progress, { chapter: chapterId }) })
}

export async function setProgressDay(day: number): Promise<void> {
  const d = Math.max(0, Math.round(Number(day) || 0))
  await editGameState((s) => { s.progress = mergeProgressUpdate(s.progress, { day: d }) })
}

export async function setProgressRoute(routeId: string): Promise<void> {
  await editGameState((s) => { s.progress = mergeProgressUpdate(s.progress, { route: routeId }) })
}

/** 增/删一个关键旗标（已存在则删除） */
export async function toggleProgressFlag(flag: string): Promise<void> {
  const f = flag.trim().slice(0, 40)
  if (!f) return
  await editGameState((s) => {
    const cur = s.progress ? normalizeProgress(s.progress) : emptyProgress()
    const flags = cur.flags.includes(f)
      ? cur.flags.filter((x) => x !== f)
      : [...cur.flags, f].slice(Math.max(0, cur.flags.length + 1 - MAX_FLAGS))
    s.progress = normalizeProgress({ ...cur, flags })
  })
}

/** 开新周目：清空模组进度（章节/天数/路线/旗标/终局），模组定义与剧情流保留 */
export async function resetProgress(): Promise<void> {
  await editGameState((s) => { s.progress = undefined })
}

// ── 分线（剧情线）：房主建线/收线/重开，全量广播；party 主线内置不存表 ──

async function commitScenes(scenes: HallScene[]): Promise<void> {
  if (!state.isHost || !campaign) return
  campaign.scenes = scenes
  state.scenes = scenes.map((s) => ({ ...s }))
  await saveCampaign(campaign)
  await sendEvent({ k: 'scene-sync', scenes })
}

/** 开一条新线（叙述者选房主=空，或指派给某成员=成员本机 API 生成）；指派成员同时作为线的绑定展示 */
export async function createScene(name: string, generator = ''): Promise<void> {
  const n = name.trim().slice(0, 24)
  if (!n || !state.isHost || !campaign) return
  const scenes = [...(campaign.scenes ?? [])]
  if (scenes.length >= 12) return
  const gen = generator.trim().slice(0, 24)
  scenes.push({ id: newEventId(), name: n, member: gen, generator: gen, closed: false })
  await commitScenes(scenes)
}

/** 收线/重开：事件保留可回看，页签置灰 */
export async function setSceneClosed(id: string, closed: boolean): Promise<void> {
  if (!state.isHost || !campaign) return
  const scenes = (campaign.scenes ?? []).map((s) => (s.id === id ? { ...s, closed } : s))
  await commitScenes(scenes)
}

/** 改叙述者（随时收回给房主：传空即收回）；指派成员同时更新绑定展示 */
export async function setSceneGenerator(id: string, generator: string): Promise<void> {
  if (!state.isHost || !campaign) return
  const gen = generator.trim().slice(0, 24)
  const scenes = (campaign.scenes ?? []).map((s) => (s.id === id ? { ...s, generator: gen || undefined, member: gen } : s))
  await commitScenes(scenes)
}

// ── KP 生成（按线路由到叙述者本机：房主线在房主机子上跑，指派成员的个人线在成员机子上跑，各自烧各自 key）──

/** 待生成的线：玩家在哪条线发言，这条线的叙述者就续哪条线（scene 闭包捕获） */
function scheduleKp(scene = PARTY_LINE) {
  if (kpTimer) clearTimeout(kpTimer)
  kpTimer = setTimeout(() => void generateKp(scene), 1200)
}

// 流式看门狗：叙述者掉线/无响应时，观众端的流式气泡不至于永远转下去
let streamWatch: ReturnType<typeof setTimeout> | null = null
let streamTouchAt = 0
function touchStreamWatch() {
  streamTouchAt = Date.now()
  if (streamWatch) clearTimeout(streamWatch)
  streamWatch = setTimeout(() => {
    streamWatch = null
    if (state.streaming && Date.now() - streamTouchAt > 35_000) {
      state.streaming = null
      state.error = '叙述流中断：叙述者可能掉线或没有响应（这条线的剧情没有写完）'
    }
  }, 40_000)
}

/** 粗估 token 数：中英混合按 ~2 字符/token 计（仅用于房间内计费展示，不是账单） */
function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 2))
}

export async function generateKp(scene = state.currentScene || PARTY_LINE) {
  const line = scene || PARTY_LINE
  if (state.kpBusy || state.phase !== 'room' || !isLineNarrator(line)) return
  const cfg = kpApiConfig()
  if (!cfg) {
    state.error = '你还不能在这条线叙述：请先在跑团「模型设置」或「更多 → 语言模型」里配置你自己的 API 地址、密钥与模型'
    return
  }
  // 上下文取本机镜像：房主用战役权威值，成员用快照同步来的镜像（同步字段见 protocol.sync）
  const isHostRun = state.isHost && !!campaign
  const src = isHostRun && campaign
    ? { events: campaign.events, worldNote: campaign.worldNote, setting: campaign.setting, scenes: campaign.scenes ?? [], game: campaign.state, module: campaign.module ?? null }
    : { events: state.events, worldNote: state.worldNote, setting: state.setting, scenes: state.scenes, game: state.gameState, module: state.module }
  const sceneName = line === PARTY_LINE ? '全体' : src.scenes.find((s) => s.id === line)?.name || '未知线'
  const narratorName = src.scenes.find((s) => s.id === line)?.generator?.trim() || '房主'
  state.kpBusy = true
  state.error = ''
  // 记下本次生成覆盖到哪条发言：完成后只对「期间新到」的发言续写，同一条发言不会被生成两次
  const lastLineChat = [...src.events].reverse().find((e): e is Extract<RoomEvent, { k: 'chat' }> => e.k === 'chat' && lineOf(e) === line)
  if (lastLineChat && lastLineChat.at > lastSeenChatAt) lastSeenChatAt = lastLineChat.at
  const streamId = newEventId()
  state.streaming = { id: streamId, text: '', scene: line }
  touchStreamWatch()
  try {
    await sendEvent({ k: 'kp-start', id: streamId, at: Date.now(), scene: lineTag(line) })
    let messages = buildKpMessages({
      // 只喂当前线：个人线/合作线互相不串味，跨线靠「分线动向」保持时空一致
      events: src.events.filter((e) => lineOf(e) === line),
      members: roster(),
      worldNote: src.worldNote,
      setting: src.setting,
      module: src.module,
      state: src.game,
      scene: sceneName,
      sceneBlock: renderSceneBlock(src.scenes, src.events),
    })
    // KP 每轮可在文末用 <state> 上报战局变化、<module> 上报模组进度：先在状态快照上累计，定稿时一次提交
    let stateAcc: HallGameState | null = src.game ? normalizeGameState(src.game) : null
    let promptChars = 0
    let completionChars = 0
    // 检定链：KP 请求检定 → 掷骰广播 → 结果回注续写（最多 2 轮）
    for (let hop = 0; hop < 3; hop++) {
      promptChars += messages.reduce((n, m) => n + m.content.length, 0)
      const text = await new Promise<string>((resolve, reject) => {
        const handle = streamChat(cfg, messages, {
          onDelta: (d) => {
            if (!state.streaming) return
            state.streaming.text += d
            touchStreamWatch()
            void sendEvent({ k: 'kp-chunk', id: streamId, delta: d })
          },
          onDone: (full) => resolve(full),
          onError: (err) => reject(err),
        })
        kpAbort = handle
      })
      completionChars += text.length
      const su = extractStateUpdate(text)
      if (su) stateAcc = mergeStateUpdate(stateAcc, su)
      const mu = extractModuleUpdate(text)
      if (mu) stateAcc = mergeStateUpdate(stateAcc, { progress: mu })
      const requests = extractRollRequests(text)
      if (requests.length && hop < 2) {
        const results: { label: string; detail: string }[] = []
        for (const req of requests.slice(0, 2)) {
          try {
            const r = rollDice(req.expr)
            const detail = formatRoll(r)
            results.push({ label: req.label, detail })
            const evt: RoomEvent = {
              k: 'roll', id: newEventId(), name: 'KP', charName: req.label || '检定',
              expr: r.expr, detail, total: r.total, at: Date.now(),
              scene: lineTag(line),
            }
            appendLocal(evt)
            await sendEvent(evt)
          } catch { /* KP 给了非法表达式：跳过 */ }
        }
        if (results.length) {
          messages = [
            ...messages,
            { role: 'assistant', content: stripKpOutput(text) },
            buildRollNudge(results),
          ]
          continue
        }
      }
      const clean = stripKpOutput(text) || text.trim()
      const finalEvt: RoomEvent = { k: 'narration', id: newEventId(), text: clean, at: Date.now(), scene: lineTag(line) }
      appendLocal(finalEvt)
      await sendEvent(finalEvt)
      break
    }
    // 定稿：这轮生成里的地点/道具/记忆变化一次提交——房主直写权威值；成员叙述者发提案给房主合并
    if (stateAcc) {
      if (isHostRun) await commitGameState(stateAcc)
      else if (!sameGameState(state.gameState, stateAcc)) await sendEvent({ k: 'state-propose', state: stateAcc })
    }
    // 计费留痕：每次叙述在剧情流里留一条估算记录（谁的钱、烧在哪条线、大约多少）
    if (completionChars > 0) {
      const usageEvt: RoomEvent = {
        k: 'system', id: newEventId(),
        text: `本段叙述 · ${sceneName} · 叙述者 ${narratorName} · 约 ${estimateTokens(promptChars + completionChars)} tokens（估算）`,
        at: Date.now(),
        scene: lineTag(line),
      }
      appendLocal(usageEvt)
      await sendEvent(usageEvt)
    }
  } catch (err) {
    state.error = `KP 生成失败：${(err as Error).message}`
  } finally {
    try { await sendEvent({ k: 'kp-end', id: streamId }) } catch { /* noop */ }
    state.streaming = null
    state.kpBusy = false
    kpAbort = null
    scheduleKpCheck()
  }
}

let lastSeenChatAt = 0
function scheduleKpCheck() {
  const lastChat = [...state.events].reverse().find((e) => e.k === 'chat')
  if (lastChat && lastChat.at > lastSeenChatAt) {
    lastSeenChatAt = lastChat.at
    const line = lineOf(lastChat)
    if (isLineNarrator(line)) scheduleKp(line)
  }
}

export function stopKp() {
  kpAbort?.abort()
}

// ── AI 辅助创作：一句话构想 → 房间名 + 简介（创建房间弹窗用）──

/** 从模型回复中截取最外层 JSON 对象并解析 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '')
  const s = cleaned.indexOf('{')
  const e = cleaned.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try { return JSON.parse(cleaned.slice(s, e + 1)) } catch { return null }
}

export async function aiAssistRoom(idea: string): Promise<{ title: string; desc: string }> {
  const cfg = kpApiConfig()
  if (!cfg) throw new Error('请先在跑团「模型设置」或「更多 → 语言模型」里配置 API 地址、密钥与模型')
  const trimmed = idea.trim()
  if (!trimmed) throw new Error('先写一句你的构想，再让 AI 生成')
  const messages = [
    {
      role: 'system',
      content: '你是跑团开房文案助手。根据用户的一句话构想，生成房间名与房间简介。房间名不超过 20 字、有氛围感；简介不超过 120 字，说明题材、规则倾向与人数预期。只输出严格 JSON：{"title":"...","desc":"..."}，不要输出其他任何内容。',
    },
    { role: 'user', content: trimmed },
  ]
  const text = await new Promise<string>((resolve, reject) => {
    streamChat(cfg, messages, {
      onDelta: () => {},
      onDone: (full) => resolve(full),
      onError: (err) => reject(err),
    })
  })
  const obj = extractJsonObject(text)
  const title = String(obj?.title || '').trim().slice(0, 40)
  const desc = String(obj?.desc || '').trim().slice(0, 200)
  if (!title) throw new Error('AI 没有返回有效结果，请重试或换个说法')
  return { title, desc }
}

// ── AI 辅助创作（详细模式）：一句话构想 → 房间名 + 简介 + 完整开团设定 ──

const AI_CAMPAIGN_SYSTEM = `你是资深跑团开团策划助手。根据用户的一句话构想，产出完整开团方案与房间公开文案。备团要领：设定是给主持现场「3 秒可查」的骨架，不是小说——重氛围与冲突，不堆细节；NPC 写「身份 + 动机/秘密」；开场场景给玩家一个具体的时空切入点。

字段要求：
- title：房间名，不超过 20 字，有氛围感（这是公开的大厅文案）
- desc：房间简介，不超过 120 字，说明题材、规则倾向与人数预期（公开文案，不剧透）
- setting.system：从 ["free","coc7","dnd5","custom"] 中选最贴合的；选 custom 时 systemCustom 填规则名
- setting.era：具体时代与地点（如「1920s 美国·阿卡姆」「现代·山间雾镇」）
- setting.tones：1-3 个短词（每个不超过 8 字），可自创最贴合题材的词（如「雾镇怪谈」「蒸汽朋克」）
- setting.players：2-8 的整数
- setting.world：世界观与舞台，不超过 150 字
- setting.module：剧情梗概（KP 秘密，含真相与转折），不超过 150 字
- setting.opening：开场场景，不超过 100 字，玩家此刻在哪、正在做什么
- setting.openingNarration：开场白，60-150 字、可直接发出的第二人称开场旁白（氛围化描述+引出玩家行动空间；不要标题、不要引号、不要以「好的/以下是」开头；没有合适的话就给空字符串）
- setting.npcs：2-4 个关键 NPC 数组，每项「名字（身份：动机/秘密）」
- setting.houseRules：0-3 条房规数组，只写真正影响体验的改动；没有就 []
- setting.redlines：内容红线数组（每项一条回避的题材）；没有就 []
- setting.kpStyle：从 ["balanced","narrative","rules"] 中选
- setting.sceneNotes：一段话勾勒关键地点的空间关系与连通方式，不超过 100 字

只输出严格 JSON，不要输出任何其他内容：
{"title":"...","desc":"...","setting":{"system":"coc7","systemCustom":"","era":"...","tones":["..."],"players":4,"world":"...","module":"...","opening":"...","openingNarration":"...","npcs":["名字（身份：动机/秘密）"],"houseRules":["..."],"redlines":["..."],"kpStyle":"balanced","sceneNotes":"..."}}`

/** 列表字段归一化：接受数组或换行/顿号分隔的字符串，剔除空项与「无」 */
function normalizeLines(raw: unknown, max: number, maxLen: number): string {
  const arr = Array.isArray(raw)
    ? raw.map((v) => String(v ?? '').trim())
    : String(raw ?? '').split(/\n|；|;/)
  return arr
    .map((s) => s.trim())
    .filter((s) => s && s !== '无')
    .slice(0, max)
    .map((s) => s.slice(0, maxLen))
    .join('\n')
}

/** 宽容归一化 AI 返回的设定（字段缺失/类型漂移回退默认值） */
function normalizeSetting(raw: unknown): RoomSetting {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max)
  const base = emptySetting()
  const system = String(o.system || '').trim()
  const kpStyle = String(o.kpStyle || '').trim()
  const players = parseInt(String(o.players ?? ''), 10)
  const tones = (Array.isArray(o.tones) ? o.tones : []).map((t) => String(t).trim()).filter(Boolean)
  const seen = new Set<string>()
  const dedupTones = tones.filter((t) => {
    const k = t.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return {
    system: RULE_PRESETS.some((r) => r.id === system) ? system : base.system,
    systemCustom: str(o.systemCustom, 30),
    era: str(o.era, 40),
    tones: dedupTones.slice(0, 4).map((t) => t.slice(0, 8)),
    players: Number.isFinite(players) ? Math.min(8, Math.max(2, players)) : base.players,
    world: str(o.world, 400),
    module: str(o.module, 400),
    opening: str(o.opening, 300),
    openingNarration: str(o.openingNarration, 500),
    npcs: normalizeLines(o.npcs, 6, 80),
    houseRules: normalizeLines(o.houseRules, 4, 100),
    redlines: normalizeLines(o.redlines, 4, 60),
    kpStyle: KP_STYLES.some((k) => k.id === kpStyle) ? kpStyle : base.kpStyle,
    sceneNotes: str(o.sceneNotes, 300),
  }
}

export async function aiAssistCampaign(idea: string): Promise<{ title: string; desc: string; setting: RoomSetting }> {
  const cfg = kpApiConfig()
  if (!cfg) throw new Error('请先在跑团「模型设置」或「更多 → 语言模型」里配置 API 地址、密钥与模型')
  const trimmed = idea.trim()
  if (!trimmed) throw new Error('先写一句你的构想，再让 AI 生成')
  const text = await new Promise<string>((resolve, reject) => {
    streamChat(cfg, [
      { role: 'system', content: AI_CAMPAIGN_SYSTEM },
      { role: 'user', content: trimmed },
    ], {
      onDelta: () => {},
      onDone: (full) => resolve(full),
      onError: (err) => reject(err),
    })
  })
  const obj = extractJsonObject(text)
  const title = String(obj?.title || '').trim().slice(0, 40)
  const desc = String(obj?.desc || '').trim().slice(0, 200)
  if (!title) throw new Error('AI 没有返回有效结果，请重试或换个说法')
  return { title, desc, setting: normalizeSetting(obj?.setting) }
}
