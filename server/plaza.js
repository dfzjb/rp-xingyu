/**
 * 角色卡广场服务 —— 卡片托管 + 开放上传 + 审核上架（零依赖，node:http）
 *
 * 与跑团中继（server/index.js）分开：中继承诺零持久化，广场则必须落盘。
 *
 * 内容流：陌生人上传 → 待审区（不公开、不进清单）→ 站主审核 → 上架公开。
 * 目录结构：
 *   <dir>/index.json   公开清单（仅含已上架卡）
 *   <dir>/cards/       已上架卡文件（公开可读）
 *   <dir>/pending/     待审卡文件（不对外提供下载）
 *   <dir>/review.json  待审队列元数据
 *
 * 端点：
 * - POST /plaza/api/cards        开放上传（无需口令）→ 进待审区
 * - GET  /plaza/api/review       管理口令 → 待审列表
 * - GET  /plaza/api/review/<id>  管理口令 → 取待审卡原文件（审前检查用）
 * - POST /plaza/api/approve      管理口令 → 上架
 * - POST /plaza/api/reject       管理口令 → 拒绝并删除
 * - POST /plaza/api/remove       管理口令 → 下架已上架卡
 * - GET  /plaza/api/ping         探活
 * - GET  /plaza/index.json、/plaza/cards/*  公开静态（白名单，不含待审区）
 *
 * 环境变量：
 * - PLAZA_PORT           监听端口（默认 8788）
 * - PLAZA_DIR            广场数据目录（默认仓库内 public/plaza）
 * - PLAZA_TOKEN          管理口令（审核/下架凭据；生产必配，否则无人能上架）
 * - PLAZA_RATE_PER_HOUR  单 IP 每小时上传上限（默认 60）
 * - PLAZA_MAX_PENDING    待审队列上限（默认 200，防灌水）
 *
 * 部署提示：只经 nginx 反代对外（HTTPS），8788 不对公网放行；
 * nginx 需设置 X-Forwarded-For 与 client_max_body_size（见 deploy/nginx-plaza.conf）。
 */
import { createServer } from 'node:http'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MAX_BODY = 6 * 1024 * 1024 // 上传 JSON 上限（base64 卡数据；PNG 卡含图常见 1~3MB）
const MAX_TAGS = 8
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CARD_FILE_RE = /^cards\/[A-Za-z0-9._-]{1,120}\.(png|json)$/ // 下架目标白名单
const ID_RE = /^[a-f0-9]{8}$/ // 待审记录 id

const DEFAULT_DIR = fileURLToPath(new URL('../public/plaza/', import.meta.url))

/** 串行化清单/队列写入（防并发互相覆盖） */
let writeChain = Promise.resolve()

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

function fileResponse(res, status, buf, type) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(buf)
}

/** 读取请求体；超限则掐断连接并返回 null */
function readBody(req, max) {
  return new Promise((done) => {
    let raw = ''
    let broken = false
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > max) {
        broken = true
        req.destroy()
      }
    })
    req.on('error', () => { broken = true })
    req.on('end', () => done(broken ? null : raw))
  })
}

/** 读 JSON 数组文件：缺失 → []，损坏 → 抛错（调用方拒绝写入以免覆盖） */
async function readJsonList(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data : (Array.isArray(data.cards) ? data.cards : [])
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw new Error(`${file.split(/[\\/]/).pop()} 读取/解析失败，拒绝写入以免覆盖已有数据`)
  }
}

function cleanText(v, max) {
  return String(v ?? '').trim().slice(0, max)
}

/** 文件名白名单：仅字母数字._-，扩展名限 .png/.json */
function safeCardName(raw) {
  const name = String(raw ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,120}\.(png|json)$/.test(name)) return ''
  return name
}

/** 重名时追加序号：xx.png → xx-2.png → … */
async function uniqueName(dir, name) {
  if (!existsSync(join(dir, 'cards', name))) return name
  const dot = name.lastIndexOf('.')
  const base = name.slice(0, dot)
  const ext = name.slice(dot)
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}${ext}`
    if (!existsSync(join(dir, 'cards', candidate))) return candidate
    if (i > 999) return `${base}-${Date.now().toString(36)}${ext}`
  }
}

/**
 * X-Forwarded-* 取最右一段：本站唯一可信代理（nginx）追加的值在最右，
 * 客户端自带的伪造头只会出现在左边，取最右即可不受伪造影响。
 */
function lastForwarded(value) {
  const parts = String(value || '').split(',').map((s) => s.trim()).filter(Boolean)
  return parts[parts.length - 1] || ''
}

function schemeOf(req) {
  return lastForwarded(req.headers['x-forwarded-proto']) || 'http'
}

/** 来源 IP（nginx 必须设置 X-Forwarded-For；限速与下架审计的依据） */
function ipOf(req) {
  return lastForwarded(req.headers['x-forwarded-for']) || req.socket.remoteAddress || '?'
}

/** 管理口令校验：必须已配置且匹配 */
function adminOk(token, req) {
  return !!token && req.headers['x-plaza-token'] === token
}

/**
 * 启动广场服务（测试传 port=0 取临时端口；生产 PLAZA_PORT 直启）
 * @returns {import('node:http').Server}
 */
export function startPlaza({
  port = 0,
  dir = DEFAULT_DIR,
  token = '',
  ratePerHour = Number(process.env.PLAZA_RATE_PER_HOUR || 60),
  maxPending = Number(process.env.PLAZA_MAX_PENDING || 200),
} = {}) {
  const dataDir = resolve(dir)
  const cardsDir = join(dataDir, 'cards')
  const pendingDir = join(dataDir, 'pending')
  const reviewFile = join(dataDir, 'review.json')
  const indexFile = join(dataDir, 'index.json')

  // 每 IP 滑动窗口限速：ip -> 时间戳数组
  const hits = new Map()
  const allowUpload = (ip) => {
    const now = Date.now()
    const arr = (hits.get(ip) || []).filter((t) => now - t < 3_600_000)
    if (arr.length >= ratePerHour) {
      hits.set(ip, arr)
      return false
    }
    arr.push(now)
    hits.set(ip, arr)
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.length) hits.delete(k)
    return true
  }

  const server = createServer(async (req, res) => {
    // CORS：广场索引/卡片是公开资源，上传/审核来源（Pages、本地 dev）与服务器不同源
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type, x-plaza-token')
    res.setHeader('access-control-max-age', '86400')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    } catch {
      return json(res, 400, { error: '路径无效' })
    }

    // ── 开放上传：进待审区，不公开、不进清单 ──
    if (req.method === 'POST' && pathname === '/plaza/api/cards') {
      if (!allowUpload(ipOf(req))) {
        return json(res, 429, { error: '上传太频繁，请稍后再试' })
      }
      const raw = await readBody(req, MAX_BODY)
      if (raw === null) return
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' })
      }
      const filename = safeCardName(body.filename)
      if (!filename) return json(res, 400, { error: '文件名不合法（仅支持 .png/.json）' })
      if (typeof body.data !== 'string' || !body.data) return json(res, 400, { error: '缺少卡数据' })
      const buf = Buffer.from(body.data, 'base64')
      if (!buf.length) return json(res, 400, { error: '卡数据为空' })
      if (filename.endsWith('.png') && !buf.subarray(0, 8).equals(PNG_SIG)) {
        return json(res, 400, { error: '不是有效的 PNG 文件' })
      }
      if (filename.endsWith('.json')) {
        try { JSON.parse(buf.toString('utf8')) } catch {
          return json(res, 400, { error: 'JSON 卡解析失败' })
        }
      }
      const record = {
        id: '',
        filename,
        name: cleanText(body.name, 60) || '未命名角色',
        description: cleanText(body.description, 300),
        tags: Array.isArray(body.tags)
          ? body.tags.filter((t) => typeof t === 'string').slice(0, MAX_TAGS).map((t) => cleanText(t, 20)).filter(Boolean)
          : [],
        submittedAt: Date.now(),
        from: ipOf(req),
      }

      writeChain = writeChain.then(async () => {
        const queue = await readJsonList(reviewFile)
        if (queue.length >= maxPending) {
          return json(res, 429, { error: '待审队列已满，请稍后再试或联系站主' })
        }
        await mkdir(pendingDir, { recursive: true })
        do { record.id = randomUUID().slice(0, 8) } while (queue.some((r) => r.id === record.id) || existsSync(join(pendingDir, record.id)))
        await writeFile(join(pendingDir, record.id), buf)
        queue.push(record)
        await writeFile(reviewFile, JSON.stringify(queue, null, 2))
        return json(res, 200, { ok: true, id: record.id, status: 'pending' })
      }).catch((err) => json(res, 500, { error: `写入失败：${err.message}` }))
      return
    }

    // ── 审核：待审列表 ──
    if (req.method === 'GET' && pathname === '/plaza/api/review') {
      if (!adminOk(token, req)) return json(res, 403, { error: token ? '口令错误' : '服务端未配置 PLAZA_TOKEN，无法审核' })
      try {
        const queue = await readJsonList(reviewFile)
        return json(res, 200, { ok: true, pending: queue })
      } catch (err) {
        return json(res, 500, { error: err.message })
      }
    }

    // ── 审核：取待审卡原文件（审前人工检查） ──
    const reviewFileMatch = pathname.match(/^\/plaza\/api\/review\/([a-f0-9]{8})$/)
    if (req.method === 'GET' && reviewFileMatch) {
      if (!adminOk(token, req)) return json(res, 403, { error: token ? '口令错误' : '服务端未配置 PLAZA_TOKEN，无法审核' })
      const record = (await readJsonList(reviewFile)).find((r) => r && r.id === reviewFileMatch[1])
      if (!record) return json(res, 404, { error: '待审记录不存在' })
      try {
        const buf = await readFile(join(pendingDir, record.id))
        return fileResponse(res, 200, buf, record.filename.endsWith('.png') ? 'image/png' : 'application/json; charset=utf-8')
      } catch {
        return json(res, 404, { error: '待审文件已丢失' })
      }
    }

    // ── 审核：通过 / 拒绝 ──
    if (req.method === 'POST' && (pathname === '/plaza/api/approve' || pathname === '/plaza/api/reject')) {
      if (!adminOk(token, req)) return json(res, 403, { error: token ? '口令错误' : '服务端未配置 PLAZA_TOKEN，无法审核' })
      const raw = await readBody(req, 65_536)
      if (raw === null) return
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' })
      }
      const id = String(body.id || '')
      if (!ID_RE.test(id)) return json(res, 400, { error: '待审 id 不合法' })
      const approving = pathname.endsWith('/approve')

      writeChain = writeChain.then(async () => {
        const queue = await readJsonList(reviewFile)
        const record = queue.find((r) => r && r.id === id)
        if (!record) return json(res, 404, { error: '待审记录不存在' })
        const pendingFile = join(pendingDir, id)

        if (approving) {
          await mkdir(cardsDir, { recursive: true })
          const url = `cards/${await uniqueName(dataDir, record.filename)}`
          await rename(pendingFile, join(dataDir, url)) // 同盘原子移动
          const list = await readJsonList(indexFile)
          list.push({ name: record.name, description: record.description, tags: record.tags, url })
          await writeFile(indexFile, JSON.stringify(list, null, 2))
          await writeFile(reviewFile, JSON.stringify(queue.filter((r) => r.id !== id), null, 2))
          const host = req.headers.host || 'localhost'
          return json(res, 200, { ok: true, entry: { name: record.name, description: record.description, tags: record.tags, url }, absUrl: `${schemeOf(req)}://${host}/plaza/${url}` })
        }

        await rm(pendingFile, { force: true })
        await writeFile(reviewFile, JSON.stringify(queue.filter((r) => r.id !== id), null, 2))
        return json(res, 200, { ok: true, rejected: id })
      }).catch((err) => json(res, 500, { error: `操作失败：${err.message}` }))
      return
    }

    // ── 下架：删除已上架卡（上架后发现违规的刹车） ──
    if (req.method === 'POST' && pathname === '/plaza/api/remove') {
      if (!adminOk(token, req)) return json(res, 403, { error: token ? '口令错误' : '服务端未配置 PLAZA_TOKEN，无法下架' })
      const raw = await readBody(req, 65_536)
      if (raw === null) return
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' })
      }
      const url = String(body.url || '')
      if (!CARD_FILE_RE.test(url)) return json(res, 400, { error: '卡地址不合法' })

      writeChain = writeChain.then(async () => {
        const file = url.slice('cards/'.length)
        await rm(join(cardsDir, file), { force: true })
        const list = await readJsonList(indexFile)
        const next = list.filter((e) => e && e.url !== url)
        await writeFile(indexFile, JSON.stringify(next, null, 2))
        return json(res, 200, { ok: true, removed: list.length - next.length })
      }).catch((err) => json(res, 500, { error: `删除失败：${err.message}` }))
      return
    }

    if (req.method !== 'GET') return json(res, 405, { error: '方法不允许' })

    // ── 探活（前端配置完地址可先试一下） ──
    if (pathname === '/plaza/api/ping') {
      return json(res, 200, { ok: true, upload: true, tokenRequired: !!token })
    }

    // ── 公开静态：白名单，只服务 index.json 与 cards/*（待审区永不公开） ──
    if (pathname === '/plaza/index.json') {
      try {
        return fileResponse(res, 200, await readFile(indexFile), 'application/json; charset=utf-8')
      } catch (err) {
        if (err.code === 'ENOENT') return json(res, 200, []) // 全新空目录：首次上架前清单视为空
        return json(res, 404, { error: '清单不存在' })
      }
    }
    const cardMatch = pathname.match(/^\/plaza\/(cards\/[A-Za-z0-9._-]{1,120}\.(png|json))$/)
    if (cardMatch) {
      try {
        const buf = await readFile(join(dataDir, cardMatch[1]))
        return fileResponse(res, 200, buf, cardMatch[2] === 'png' ? 'image/png' : 'application/json; charset=utf-8')
      } catch {
        return json(res, 404, { error: '文件不存在' })
      }
    }
    if (pathname.startsWith('/plaza/')) return json(res, 404, { error: '文件不存在' })

    return json(res, 404, { error: '未知路径' })
  })

  server.listen(port)
  return server
}

// 直接运行时启动生产监听（被测试导入时不自动监听固定端口）
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const port = Number(process.env.PLAZA_PORT || 8788)
  const dir = process.env.PLAZA_DIR || DEFAULT_DIR
  const token = process.env.PLAZA_TOKEN || ''
  startPlaza({ port, dir, token })
  console.log(`[rp-plaza] plaza server on http://0.0.0.0:${port}  dir=${resolve(dir)}  review=on${token ? '  (admin token set)' : '  (WARNING: PLAZA_TOKEN 未配置，无人能审核上架)'}`)
}
