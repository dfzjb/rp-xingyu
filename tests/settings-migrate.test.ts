/**
 * 旧默认地址一次性迁移：站主服务器下线后，老用户 settings 表里仍等于旧默认的地址
 * 应替换为新默认；用户自填过的值不动。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { db, DEFAULT_SETTINGS, getSettings } from '../src/db'

beforeEach(async () => {
  await db.settings.clear()
})

describe('settings 旧默认地址迁移', () => {
  it('仍等于旧默认的 dfzjb.site 地址替换为新默认并落库', async () => {
    await db.settings.put({
      ...DEFAULT_SETTINGS,
      id: 'app',
      apiBaseUrl: 'https://dfzjb.site/v1',
      plazaUrl: 'https://dfzjb.site/plaza/index.json',
      plazaUploadUrl: 'https://dfzjb.site/plaza/api/cards',
    })
    const s = await getSettings()
    expect(s.apiBaseUrl).toBe('')
    expect(s.plazaUrl).toBe('./plaza/index.json')
    expect(s.plazaUploadUrl).toBe('')
    // 落库：再读一次仍是新值
    const again = await getSettings()
    expect(again.plazaUrl).toBe('./plaza/index.json')
  })

  it('用户自填过的地址保持不动', async () => {
    await db.settings.put({
      ...DEFAULT_SETTINGS,
      id: 'app',
      apiBaseUrl: 'https://my.api.example/v1',
      plazaUrl: 'https://my.pool.example/index.json',
    })
    const s = await getSettings()
    expect(s.apiBaseUrl).toBe('https://my.api.example/v1')
    expect(s.plazaUrl).toBe('https://my.pool.example/index.json')
  })

  it('全新用户直接拿新默认，无需迁移', async () => {
    const s = await getSettings()
    expect(s.plazaUrl).toBe(DEFAULT_SETTINGS.plazaUrl)
    expect(s.apiBaseUrl).toBe('')
  })
})
