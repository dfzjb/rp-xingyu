/**
 * 端到端加密：房间码即密钥种子。
 * 服务器只转发密文（iv||ct 的 base64），全程无法获知任何房间内容——
 * 这是「A 档纯中继」模式下服务器自证哑管道的关键。
 */
const SALT = 'rp-hall-v1' // 固定盐仅作域分隔；秘密性由房间码本身承担
const ITERATIONS = 150_000

/** 房间码（归一化为小写）→ AES-GCM 256 会话密钥 */
export async function deriveRoomKey(code: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMat = await crypto.subtle.importKey(
    'raw',
    enc.encode(code.trim().toLowerCase()),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function toB64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 加密任意房间事件 → base64(iv || ciphertext) */
export async function sealEvent(key: CryptoKey, event: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(event)),
  )
  const box = new Uint8Array(iv.length + ct.byteLength)
  box.set(iv, 0)
  box.set(new Uint8Array(ct), iv.length)
  return toB64(box)
}

/** 解密 base64(iv || ciphertext) → 原始事件；密钥不对时抛 OperationError */
export async function openEvent<T = unknown>(key: CryptoKey, payload: string): Promise<T> {
  const box = fromB64(payload)
  if (box.length < 13) throw new Error('密文载荷过短')
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: box.subarray(0, 12) },
    key,
    box.subarray(12),
  )
  return JSON.parse(new TextDecoder().decode(pt)) as T
}

/** 生成 6 位房间码（与服务器同一字母表，去易混淆字符） */
export function genRoomCode(): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz'
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let s = ''
  for (const b of bytes) s += alphabet[b % alphabet.length]
  return s
}
