/**
 * 在线跑团房间状态机（单例 composable）。
 *
 * 角色划分：房主 = 权威节点，持有战役、执行 KP 流式生成（复用主站模型设置与 streamChat）、
 * 给中途加入者补发快照；中继只转发端到端密文与房间公开元数据（标题/简介/封面/是否上锁），
 * 服务器零存储。上锁房间密钥种子 = 房间码:密码，密码不出本机。
 */
import { computed, reactive } from 'vue'
import { deriveRoomKey, keyProof, genRoomCode, openEvent, sealEvent, roomSecret } from './crypto'
import { isPersisted, newEventId, type HallCampaign, type MemberInfo, type RoomEvent, type RoomMeta } from './protocol'
import { formatRoll, rollDice } from './dice'
import { buildKpMessages, buildRollNudge, extractRollRequests, stripRollRequests } from './kp'
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
}

const LS_PROFILE = 'hall.profile'
const LS_LAST_CAMPAIGN = 'hall.lastCampaignId'

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
    locked: meta?.locked ?? false,
    password,
    desc: meta?.desc ?? '',
    cover: meta?.cover ?? '',
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

// ── 中继地址与玩家档案 ──

/** 默认中继：同源 /ws（dev 由 vite 代理，生产由 nginx 反代）；可在跑团设置里覆盖 */
export function relayUrlOf(hallWsUrl: string): string {
  if (hallWsUrl.trim()) return hallWsUrl.trim()
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

function loadProfile(): Profile {
  try {
    const j = JSON.parse(localStorage.getItem(LS_PROFILE) || '{}')
    return { name: j.name || '', charName: j.charName || '', persona: j.persona || '' }
  } catch {
    return { name: '', charName: '', persona: '' }
  }
}

/** KP 模型配置：直接复用主站「语言模型」设置（当前激活槽位） */
function kpApiConfig(): ApiConfig | null {
  const s = useSettingsStore()
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
  isHost: false,
  myPeerId: '',
  members: {} as Record<string, MemberInfo>,
  events: [] as RoomEvent[],
  streaming: null as { id: string; text: string } | null,
  campaignName: '',
  kpBusy: false,
})

const lobby = reactive({
  status: 'off' as LobbyStatus,
  rooms: [] as RoomMeta[],
})

let ws: WebSocket | null = null // 房间连接
let lobbyWs: WebSocket | null = null // 大厅列表连接
let lobbyRetry: ReturnType<typeof setTimeout> | null = null
let key: CryptoKey | null = null
let campaign: HallCampaign | null = null // 仅房主持有
let kpAbort: { abort: () => void } | null = null
let kpTimer: ReturnType<typeof setTimeout> | null = null
let profile: Profile = loadProfile()
let pendingInit: { meta?: CreateMeta; password: string } | null = null

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
  if (lobbyWs && (lobbyWs.readyState === WebSocket.OPEN || lobbyWs.readyState === WebSocket.CONNECTING)) return
  const s = useSettingsStore()
  const url = relayUrlOf(s.settings.hallWsUrl || '')
  lobby.status = 'connecting'
  try {
    lobbyWs = new WebSocket(url)
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

function handleEvent(e: RoomEvent, from: string) {
  switch (e.k) {
    case 'hello':
      state.members[from] = { ...e.member, peerId: from }
      break
    case 'chat':
    case 'narration':
    case 'roll':
    case 'system':
      appendLocal(e)
      break
    case 'kp-start':
      state.streaming = { id: e.id, text: '' }
      break
    case 'kp-chunk':
      if (state.streaming?.id === e.id) state.streaming.text += e.delta
      break
    case 'kp-end':
      if (state.streaming?.id === e.id) state.streaming = null
      break
    case 'sync-request':
      if (state.isHost && campaign) {
        void sendEvent({ k: 'sync', events: [...campaign.events], members: roster() }, from)
      }
      break
    case 'sync': {
      if (e.events.length > state.events.length) {
        state.events.splice(0, state.events.length, ...e.events)
      }
      for (const m of e.members) state.members[m.peerId] = { ...m }
      break
    }
  }
}

// ── 连接生命周期 ──

export async function connect(opts: {
  mode: 'create' | 'join'
  code?: string
  profile: Profile
  campaignId?: string
  meta?: CreateMeta // create 时携带（title/desc/cover/locked）
  password?: string // create+locked 或 join 上锁房间时必填
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
  const secret = roomSecret(code, locked ? password : '')
  state.phase = 'connecting'
  state.error = ''
  key = await deriveRoomKey(secret)
  pendingInit = { meta: opts.meta, password }

  const frame: Record<string, unknown> = opts.mode === 'create'
    ? { t: 'create', code, meta: opts.meta || { title: '未命名房间', desc: '', cover: '', locked: false } }
    : { t: 'join', code }
  if (locked) frame.proof = await keyProof(secret)

  const s = useSettingsStore()
  const url = relayUrlOf(s.settings.hallWsUrl || '')
  try {
    ws = new WebSocket(url)
  } catch (err) {
    state.phase = 'error'
    state.error = `无法连接中继：${(err as Error).message}`
    return
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

/** 房主就位：加载/新建战役，进房并自我介绍 */
async function enterRoomAsHost() {
  const lastId = localStorage.getItem(LS_LAST_CAMPAIGN)
  if (lastId) {
    campaign = (await db.campaigns.get(lastId)) || null
  }
  const meta = pendingInit?.meta
  if (!campaign) {
    campaign = newCampaign(meta?.title || '新战役', state.roomCode, meta, pendingInit?.password || '')
  } else if (meta) {
    // 恢复战役：回填本次创建信息（房间名/简介/封面以上次为准，仅同步锁与密码）
    campaign.locked = meta.locked ?? campaign.locked
    campaign.password = pendingInit?.password || campaign.password
  }
  if (campaign.roomCode !== state.roomCode) {
    campaign.roomCode = state.roomCode
    await saveCampaign(campaign)
  }
  localStorage.setItem(LS_LAST_CAMPAIGN, campaign.id)
  if (!campaign.worldNote) campaign.worldNote = localStorage.getItem('hall.worldNote') || ''
  state.campaignName = campaign.name
  state.events.splice(0, state.events.length, ...campaign.events)
  state.phase = 'room'
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
  // 房主离开即关房，回大厅
  connectLobby()
}

export async function refreshCampaigns() {
  hall.campaigns = await listCampaigns()
}

// ── 玩家动作 ──

export async function sendChat(text: string) {
  const t = text.trim()
  if (!t || state.phase !== 'room') return
  const e: RoomEvent = {
    k: 'chat', id: newEventId(), from: state.myPeerId,
    name: profile.name, charName: profile.charName, text: t, at: Date.now(),
  }
  appendLocal(e)
  await sendEvent(e)
  if (state.isHost) scheduleKp()
}

export async function sendNarration(text: string) {
  const t = text.trim()
  if (!t || state.phase !== 'room') return
  const e: RoomEvent = { k: 'narration', id: newEventId(), text: t, at: Date.now() }
  appendLocal(e)
  await sendEvent(e)
}

export async function sendRoll(expr: string): Promise<string | null> {
  try {
    const r = rollDice(expr)
    const e: RoomEvent = {
      k: 'roll', id: newEventId(), name: profile.name, charName: profile.charName,
      expr: r.expr, detail: formatRoll(r), total: r.total, at: Date.now(),
    }
    appendLocal(e)
    await sendEvent(e)
    return null
  } catch (err) {
    return (err as Error).message
  }
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

// ── KP 生成（房主端，复用主站 streamChat）──

function scheduleKp() {
  if (kpTimer) clearTimeout(kpTimer)
  kpTimer = setTimeout(() => void generateKp(), 1200)
}

export async function generateKp() {
  if (!state.isHost || !campaign || state.kpBusy || state.phase !== 'room') return
  const cfg = kpApiConfig()
  if (!cfg) {
    state.error = 'KP 还不能开口：请先在「更多 → 语言模型」里配置 API 地址、密钥与模型'
    return
  }
  state.kpBusy = true
  state.error = ''
  const streamId = newEventId()
  state.streaming = { id: streamId, text: '' }
  try {
    await sendEvent({ k: 'kp-start', id: streamId, at: Date.now() })
    let messages = buildKpMessages({
      events: campaign.events,
      members: roster(),
      worldNote: campaign.worldNote,
    })
    // 检定链：KP 请求检定 → 掷骰广播 → 结果回注续写（最多 2 轮）
    for (let hop = 0; hop < 3; hop++) {
      const text = await new Promise<string>((resolve, reject) => {
        const handle = streamChat(cfg, messages, {
          onDelta: (d) => {
            if (!state.streaming) return
            state.streaming.text += d
            void sendEvent({ k: 'kp-chunk', id: streamId, delta: d })
          },
          onDone: (full) => resolve(full),
          onError: (err) => reject(err),
        })
        kpAbort = handle
      })
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
            }
            appendLocal(evt)
            await sendEvent(evt)
          } catch { /* KP 给了非法表达式：跳过 */ }
        }
        if (results.length) {
          messages = [
            ...messages,
            { role: 'assistant', content: stripRollRequests(text) },
            buildRollNudge(results),
          ]
          continue
        }
      }
      const clean = stripRollRequests(text).trim() || text.trim()
      const finalEvt: RoomEvent = { k: 'narration', id: newEventId(), text: clean, at: Date.now() }
      appendLocal(finalEvt)
      await sendEvent(finalEvt)
      break
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
    scheduleKp()
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
  if (!cfg) throw new Error('请先在「更多 → 语言模型」里配置 API 地址、密钥与模型')
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
