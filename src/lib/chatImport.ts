/**
 * 聊天记录 .jsonl 导入（酒馆导出格式：首行 {character_name,...} 元数据 + 每行 {name,is_user,mes}）。
 * 按角色名自动挂载到本地同名角色卡（同名多卡取最近导入的一张）；找不到同名卡时报可读错误。
 */
import { db, DEFAULT_SETTINGS } from '../db'
import type { ChatSession, ImportReport, MsgNode } from '../types'
import { uuid } from './id'

export async function importChatJsonl(text: string, fallbackName = ''): Promise<ImportReport> {
  const lines = text.trim().split('\n')
  type StMsg = { name?: string; is_user?: boolean; mes?: string }
  let meta: { character_name?: string; user_name?: string } | null = null
  const msgs: StMsg[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      const o = JSON.parse(lines[i]) as Record<string, unknown>
      if (i === 0 && o && typeof o === 'object' && !('mes' in o) && 'character_name' in o) {
        meta = o as { character_name?: string; user_name?: string }
        continue
      }
      if (o && typeof o.mes === 'string') msgs.push(o as StMsg)
    } catch { /* 坏行跳过 */ }
  }
  if (!msgs.length) throw new Error('未找到消息（不像酒馆导出的 JSONL）')

  const name = (meta?.character_name || fallbackName || '').trim()
  if (!name) throw new Error('文件里没有角色名（character_name），无法自动挂载——请先导入对应角色卡')
  const all = await db.characters.toArray()
  const matches = all.filter((c) => c.name === name)
  if (!matches.length) {
    throw new Error(`本地没有名为「${name}」的角色卡——请先导入该角色卡，再导入聊天记录`)
  }
  matches.sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0) || (b.createdAt || 0) - (a.createdAt || 0))
  const char = matches[0]

  const report: ImportReport = { chats: 0, messages: 0, warnings: [] }
  const nodes: Record<string, MsgNode> = {}
  let prev: string | null = null
  for (const m of msgs) {
    const id = uuid()
    nodes[id] = {
      id,
      role: m.is_user ? 'user' : 'assistant',
      name: m.name || '',
      content: m.mes || '',
      isSelf: !!m.is_user,
      createdAt: Date.now(),
      parentId: prev,
      childrenIds: [],
    }
    if (prev) nodes[prev].childrenIds.push(id)
    prev = id
  }
  const session: ChatSession = {
    id: uuid(),
    charUuid: char.uuid,
    name: `酒馆导入 ${name}`.slice(0, 24),
    rootNodeId: Object.keys(nodes)[0] || null,
    activeNodeId: prev,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    origin: 'new',
    nodes,
  }
  await db.chats.put(session)
  report.chats = 1
  report.messages = msgs.length
  if (matches.length > 1) report.warnings.push(`本地有 ${matches.length} 张同名角色卡，聊天已挂到最近导入的一张`)
  // 导入后把该卡设为最近角色，用户回聊天页即见（upsert：settings 行可能尚不存在）
  const prevSettings = await db.settings.get('app')
  await db.settings.put({ ...(prevSettings || DEFAULT_SETTINGS), lastActiveCharUuid: char.uuid })
  return report
}
