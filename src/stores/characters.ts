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

  /** 列表排序：收藏置顶（同收藏按 favAt 最近的在前），其余最近创建/导入在前 */
  function sortList(rows: CharacterCard[]) {
    rows.sort((a, b) =>
      ((b.fav === true ? 1 : 0) - (a.fav === true ? 1 : 0))
      || (b.favAt || 0) - (a.favAt || 0)
      || (b.createdAt || 0) - (a.createdAt || 0))
  }

  async function load() {
    const rows = await db.characters.toArray()
    sortList(rows)
    list.value = rows
    loaded.value = true
  }

  async function put(card: CharacterCard) {
    const plain = deepPlain(card) as CharacterCard
    await db.characters.put(plain)
    const i = list.value.findIndex((c) => c.uuid === plain.uuid)
    if (i >= 0) list.value.splice(i, 1, plain)
    else list.value.unshift(plain)
    sortList(list.value)
  }

  /** 收藏置顶开关（旧版 ☆）：收藏的卡排到列表最前 */
  async function toggleFav(uuidStr: string) {
    const c = list.value.find((x) => x.uuid === uuidStr)
    if (!c) return
    const fav = !(c.fav === true)
    await put({ ...c, fav, favAt: fav ? Date.now() : c.favAt })
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
      stateSyncRules: [],
    }
  }

  return { list, loaded, load, put, remove, toggleFav, emptyCard }
})
