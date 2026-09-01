/**
 * 广场服务 smoke：真实起服（临时端口 + 临时目录），走完整「开放上传 → 审核 → 上架」流程。
 * fetch 会在客户端把 `..` 归一化掉，字面穿越用 node:http 原始请求行来测。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { startPlaza } from '../server/plaza.js'

const servers: Server[] = []
const roots: string[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) s.close()
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** 布局：<root>/plaza/（dataDir），<root>/secret.txt（dataDir 外的诱饵文件） */
async function start(opts: { token?: string; ratePerHour?: number; maxPending?: number; withIndex?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rp-plaza-'))
  roots.push(root)
  const dir = join(root, 'plaza')
  await mkdir(join(dir, 'cards'), { recursive: true })
  await writeFile(join(root, 'secret.txt'), 'OUTSIDE', 'utf8')
  if (opts.withIndex !== false) await writeFile(join(dir, 'index.json'), '[]', 'utf8')
  const server = startPlaza({ port: 0, dir, token: opts.token || '', ratePerHour: opts.ratePerHour, maxPending: opts.maxPending })
  servers.push(server)
  await new Promise<void>((resolve) => server.on('listening', resolve))
  const addr = server.address() as { port: number }
  return `http://127.0.0.1:${addr.port}`
}

function post(base: string, path: string, body: unknown, token = '') {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-plaza-token': token } : {}) },
    body: JSON.stringify(body),
  })
}

const postCard = (base: string, body: unknown, token = '') => post(base, '/plaza/api/cards', body, token)
const approve = (base: string, id: string, token = '') => post(base, '/plaza/api/approve', { id }, token)
const reject = (base: string, id: string, token = '') => post(base, '/plaza/api/reject', { id }, token)

async function reviewList(base: string, token = '') {
  const resp = await fetch(`${base}/plaza/api/review`, { headers: token ? { 'x-plaza-token': token } : {} })
  return { resp, body: (await resp.json()) as { pending: { id: string; filename: string; name: string; tags: string[] }[] } }
}

/** 原始请求行（不做 URL 归一化），返回状态码 */
function rawGet(base: string, path: string, token = ''): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port: Number(port), path, method: 'GET', headers: token ? { 'x-plaza-token': token } : {} }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => resolve({ status: res.statusCode || 0, body: b }))
    })
    req.on('error', reject)
    req.end()
  })
}

function uploadBody(overrides: Record<string, unknown> = {}) {
  const card = { spec: 'chara_card_v3', data: { name: '测试角色', description: 'd' } }
  return {
    filename: 'test-card.json',
    data: Buffer.from(JSON.stringify(card)).toString('base64'),
    name: '测试角色',
    description: '广场描述',
    tags: ['测试', '原创'],
    ...overrides,
  }
}

describe('广场服务 · 开放上传 + 审核上架', () => {
  it('上传进待审区（不公开）；审核通过 → 上架公开', async () => {
    const base = await start({ token: 'ADMIN' })

    // 陌生人无需口令即可上传
    const up = await postCard(base, uploadBody())
    expect(up.status).toBe(200)
    const upBody = await up.json() as { ok: boolean; id: string; status: string }
    expect(upBody.ok).toBe(true)
    expect(upBody.status).toBe('pending')
    expect(upBody.id).toMatch(/^[a-f0-9]{8}$/)

    // 未上架：清单为空、卡文件不可公开读取
    expect(await (await fetch(`${base}/plaza/index.json`)).json()).toEqual([])
    expect((await fetch(`${base}/plaza/cards/test-card.json`)).status).toBe(404)

    // 待审列表可见（口令）
    const { body } = await reviewList(base, 'ADMIN')
    expect(body.pending).toHaveLength(1)
    expect(body.pending[0].name).toBe('测试角色')
    expect(body.pending[0].filename).toBe('test-card.json')

    // 审核通过 → 上架
    const ap = await approve(base, upBody.id, 'ADMIN')
    expect(ap.status).toBe(200)
    const apBody = await ap.json() as { entry: { url: string }; absUrl: string }
    expect(apBody.entry.url).toBe('cards/test-card.json')
    expect(apBody.absUrl).toBe(`${base}/plaza/cards/test-card.json`)

    // 上架后：清单与卡文件公开可读，内容一致
    const index = await (await fetch(`${base}/plaza/index.json`)).json() as { url: string; name: string }[]
    expect(index).toEqual([{ name: '测试角色', description: '广场描述', tags: ['测试', '原创'], url: 'cards/test-card.json' }])
    const card = await (await fetch(`${base}/plaza/cards/test-card.json`)).json() as { data: { name: string } }
    expect(card.data.name).toBe('测试角色')

    // 审核队列清空
    expect((await reviewList(base, 'ADMIN')).body.pending).toHaveLength(0)
  })

  it('拒绝：待审卡被删除，永不出现在公开清单', async () => {
    const base = await start({ token: 'ADMIN' })
    const up = await (await postCard(base, uploadBody())).json() as { id: string }
    const rj = await reject(base, up.id, 'ADMIN')
    expect(rj.status).toBe(200)
    expect((await reviewList(base, 'ADMIN')).body.pending).toHaveLength(0)
    expect(await (await fetch(`${base}/plaza/index.json`)).json()).toEqual([])
    // 再拒绝（不存在）→ 404
    expect((await reject(base, up.id, 'ADMIN')).status).toBe(404)
  })

  it('重名审核上架自动追加序号', async () => {
    const base = await start({ token: 'ADMIN' })
    const a = await (await postCard(base, uploadBody({ filename: 'same.json', name: '第一张' }))).json() as { id: string }
    const b = await (await postCard(base, uploadBody({ filename: 'same.json', name: '第二张' }))).json() as { id: string }
    const urlA = ((await (await approve(base, a.id, 'ADMIN')).json()) as { entry: { url: string } }).entry.url
    const urlB = ((await (await approve(base, b.id, 'ADMIN')).json()) as { entry: { url: string } }).entry.url
    expect([urlA, urlB].sort()).toEqual(['cards/same-2.json', 'cards/same.json'])
  })

  it('审前检查：凭口令可取待审卡原文件，内容与上传一致', async () => {
    const base = await start({ token: 'ADMIN' })
    await postCard(base, uploadBody())
    const { body } = await reviewList(base, 'ADMIN')
    const id = body.pending[0].id
    const raw = await rawGet(base, `/plaza/api/review/${id}`, 'ADMIN')
    expect(raw.status).toBe(200)
    expect(JSON.parse(raw.body)).toEqual({ spec: 'chara_card_v3', data: { name: '测试角色', description: 'd' } })
    // 无口令取不到
    expect((await rawGet(base, `/plaza/api/review/${id}`)).status).toBe(403)
  })

  it('待审区不对外：/plaza/pending/* 与 review.json 无法公开读取', async () => {
    const base = await start({ token: 'ADMIN' })
    const up = await (await postCard(base, uploadBody())).json() as { id: string }
    expect((await fetch(`${base}/plaza/pending/${up.id}`)).status).toBe(404)
    expect((await fetch(`${base}/plaza/review.json`)).status).toBe(404)
    // 原始请求行穿越同样读不到
    expect((await rawGet(base, '/plaza/pending/../../secret.txt')).status).toBe(404)
    expect(await rawGet(base, '/plaza/index.json')).toMatchObject({ status: 200 })
  })

  it('管理端点口令校验：未配置口令的服务无人能审核/下架', async () => {
    const base = await start()
    const up = await (await postCard(base, uploadBody())).json() as { id: string }
    expect((await reviewList(base)).resp.status).toBe(403)
    expect((await approve(base, up.id)).status).toBe(403)
    expect((await reject(base, up.id)).status).toBe(403)
    expect((await post(base, '/plaza/api/remove', { url: 'cards/x.json' })).status).toBe(403)
    // 上传本身不受影响（开放）
    expect((await postCard(base, uploadBody({ filename: 'other.json' }))).status).toBe(200)
  })

  it('已上架卡下架：凭口令删除文件与清单条目', async () => {
    const base = await start({ token: 'ADMIN' })
    const up = await (await postCard(base, uploadBody())).json() as { id: string }
    await approve(base, up.id, 'ADMIN')
    expect((await post(base, '/plaza/api/remove', { url: 'cards/test-card.json' }, 'WRONG')).status).toBe(403)
    const ok = await post(base, '/plaza/api/remove', { url: 'cards/test-card.json' }, 'ADMIN')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, removed: 1 })
    expect((await fetch(`${base}/plaza/cards/test-card.json`)).status).toBe(404)
    expect(await (await fetch(`${base}/plaza/index.json`)).json()).toEqual([])
    expect((await post(base, '/plaza/api/remove', { url: 'cards/../../index.json' }, 'ADMIN')).status).toBe(400)
  })
})

describe('广场服务 · 校验与防灌水', () => {
  it('上传校验：非法 PNG / 坏 JSON 卡 / 文件名越界 / 缺数据 / 坏请求体，均不入待审区', async () => {
    const base = await start({ token: 'ADMIN' })
    expect((await postCard(base, uploadBody({ filename: 'fake.png', data: Buffer.from('not a png').toString('base64') }))).status).toBe(400)
    expect((await postCard(base, uploadBody({ filename: '../evil.json' }))).status).toBe(400)
    expect((await postCard(base, uploadBody({ filename: 'card.txt' }))).status).toBe(400)
    expect((await postCard(base, uploadBody({ data: '' }))).status).toBe(400)
    expect((await postCard(base, uploadBody({ data: '###' }))).status).toBe(400)
    expect((await fetch(`${base}/plaza/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })).status).toBe(400)

    // 合法 PNG 放行
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')])
    expect((await postCard(base, uploadBody({ filename: 'real.png', data: png.toString('base64') }))).status).toBe(200)
    expect((await reviewList(base, 'ADMIN')).body.pending).toHaveLength(1)
  })

  it('元数据清洗：超长截断、非字符串标签剔除', async () => {
    const base = await start({ token: 'ADMIN' })
    await postCard(base, uploadBody({
      name: 'x'.repeat(200),
      description: 'd'.repeat(999),
      tags: ['a'.repeat(99), 42, 'ok', ''],
    }))
    const { body } = await reviewList(base, 'ADMIN')
    const r = body.pending[0]
    expect(r.name.length).toBe(60)
    expect(r.tags).toEqual(['a'.repeat(20), 'ok'])
    // 上架后描述截断到 300
    const ap = await (await approve(base, r.id, 'ADMIN')).json() as { entry: { description: string } }
    expect(ap.entry.description.length).toBe(300)
  })

  it('每 IP 上传限速：超限 429，不影响读取', async () => {
    const base = await start({ ratePerHour: 2 })
    expect((await postCard(base, uploadBody({ filename: 'a.json' }))).status).toBe(200)
    expect((await postCard(base, uploadBody({ filename: 'b.json' }))).status).toBe(200)
    const third = await postCard(base, uploadBody({ filename: 'c.json' }))
    expect(third.status).toBe(429)
    expect(((await third.json()) as { error: string }).error).toContain('频繁')
    expect((await fetch(`${base}/plaza/index.json`)).status).toBe(200)
  })

  it('XFF 伪造防护：来源取最右一段（可信代理追加的），伪造左段不能换身份重置限速', async () => {
    const base = await start({ ratePerHour: 1 })
    const postCardXff = (xff: string, filename: string) => fetch(`${base}/plaza/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify(uploadBody({ filename })),
    })
    // 客户端伪造 "1.2.3.4" 在左，真实 IP "203.0.113.7" 由代理追加在右
    expect((await postCardXff('1.2.3.4, 203.0.113.7', 'a.json')).status).toBe(200)
    // 换一个伪造头试图绕过限速：真实 IP 不变 → 仍判同一来源，必须 429
    expect((await postCardXff('5.6.7.8, 203.0.113.7', 'b.json')).status).toBe(429)
    // 完全不带 XFF（直连）：回退 socket 地址，是另一个独立来源，不误伤
    expect((await postCard(base, uploadBody({ filename: 'c.json' }))).status).toBe(200)
  })

  it('待审队列上限：满员拒绝新上传，拒绝后腾出名额', async () => {
    const base = await start({ token: 'ADMIN', maxPending: 1 })
    const a = await (await postCard(base, uploadBody({ filename: 'a.json' }))).json() as { id: string }
    const full = await postCard(base, uploadBody({ filename: 'b.json' }))
    expect(full.status).toBe(429)
    expect(((await full.json()) as { error: string }).error).toContain('待审队列已满')
    await reject(base, a.id, 'ADMIN')
    expect((await postCard(base, uploadBody({ filename: 'c.json' }))).status).toBe(200)
  })

  it('数据损坏保护：review.json 损坏拒绝上传，index.json 损坏拒绝上架（原文件原样保留）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-plaza-bad-'))
    roots.push(root)
    const dir = join(root, 'plaza')
    await mkdir(join(dir, 'cards'), { recursive: true })
    await writeFile(join(dir, 'review.json'), '{broken', 'utf8')
    const server = startPlaza({ port: 0, dir, token: 'ADMIN' })
    servers.push(server)
    await new Promise<void>((resolve) => server.on('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    expect((await postCard(base, uploadBody())).status).toBe(500)
    expect(await readFile(join(dir, 'review.json'), 'utf8')).toBe('{broken')

    // 修复队列后上传成功，再弄坏 index.json → 上架必须失败且清单原样
    await writeFile(join(dir, 'review.json'), '[]', 'utf8')
    const up = await (await postCard(base, uploadBody())).json() as { id: string }
    await writeFile(join(dir, 'index.json'), '{broken2', 'utf8')
    expect((await approve(base, up.id, 'ADMIN')).status).toBe(500)
    expect(await readFile(join(dir, 'index.json'), 'utf8')).toBe('{broken2')
    // 待审卡仍在队列中，可修复后重新上架
    expect((await reviewList(base, 'ADMIN')).body.pending).toHaveLength(1)
  })
})
