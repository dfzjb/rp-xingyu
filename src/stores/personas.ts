import { defineStore } from 'pinia'
import { ref } from 'vue'
import { db } from '../db'
import type { Persona } from '../types'
import { uuid } from '../lib/id'
import { deepPlain } from '../lib/plain'

export const usePersonasStore = defineStore('personas', () => {
  const list = ref<Persona[]>([])
  const activeUuid = ref<string>('')
  const loaded = ref(false)

  async function load() {
    const s = await db.settings.get('app')
    activeUuid.value = s?.activePersonaUuid || ''
    list.value = await db.personas.toArray()
    // 没有任何 persona 时给一个默认
    if (!list.value.length) {
      const def: Persona = {
        uuid: uuid(), name: '我', description: '', person: 'second', avatar: '',
      }
      await db.personas.put(def)
      list.value = [def]
    }
    if (!activeUuid.value || !list.value.some((p) => p.uuid === activeUuid.value)) {
      activeUuid.value = list.value[0]?.uuid || ''
    }
    loaded.value = true
  }

  async function setActive(uuidStr: string) {
    activeUuid.value = uuidStr
    await db.settings.where('id').equals('app').modify({ activePersonaUuid: uuidStr })
  }

  async function put(p: Persona) {
    await db.personas.put(deepPlain(p))
    const i = list.value.findIndex((x) => x.uuid === p.uuid)
    if (i >= 0) list.value[i] = p
    else list.value.push(p)
  }

  async function remove(uuidStr: string) {
    await db.personas.delete(uuidStr)
    list.value = list.value.filter((p) => p.uuid !== uuidStr)
    if (activeUuid.value === uuidStr && list.value.length) {
      await setActive(list.value[0].uuid)
    }
  }

  function empty(): Persona {
    return { uuid: uuid(), name: '', description: '', person: 'second', avatar: '' }
  }

  return { list, activeUuid, loaded, load, setActive, put, remove, empty }
})
