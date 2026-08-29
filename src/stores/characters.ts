import { defineStore } from 'pinia'
import { ref } from 'vue'
import { db } from '../db'
import type { CharacterCard } from '../types'
import { uuid } from '../lib/id'
import { deepPlain } from '../lib/plain'
import { useChatStore } from './chat'

export const useCharactersStore = defineStore('characters', () => {
  const list = ref<CharacterCard[]>([])
  const loaded = ref(false)

  async function load() {
    const rows = await db.characters.toArray()
    // 最近创建/导入在前
    rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    list.value = rows
    loaded.value = true
  }

  async function put(card: CharacterCard) {
    await db.characters.put(deepPlain(card))
    const i = list.value.findIndex((c) => c.uuid === card.uuid)
    if (i >= 0) list.value[i] = card
    else list.value.unshift(card)
  }

  async function remove(uuidStr: string) {
    await db.characters.delete(uuidStr)
    list.value = list.value.filter((c) => c.uuid !== uuidStr)
    // 级联删除该角色的会话（与旧版"删卡级联删聊天"一致）
    const sessions = await db.chats.where('charUuid').equals(uuidStr).toArray()
    await db.chats.bulkDelete(sessions.map((s) => s.id))
    // 同步清掉 chat store 内存里的会话，否则侧栏计数/当前会话残留到刷新才消失
    const chat = useChatStore()
    chat.sessions = chat.sessions.filter((s) => s.charUuid !== uuidStr)
    if (chat.currentSession?.charUuid === uuidStr) {
      chat.currentSessionId = chat.sessions[0]?.id || ''
    }
  }

  function emptyCard(): CharacterCard {
    return {
      uuid: uuid(),
      name: '',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      creator_notes: '',
      avatar: '',
      createdAt: Date.now(),
      importedAt: Date.now(),
      worldInfo: [],
      regexScripts: [],
      uiTemplates: [],
    }
  }

  return { list, loaded, load, put, remove, emptyCard }
})
