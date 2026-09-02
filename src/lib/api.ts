/**
 * OpenAI 兼容 API 客户端：SSE 流式 /chat/completions + 模型列表。
 */
import type { ModelSlot, MsgNode, Persona, CharacterCard } from '../types'

export interface ApiConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  reasoningEffort: string
}

export interface ChatRequestContext {
  character: CharacterCard
  persona?: Persona
  /** 当前链路消息（含根消息，按时间序） */
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
}

export interface StreamHandlers {
  onDelta: (text: string) => void
  onReasoning?: (text: string) => void
  onDone: (full: string, reasoning: string) => void
  onError: (err: Error) => void
  /** 请求已被服务端接受（HTTP 200，流已建立）——首字前唯一能给出的"活着"信号 */
  onOpen?: () => void
}

export function normalizeBaseUrl(url: string): string {
  let u = (url || '').trim()
  if (!u) return u
  if (!/^https?:\/\//.test(u)) u = 'https://' + u
  u = u.replace(/\/+$/, '')
  if (!/\/v\d+$/.test(u)) u += '/v1'
  return u
}

/** 非对话模型关键词（图片/视频/语音/嵌入等，不出现在聊天模型列表中） */
/** 判断模型对象是否被中转站标记为禁用/不可用 */
function isModelDisabled(m: Record<string, unknown>): boolean {
  if (m.disabled === true || m.enabled === false || m.enable === false) return true
  if (m.status === 'disabled' || m.status === 'inactive' || m.status === 'offline' || m.status === 0) return true
  if (m.state === 'disabled' || m.state === 'inactive' || m.state === 'offline') return true
  const perms = Array.isArray(m.permission) ? m.permission as Record<string, unknown>[] : []
  if (perms.length && perms.every((p) => p && (p.status === 'no_permission' || p.allowed === false))) return true
  return false
}

export type ModelCategory = 'image' | 'video' | 'audio' | 'embedding' | 'text'

const CATEGORY_RULES: { cat: ModelCategory; patterns: RegExp[] }[] = [
  { cat: 'image', patterns: [/diffusion/i, /dall[-_]?e/i, /flux/i, /sdxl/i, /sd[-_]?\d/i, /midjourney/i, /k_euler/i, /k_dpm/i, /k_heun/i, /k_lms/i, /k_dpmpp/i, /ddim/i, /plms/i, /sampler/i, /inpaint/i, /upscale/i, /animagine/i, /pony/i, /stable[-_]?diffusion/i, /nai[-_]?diffusion/i, /^image/i, /imagen/i, /^gpt-image/i, /seepaint/i, /jimeng/i, /doubao.*image/i, /seedream/i] },
  { cat: 'video', patterns: [/^video/i, /sora/i, /veo/i, /kling/i, /runway/i, /pika/i, /gen-?\d/i, /hailuo/i, /minimax.*video/i, /wan/i, /cogvideo/i, /seedance/i, /doubao.*video/i] },
  { cat: 'audio', patterns: [/^tts/i, /whisper/i, /speech/i, /^voice/i, /audio/i, /music/i, /song/i] },
  { cat: 'embedding', patterns: [/embedding/i, /embed/i, /bge/i, /e5-/i, /gte-/i] },
]

/** 按模型名推断类型 */
export function categorizeModel(id: string): ModelCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((re) => re.test(id))) return rule.cat
  }
  return 'text'
}

const CATEGORY_LABELS: Record<ModelCategory, string> = {
  text: '对话 / 文本',
  image: '图片生成',
  video: '视频生成',
  audio: '语音 / 音乐',
  embedding: '向量嵌入',
}

/** 把模型 ID 列表转成 NSelect 分组 options，preferCat 类型的模型排最前 */
export function groupedModelOptions(ids: string[], preferCat?: ModelCategory) {
  const groups: Record<ModelCategory, { label: string; options: { label: string; value: string }[] }> = {
    text: { label: CATEGORY_LABELS.text, options: [] },
    image: { label: CATEGORY_LABELS.image, options: [] },
    video: { label: CATEGORY_LABELS.video, options: [] },
    audio: { label: CATEGORY_LABELS.audio, options: [] },
    embedding: { label: CATEGORY_LABELS.embedding, options: [] },
  }
  for (const id of ids) {
    const cat = categorizeModel(id)
    groups[cat].options.push({ label: id, value: id })
  }
  const order: ModelCategory[] = preferCat
    ? [preferCat, ...(['text', 'image', 'video', 'audio', 'embedding'] as ModelCategory[]).filter((c) => c !== preferCat)]
    : ['text', 'image', 'video', 'audio', 'embedding']
  return order
    .filter((c) => groups[c].options.length > 0)
    .map((c) => ({ type: 'group' as const, label: groups[c].label, key: c, children: groups[c].options }))
}

/** 拉取模型列表（/v1/models 全量返回，仅排除被显式标记禁用的模型） */
export async function fetchModels(cfg: { baseUrl: string; apiKey: string }): Promise<string[]> {
  const url = normalizeBaseUrl(cfg.baseUrl) + '/models'
  const resp = await fetch(url, {
    headers: { Authorization: 'Bearer ' + cfg.apiKey },
  })
  if (!resp.ok) throw new Error(`模型列表拉取失败 HTTP ${resp.status}`)
  const j = (await resp.json()) as { data?: Record<string, unknown>[] }
  return (j.data || [])
    .filter((m) => m && typeof m.id === 'string' && !isModelDisabled(m))
    .map((m) => m.id as string)
    .sort()
}

/** 文本嵌入（OpenAI 兼容 /v1/embeddings） */
export async function fetchEmbeddings(
  cfg: { baseUrl: string; apiKey: string; model: string },
  texts: string[],
): Promise<number[][]> {
  const url = normalizeBaseUrl(cfg.baseUrl) + '/embeddings'
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model, input: texts }),
  })
  if (!resp.ok) throw new Error(`Embedding 失败 HTTP ${resp.status}`)
  const j = (await resp.json()) as { data?: { embedding?: number[] }[] }
  return (j.data || []).map((d) => d.embedding || [])
}

/** 余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (!normA || !normB) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 组装请求 messages（system 提示词 + 世界书常驻条目 + 链路消息） */
export function buildRequestMessages(ctx: ChatRequestContext): {
  role: 'user' | 'assistant' | 'system'; content: string
}[] {
  const { character, persona } = ctx
  const sysParts: string[] = []

  const desc = character.description || ''
  const pers = character.personality ? `\n\n### Personality\n${character.personality}` : ''
  const scen = character.scenario ? `\n\n### Scenario\n${character.scenario}` : ''
  if (desc || pers || scen) sysParts.push(desc + pers + scen)

  if (persona?.description) {
    sysParts.push(`### User Persona\n${persona.name}（你扮演的世界中的用户角色）\n${persona.description}`)
  }
  // 世界书 constant 条目
  const constants = (character.worldInfo || [])
    .filter((w) => (w as { constant?: boolean })?.constant && (w as { enabled?: boolean })?.enabled !== false)
    .sort((a, b) => ((a as { order?: number })?.order ?? 100) - ((b as { order?: number })?.order ?? 100))
  for (const w of constants) {
    const entry = w as { content?: string; comment?: string }
    if (entry.content) sysParts.push(entry.content)
  }

  const msgs: { role: 'user' | 'assistant' | 'system'; content: string }[] = []
  if (sysParts.length) msgs.push({ role: 'system', content: sysParts.join('\n\n---\n\n') })
  msgs.push(...ctx.messages)
  return msgs
}

/** 从一个 SSE data 负载（已解析的 JSON 对象）提取正文/推理增量与流内错误 */
function extractChunk(j: any): { content?: string; reasoning?: string; error?: string } {
  // HTTP 200 但流体内含错误对象（中转站常见）：显式提取，避免静默空回复
  const err = j?.error
  if (err) {
    return { error: typeof err === 'string' ? err : (err.message || JSON.stringify(err)) }
  }
  const choice = j?.choices?.[0]
  // delta（流式）与 message（非流式/部分网关）双形态兼容
  const piece = choice?.delta || choice?.message
  if (!piece) return {}
  return {
    content: typeof piece.content === 'string' ? piece.content : undefined,
    reasoning: piece.reasoning_content || piece.reasoning || undefined,
  }
}

/** 把整段文本按 SSE 行手工解析（中转站 stream:false 却返回 SSE 文本时的兜底通道） */
function parseSseText(
  raw: string,
  onDelta: (t: string) => void,
  onReasoning: (t: string) => void,
): { full: string; reasoning: string } {
  let full = ''
  let reasoning = ''
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let j: any
    try { j = JSON.parse(payload) } catch { continue } // 非 JSON 行忽略
    const c = extractChunk(j)
    if (c.error) throw new Error(c.error)
    if (c.reasoning) { reasoning += c.reasoning; onReasoning(c.reasoning) }
    if (c.content) { full += c.content; onDelta(c.content) }
  }
  return { full, reasoning }
}

/**
 * SSE 流式对话。返回 abort 函数。
 * onDone 收到完整文本（含 <think> 标签原样，由渲染层解析）。
 * 三通道兼容（对齐旧版）：
 *  1) text/event-stream：逐块 SSE；
 *  2) 普通 JSON 响应（非流式/被网关改写）：一次性解析 choices[0].message；
 *  3) 响应体是 SSE 文本但 Content-Type 不是 event-stream：手工按行解析兜底。
 */
export function streamChat(
  cfg: ApiConfig,
  messages: { role: string; content: string }[],
  handlers: StreamHandlers,
): { abort: () => void } {
  const controller = new AbortController()
  const url = normalizeBaseUrl(cfg.baseUrl) + '/chat/completions'
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
  }
  if (cfg.reasoningEffort && cfg.reasoningEffort !== 'none') {
    body.reasoning_effort = cfg.reasoningEffort
  }

  let full = ''
  let reasoning = ''

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (resp) => {
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status} ${text.slice(0, 300)}`)
      }
      handlers.onOpen?.()
      const contentType = (resp.headers.get('content-type') || '').toLowerCase()

      // ── 通道 2/3：非 event-stream 响应（普通 JSON 或被网关转成文本的 SSE）──
      if (!contentType.includes('text/event-stream') && resp.body) {
        // 小响应一次性读入；仍需支持被中断时保留已得内容
        const raw = await resp.text()
        const trimmed = raw.trim()
        // 通道 2：标准非流式 JSON
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            const j = JSON.parse(trimmed)
            const c = extractChunk(j)
            if (c.error) throw new Error(c.error)
            if (c.reasoning) { reasoning += c.reasoning; handlers.onReasoning?.(c.reasoning) }
            if (c.content) { full += c.content; handlers.onDelta(c.content) }
            handlers.onDone(full, reasoning)
            return
          } catch (e) {
            if (e instanceof SyntaxError) { /* 落到 SSE 文本/纯文本兜底 */ }
            else throw e
          }
        }
        // 通道 3：整段 SSE 文本
        if (trimmed.includes('data:')) {
          const r = parseSseText(raw, (t) => handlers.onDelta(t), (t) => handlers.onReasoning?.(t))
          handlers.onDone(r.full, r.reasoning)
          return
        }
        // 纯文本响应：整体作为正文
        if (trimmed) {
          full = raw
          handlers.onDelta(raw)
        }
        handlers.onDone(full, reasoning)
        return
      }

      // ── 通道 1：标准 SSE 逐块流 ──
      if (!resp.body) throw new Error('响应无 body')
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (payload === '[DONE]') {
            handlers.onDone(full, reasoning)
            return
          }
          try {
            const c = extractChunk(JSON.parse(payload))
            if (c.error) throw new Error(c.error)
            if (c.reasoning) {
              reasoning += c.reasoning
              handlers.onReasoning?.(c.reasoning)
            }
            if (c.content) {
              full += c.content
              handlers.onDelta(c.content)
            }
          } catch (e) {
            // 流内错误：抛出中止（无法解析的 keep-alive 注释等仍忽略）
            if (e instanceof SyntaxError) continue
            throw e
          }
        }
      }
      // 流正常结束但没收到 [DONE]
      handlers.onDone(full, reasoning)
    })
    .catch((err) => {
      if ((err as Error).name === 'AbortError') {
        handlers.onDone(full, reasoning) // 中断时保留已生成内容
        return
      }
      handlers.onError(err instanceof Error ? err : new Error(String(err)))
    })

  return { abort: () => controller.abort() }
}

/** 非流式补全（对外语义不变）：内部统一走流式通道累积后返回。
 * 中转站/网关对非流式长请求常按超时掐断（尤其推理模型），SSE 逐块传输可保活。 */
export function chatOnce(cfg: ApiConfig, messages: { role: string; content: string }[]): Promise<string> {
  return new Promise((resolve, reject) => {
    streamChat(cfg, messages, {
      onDelta: () => {},
      onDone: (full) => resolve(full),
      onError: reject,
    })
  })
}
