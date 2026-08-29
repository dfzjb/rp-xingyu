/**
 * SillyTavern 角色卡导入导出（PNG tEXt chunk + JSON V2/V3）。
 * PNG 解析为纯前端实现（思路与社区通用格式一致；实现独立，无上游代码）。
 * ST 格式规范参考：https://github.com/malfoyslastname/character_card_v2
 */
import type { CharacterCard, LegacyCharacter } from '../types'
import { uuid } from './id'
import { normalizeUiTemplates } from './uitemplate'

// ── PNG tEXt chunk 读写 ──

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function fileToBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer()
  return new Uint8Array(buf)
}

function latin1Decode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

function latin1Encode(str: string): Uint8Array {
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff
  return out
}

export interface ParsedPngCard {
  data: Uint8Array // 原始 PNG 字节（用于取头像 base64）
  card: unknown // chara / ccv3 chunk 解析出的对象
}

/** 从 PNG 卡提取 tEXt chara/ccv3 chunk（base64 或明文 JSON） */
export async function parsePngCard(file: File): Promise<ParsedPngCard> {
  const bytes = await fileToBytes(file)
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('不是 PNG 文件')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  while (pos + 12 <= bytes.length) {
    const len = view.getUint32(pos)
    const type = latin1Decode(bytes.subarray(pos + 4, pos + 8))
    if (type === 'tEXt') {
      const data = bytes.subarray(pos + 8, pos + 8 + len)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = latin1Decode(data.subarray(0, nul))
        if (keyword === 'chara' || keyword === 'ccv3') {
          const textRaw = latin1Decode(data.subarray(nul + 1))
          let text = textRaw
          // ST 导出的 base64 可能是 UTF-8 字节经 latin1 存储：尝试修复多字节
          if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) {
            const utf8 = new Uint8Array(textRaw.length)
            for (let i = 0; i < textRaw.length; i++) utf8[i] = textRaw.charCodeAt(i) & 0xff
            try { text = new TextDecoder().decode(utf8) } catch { /* keep latin1 */ }
          }
          text = text.trim()
          let jsonStr: string
          if (/^ey[A-Za-z0-9+/=]+$/.test(text)) {
            // base64（含 UTF-8 内容）
            const bin = atob(text)
            const u8 = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
            jsonStr = new TextDecoder().decode(u8)
          } else {
            jsonStr = text
          }
          const card = JSON.parse(jsonStr)
          return { data: bytes, card }
        }
      }
    }
    pos += 12 + len
    if (type === 'IEND') break
  }
  throw new Error('PNG 中没有角色卡数据（chara/ccv3 tEXt 块）')
}

/** PNG bytes → data URI */
export function pngBytesToDataUri(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[])
  }
  return 'data:image/png;base64,' + btoa(bin)
}

/** 构造带 chara tEXt chunk 的 PNG（用无卡 PNG + 卡数据 → 导出卡） */
export async function buildPngCard(pngDataUri: string, cardObj: unknown): Promise<Uint8Array> {
  const bin = atob(pngDataUri.slice(pngDataUri.indexOf(',') + 1))
  const png = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) png[i] = bin.charCodeAt(i)

  const jsonBytes = new TextEncoder().encode(JSON.stringify(cardObj))
  let b64 = ''
  for (let i = 0; i < jsonBytes.length; i += CHUNK_SIZE) {
    b64 += String.fromCharCode.apply(null, Array.from(jsonBytes.subarray(i, i + CHUNK_SIZE)) as number[])
  }
  const b64Bytes = latin1Encode(btoa(b64))

  const keyword = latin1Encode('chara')
  const payload = new Uint8Array(keyword.length + 1 + b64Bytes.length)
  payload.set(keyword, 0)
  payload[keyword.length] = 0
  payload.set(b64Bytes, keyword.length + 1)

  const chunk = new Uint8Array(12 + payload.length)
  const dv = new DataView(chunk.buffer)
  dv.setUint32(0, payload.length)
  chunk.set(latin1Encode('tEXt'), 4)
  chunk.set(payload, 8)
  const crcInput = new Uint8Array(4 + payload.length)
  crcInput.set(latin1Encode('tEXt'), 0)
  crcInput.set(payload, 4)
  dv.setUint32(8 + payload.length, crc32(crcInput))

  // PNG sig(8) + IHDR 必在首位：把 chara chunk 插在 IHDR 之后
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const ihdrLen = view.getUint32(8)
  const insertAt = 8 + 12 + ihdrLen
  const out = new Uint8Array(png.length + chunk.length)
  out.set(png.subarray(0, insertAt), 0)
  out.set(chunk, insertAt)
  out.set(png.subarray(insertAt), insertAt + chunk.length)
  return out
}
const CHUNK_SIZE = 0x8000

// ── ST 卡对象 ↔ 新站卡互转 ──

interface StWorldEntry { keys?: string[]; content?: string; comment?: string; [k: string]: unknown }

/** ST 卡（V1/V2/V3 或 旧版 老格式）→ 新站卡 */
export function stCardToOurs(obj: unknown, avatarDataUri: string): CharacterCard {
  if (!obj || typeof obj !== 'object') throw new Error('卡数据无效')
  const o = obj as Record<string, any>
  const data = o.data && typeof o.data === 'object' ? o.data : o // V2/V3 包一层 data
  const ext = data.extensions || {}
  const book = data.character_book
  const worldInfo = Array.isArray(book?.entries)
    ? book.entries.map((e: StWorldEntry) => ({
        comment: e.comment || e.name || '',
        content: e.content || '',
        enabled: e.enabled !== false,
        keys: e.keys || (e.key ? [e.key] : []),
        constant: !!e.constant,
        position: e.position ?? 'before_char',
        order: e.order ?? 100,
        ...e,
      }))
    : Array.isArray(data.worldInfo) ? data.worldInfo : []
  const card: CharacterCard = {
    uuid: uuid(),
    name: data.name || o.name || '未命名角色',
    description: data.description || '',
    personality: data.personality || '',
    scenario: data.scenario || '',
    first_mes: data.first_mes || data.greeting || '',
    creator_notes: data.creator_notes || data.creatorcomment || '',
    avatar: avatarDataUri,
    createdAt: Date.now(),
    importedAt: Date.now(),
    alternateGreetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings.filter((g: unknown) => typeof g === 'string' && g.trim()) : [],
    mesExample: data.mes_example || '',
    systemPromptOverride: data.system_prompt || '',
    postHistoryInstructions: data.post_history_instructions || '',
    creator: data.creator || o.creator || '',
    characterVersion: data.character_version || o.character_version || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    worldInfo,
    regexScripts: Array.isArray(ext.regex_scripts) ? ext.regex_scripts : (Array.isArray(data.regexScripts) ? data.regexScripts : []),
    // 旧版导入同款回退链：extensions 优先，其次 data / 根层的驼峰与下划线两种键名
    uiTemplates: normalizeUiTemplates(
      ext.legacy_ui_templates
      ?? ext.ui_templates
      ?? data.uiTemplates
      ?? data.ui_templates
      ?? o.uiTemplates
      ?? o.ui_templates,
    ),
  }
  return card
}

/** 新站卡 → ST V3 JSON 对象 */
export function oursCardToSt(card: CharacterCard): Record<string, unknown> {
  const entries = (card.worldInfo || []).map((e) => {
    const w = e as Record<string, any>
    return {
      keys: w.keys || [],
      content: w.content || '',
      comment: w.comment || '',
      enabled: w.enabled !== false,
      constant: !!w.constant,
      order: w.order ?? 100,
      position: typeof w.position === 'number' ? w.position : 0,
      ...w,
    }
  })
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.first_mes,
      mes_example: card.mesExample || '',
      alternate_greetings: card.alternateGreetings || [],
      system_prompt: card.systemPromptOverride || '',
      post_history_instructions: card.postHistoryInstructions || '',
      creator_notes: card.creator_notes,
      creator: card.creator || '',
      character_version: card.characterVersion || '',
      tags: card.tags || [],
      avatar: 'none',
      character_book: entries.length ? { entries } : undefined,
      extensions: {
        legacy_watermark: 'rp-site',
        regex_scripts: card.regexScripts || [],
        legacy_ui_templates: card.uiTemplates || [],
      },
    },
  }
}

/** 统一入口：File（.png / .json）→ 新站卡 */
export async function importCardFile(file: File): Promise<CharacterCard> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.png')) {
    const { data, card } = await parsePngCard(file)
    return stCardToOurs(card, pngBytesToDataUri(data))
  }
  if (name.endsWith('.json')) {
    const text = await file.text()
    const obj = JSON.parse(text)
    return stCardToOurs(obj, '')
  }
  throw new Error('仅支持 .png / .json 卡文件')
}
