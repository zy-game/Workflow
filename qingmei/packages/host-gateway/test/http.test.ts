import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Fiber } from 'cordis'
import {
  StoreService,
  ScheduleService,
  InvalidScheduleError,
  type Collection,
  type GatewayEvent,
  type InboundMessage,
  type Query,
  type Row,
  type ScheduleInput,
  type SchedulePatch,
  type Scheduled,
  HistoryService,
} from '@qingmei/core'
import * as GatewayPlugin from '@qingmei/service-gateway'
import type { GatewayHub } from '@qingmei/service-gateway'
import * as ChannelPlugin from '@qingmei/service-channel'
import * as WebChannelPlugin from '@qingmei/channel-web'
import * as StorePlugin from '@qingmei/provider-store-sqlite'
import * as MemoryPlugin from '@qingmei/provider-neuron-memory'
import HostGateway, { getServerInfo } from '../src/index.ts'

const TOKEN = 'test-token'
const auth = { authorization: `Bearer ${TOKEN}` }

let ctx: Context
let host: Fiber
let base = ''
let webRoot = ''
const inbound: InboundMessage[] = []

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

before(async () => {
  webRoot = await mkdtemp(path.join(tmpdir(), 'qm-host-gateway-'))
  await writeFile(
    path.join(webRoot, 'index.html'),
    '<!doctype html><html><body><h1>qingmei</h1></body></html>',
    'utf8',
  )
  await writeFile(path.join(webRoot, 'app.js'), 'console.log("qingmei")\n', 'utf8')

  ctx = new Context()
  ctx.on('qm/inbound', (message) => {
    inbound.push(message)
  })
  await ctx.plugin(GatewayPlugin)
  await ctx.plugin(ChannelPlugin)
  await ctx.plugin(WebChannelPlugin)
  await ctx.plugin(StorePlugin, { path: path.join(webRoot, 'memory.db') })
  await ctx.plugin(MemoryPlugin)

  host = ctx.plugin(HostGateway, {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    webRoot,
    uploadDir: path.join(webRoot, 'uploads'),
  })
  await host

  const info = getServerInfo(ctx)
  assert.ok(info, 'host-gateway 监听成功后应登记实际端口')
  base = info.url
})

after(async () => {
  if (host) await host.dispose()
  try {
    const store = ctx.reflect.get('store', false) as { close?: () => void } | undefined
    store?.close?.()
  } catch {}
  if (webRoot) await rm(webRoot, { recursive: true, force: true })
})

test('GET /healthz 无需鉴权，返回 uptime 与渠道状态', async () => {
  const res = await fetch(`${base}/healthz`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')

  const body = (await res.json()) as {
    ok: boolean
    uptime: number
    channels: { id: string; online: boolean }[]
  }
  assert.equal(body.ok, true)
  assert.equal(typeof body.uptime, 'number')
  assert.ok(Array.isArray(body.channels))
  assert.deepEqual(
    body.channels.map((channel) => channel.id),
    ['web'],
  )
  assert.equal(body.channels[0].online, true, 'channel-web 适配器应已启动')
})

test('GET / 返回 index.html，静态资源 MIME 正确', async () => {
  const index = await fetch(`${base}/`)
  assert.equal(index.status, 200)
  assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.match(await index.text(), /<h1>qingmei<\/h1>/)

  const script = await fetch(`${base}/app.js`)
  assert.equal(script.status, 200)
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.match(await script.text(), /qingmei/)
})

test('静态服务拒绝目录穿越', async () => {
  const res = await fetch(`${base}/..%2f..%2fpackage.json`)
  assert.equal(res.status, 400)
})

test('/api/v1/* 无 token 返回 401', async () => {
  const get = await fetch(`${base}/api/v1/messages?conversationId=c1`)
  assert.equal(get.status, 401)
  assert.deepEqual(await get.json(), { ok: false, error: 'unauthorized' })

  const post = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '没有 token' }),
  })
  assert.equal(post.status, 401)

  const events = await fetch(`${base}/api/v1/events`)
  assert.equal(events.status, 401, 'SSE 没有 header 也没有 query token 时必须 401')
})

test('/api/v1/* 错误 token 401，正确 token 200', async () => {
  const bad = await fetch(`${base}/api/v1/messages`, {
    headers: { authorization: 'Bearer wrong-token' },
  })
  assert.equal(bad.status, 401)

  const good = await fetch(`${base}/api/v1/messages?conversationId=c1&limit=10`, { headers: auth })
  assert.equal(good.status, 200)
  assert.deepEqual(await good.json(), [], 'store 不可用时应返回空数组')
})

test('CORS 预检：桌面跨域请求可带 Authorization', async () => {
  const preflight = await fetch(`${base}/api/v1/messages`, {
    method: 'OPTIONS',
    headers: {
      origin: 'file://',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/i)
})
test('图片上传与消息图片块', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const upload = await fetch(`${base}/api/v1/uploads`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ mime: 'image/png', data: png }),
  })
  assert.equal(upload.status, 200)
  const uploaded = (await upload.json()) as { ok: boolean; url: string }
  assert.match(uploaded.url, /^\/api\/v1\/uploads\/[a-f0-9-]+\.png$/)

  const anonymous = await fetch(`${base}${uploaded.url}`)
  assert.equal(anonymous.status, 401, '图片读取也要 token')
  const image = await fetch(`${base}${uploaded.url}?token=${TOKEN}`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.ok((await image.arrayBuffer()).byteLength > 0)

  const before = inbound.length
  const message = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ images: [uploaded.url], text: '' }),
  })
  assert.equal(message.status, 200)
  assert.equal(inbound.length, before + 1)
  const blocks = inbound.at(-1)!.blocks
  assert.deepEqual(blocks[0], { type: 'image', url: uploaded.url })
  assert.equal((blocks[1] as { text: string }).text, '[图片]')
})

test('POST /api/v1/messages 构造 InboundMessage 并触发 qm/inbound', async () => {
  const before = inbound.length
  const res = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好青梅', conversationId: 'conv-1' }),
  })
  assert.equal(res.status, 200)

  const body = (await res.json()) as { ok: boolean; platformMessageId: string }
  assert.equal(body.ok, true)
  assert.match(body.platformMessageId, /^msg_/)

  assert.equal(inbound.length, before + 1)
  const message = inbound.at(-1)
  assert.ok(message)
  assert.equal(message.platformMessageId, body.platformMessageId)
  assert.equal(message.channel, 'web')
  assert.equal(message.accountId, 'web')
  assert.deepEqual(message.conversation, { kind: 'dm', id: 'conv-1' })
  assert.deepEqual(message.sender, { platformUserId: 'owner', displayName: '我' })
  assert.equal(message.blocks.length, 1)
  assert.equal(message.blocks[0].type, 'text')
  assert.equal((message.blocks[0] as { text: string }).text, '你好青梅')
  assert.ok(message.receivedAt instanceof Date)
})

test('POST /api/v1/messages 非法 body 返回 400', async () => {
  const empty = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  })
  assert.equal(empty.status, 400)

  const notJson = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: 'not-json',
  })
  assert.equal(notJson.status, 400)
})

test('GET /api/v1/events 先发 ready，再转发 gateway 事件', async () => {
  const controller = new AbortController()
  // 浏览器 EventSource 不能设置 Authorization header，与 apps/web/public/app.js 保持一致走 query token。
  const res = await fetch(`${base}/api/v1/events?token=${encodeURIComponent(TOKEN)}`, {
    signal: controller.signal,
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/)
  assert.ok(res.body, 'SSE 响应必须有 body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const readUntil = async (needle: string): Promise<void> => {
    while (!buffer.includes(needle)) {
      const { value, done } = await withTimeout(reader.read(), 3000, `等待 ${needle}`)
      if (done) throw new Error(`SSE 流提前结束，已收到：${buffer}`)
      buffer += decoder.decode(value, { stream: true })
    }
  }

  try {
    await readUntil('event: ready')
    ;(ctx.gateway as GatewayHub).publish({ type: 'assistant', data: { text: 'hello' } })
    await readUntil('event: assistant')
    assert.ok(buffer.includes('data: {"text":"hello"}'))
  } finally {
    controller.abort()
    await reader.cancel().catch(() => {})
  }
})

test('GET /api/v1/messages 从 qm_message 读取历史并按会话裁剪', async () => {
  const historyCtx = new Context()
  await historyCtx.plugin(GatewayPlugin)
  await historyCtx.plugin(FakeHistory, [
    { id: 'm1', session_id: 's_conv-1', role: 'user', text: '早上好', created_at: 100 },
    { id: 'm2', session_id: 's_conv-1', role: 'assistant', text: '早上好呀', created_at: 200 },
    { id: 'm3', session_id: 's_conv-2', role: 'user', text: '另一段对话', created_at: 300 },
  ])

  const historyHost = historyCtx.plugin(HostGateway, {
    host: '127.0.0.1',
    port: 0,
    token: 'history-token',
    webRoot,
  })
  await historyHost
  const info = getServerInfo(historyCtx)
  assert.ok(info)
  const headers = { authorization: 'Bearer history-token' }

  try {
    const all = await fetch(`${info.url}/api/v1/messages?conversationId=conv-1&limit=10`, { headers })
    assert.equal(all.status, 200)
    assert.deepEqual(
      ((await all.json()) as HistoryRow[]).map((row) => row.id),
      ['m1', 'm2'],
    )

    const latest = await fetch(`${info.url}/api/v1/messages?conversationId=conv-1&limit=1`, { headers })
    assert.deepEqual(
      ((await latest.json()) as HistoryRow[]).map((row) => row.id),
      ['m2'],
    )

    const other = await fetch(`${info.url}/api/v1/messages?conversationId=conv-2`, { headers })
    assert.deepEqual(
      ((await other.json()) as HistoryRow[]).map((row) => row.id),
      ['m3'],
    )
  } finally {
    await historyHost.dispose()
  }
})

test('GET /api/v1/schedules 无 schedule 服务时 503', async () => {
  const res = await fetch(`${base}/api/v1/schedules`, { headers: auth })
  assert.equal(res.status, 503)
  assert.deepEqual(await res.json(), { ok: false, error: 'no schedule service' })
})

test('GET /api/v1/schedules 列出日程，DELETE 取消后消失', async () => {
  const scheduleCtx = new Context()
  await scheduleCtx.plugin(GatewayPlugin)
  const schedule = new FakeSchedule(scheduleCtx)

  const scheduleHost = scheduleCtx.plugin(HostGateway, {
    host: '127.0.0.1',
    port: 0,
    token: 'schedule-token',
    webRoot,
  })
  await scheduleHost
  const info = getServerInfo(scheduleCtx)
  assert.ok(info)
  const headers = { authorization: 'Bearer schedule-token' }

  try {
    const res = await fetch(`${info.url}/api/v1/schedules`, { headers })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean; items: Record<string, unknown>[] }
    assert.equal(body.ok, true)
    assert.equal(body.items.length, 2)
    assert.deepEqual(body.items[0], {
      id: 'r_cron',
      text: '每天九点喝水',
      channel: 'web',
      conversationId: 'owner',
      nextAt: '2026-10-31T01:00:00.000Z',
      everyMs: null,
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      missedPolicy: 'fire-once',
      pausedAt: null,
      firedAt: null,
    })
    // 已触发的一次性提醒仍然列出，但 firedAt 有值
    assert.equal(body.items[1]?.id, 'r_once')
    assert.equal(body.items[1]?.firedAt, '2026-10-29T23:00:01.000Z')

    const unauth = await fetch(`${info.url}/api/v1/schedules`)
    assert.equal(unauth.status, 401)

    const unauthPatch = await fetch(`${info.url}/api/v1/schedules/r_cron`, { method: 'PATCH', body: '{}' })
    assert.equal(unauthPatch.status, 401)

    const patched = await fetch(`${info.url}/api/v1/schedules/r_cron`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '改名后的喝水' }),
    })
    assert.equal(patched.status, 200)
    const patchedBody = (await patched.json()) as { ok: boolean; item: Scheduled }
    assert.equal(patchedBody.ok, true)
    assert.equal(patchedBody.item.id, 'r_cron')
    assert.equal(patchedBody.item.text, '改名后的喝水')

    const emptyPatch = await fetch(`${info.url}/api/v1/schedules/r_cron`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(emptyPatch.status, 400)

    const badPatch = await fetch(`${info.url}/api/v1/schedules/r_cron`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: 'not-json',
    })
    assert.equal(badPatch.status, 400)

    const missingPatch = await fetch(`${info.url}/api/v1/schedules/r_nope`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    })
    assert.equal(missingPatch.status, 404)
    assert.deepEqual(await missingPatch.json(), { ok: false, error: '这条提醒不存在或已经结束' })

    // 参数不合法是 400，不是 500
    const badRule = await fetch(`${info.url}/api/v1/schedules/r_cron`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ cron: '0 9 * *' }),
    })
    assert.equal(badRule.status, 400)
    assert.deepEqual(await badRule.json(), { ok: false, error: 'cron 表达式必须是 5 段' })

    const missing = await fetch(`${info.url}/api/v1/schedules/r_nope`, { method: 'DELETE', headers })
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { ok: false, error: '没有找到这条提醒' })

    const blank = await fetch(`${info.url}/api/v1/schedules/`, { method: 'DELETE', headers })
    assert.equal(blank.status, 400)

    const unauthPause = await fetch(`${info.url}/api/v1/schedules/r_cron/pause`, { method: 'POST' })
    assert.equal(unauthPause.status, 401)

    const paused = await fetch(`${info.url}/api/v1/schedules/r_cron/pause`, { method: 'POST', headers })
    assert.equal(paused.status, 200)
    assert.deepEqual(await paused.json(), { ok: true, state: 'paused' })
    assert.deepEqual(schedule.paused, ['r_cron'])

    const resumed = await fetch(`${info.url}/api/v1/schedules/r_cron/resume`, { method: 'POST', headers })
    assert.equal(resumed.status, 200)
    assert.deepEqual(await resumed.json(), { ok: true, state: 'active' })
    assert.deepEqual(schedule.resumed, ['r_cron'])

    const pauseMissing = await fetch(`${info.url}/api/v1/schedules/r_nope/pause`, { method: 'POST', headers })
    assert.equal(pauseMissing.status, 404)
    assert.deepEqual(await pauseMissing.json(), { ok: false, error: '这条提醒不存在或已经结束' })

    // 已触发的一次性提醒不能再暂停/继续
    const pauseFired = await fetch(`${info.url}/api/v1/schedules/r_once/resume`, { method: 'POST', headers })
    assert.equal(pauseFired.status, 404)

    const removed = await fetch(`${info.url}/api/v1/schedules/r_cron`, { method: 'DELETE', headers })
    assert.equal(removed.status, 200)
    assert.deepEqual(await removed.json(), { ok: true, cancelled: true })
    assert.deepEqual(schedule.cancelled, ['r_cron'])

    const after = (await (await fetch(`${info.url}/api/v1/schedules`, { headers })).json()) as {
      items: { id: string }[]
    }
    assert.deepEqual(
      after.items.map((item) => item.id),
      ['r_once'],
    )
  } finally {
    await scheduleHost.dispose()
  }
})

test('channel-web 的 send 把信封作为 assistant 事件广播', async () => {
  const gateway = ctx.gateway as GatewayHub
  const events: GatewayEvent[] = []
  const dispose = gateway.subscribe((event) => events.push(event))

  const result = await ctx.channel.send({
    channel: 'web',
    conversationId: 'conv-1',
    blocks: [{ type: 'text', text: '你好' }],
  })
  dispose()

  assert.equal(result.ok, true)
  assert.match(result.platformMessageId ?? '', /^msg_/)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'assistant')
  assert.deepEqual(events[0].data, {
    channel: 'web',
    conversationId: 'conv-1',
    blocks: [{ type: 'text', text: '你好' }],
  })
})

test('channel.send 对未注册渠道返回 no adapter', async () => {
  const result = await ctx.channel.send({
    channel: 'qq',
    conversationId: 'conv-1',
    blocks: [{ type: 'text', text: 'hi' }],
  })
  assert.deepEqual(result, { ok: false, error: 'no adapter' })
})

test('gateway.route 注册的接口可经网关访问，撤销后 404', async () => {
  const dispose = ctx.gateway.route({
    method: 'GET',
    path: '/api/v1/ping',
    handler(req, res) {
      res.status(200).send({ pong: req.query.q ?? null })
    },
  })

  const res = await fetch(`${base}/api/v1/ping?q=1`, { headers: auth })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { pong: '1' })

  dispose()

  const gone = await fetch(`${base}/api/v1/ping?q=1`, { headers: auth })
  assert.equal(gone.status, 404)
})

interface HistoryRow extends Row {
  session_id: string
  role: string
  text: string
  created_at: number
}

class FakeHistory extends HistoryService {
  private readonly rows: HistoryRow[]

  constructor(ctx: Context, rows: HistoryRow[]) {
    super(ctx)
    this.rows = rows
  }

  async recent(conversationId: string, limit = 50) {
    const wanted = conversationId.startsWith('s_') ? conversationId : `s_${conversationId}`
    return this.rows
      .filter((row) => row.session_id === conversationId || row.session_id === wanted)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(-Math.max(1, Math.min(200, limit)))
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role as 'user' | 'assistant',
        text: row.text,
        blocks: [{ type: 'text' as const, text: row.text }],
        createdAt: new Date(row.created_at),
      }))
  }
}
/** 只实现 host-gateway 读取历史所需的最小 store，用来验证 qm_message 的读取路径。 */
class HistoryStore extends StoreService {
  private readonly rows: HistoryRow[]

  constructor(ctx: Context, rows: HistoryRow[]) {
    super(ctx)
    this.rows = rows
  }

  async ready(): Promise<void> {}

  collection<T extends Row>(name: string): Collection<T> {
    if (name !== 'qm_message') throw new Error(`测试 store 只实现 qm_message，收到 ${name}`)
    const rows = this.rows
    return {
      async get(id) {
        return (rows.find((row) => row.id === id) as T | undefined) ?? null
      },
      async find(_query: Query<T> = {}) {
        return [...rows] as unknown as T[]
      },
      async insert() {
        throw new Error('测试 store 不支持 insert')
      },
      async update() {
        throw new Error('测试 store 不支持 update')
      },
      async delete() {
        throw new Error('测试 store 不支持 delete')
      },
      async count() {
        return rows.length
      },
    }
  }
}

/** 只实现 host-gateway 读取/取消/暂停日程所需的最小日程服务。 */
class FakeSchedule extends ScheduleService {
  readonly cancelled: string[] = []
  readonly paused: string[] = []
  readonly resumed: string[] = []
  private items: Scheduled[] = [
    {
      id: 'r_cron',
      text: '每天九点喝水',
      channel: 'web',
      conversationId: 'owner',
      nextAt: new Date('2026-10-31T01:00:00.000Z'),
      everyMs: null,
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      missedPolicy: 'fire-once',
      pausedAt: null,
      firedAt: null,
    },
    {
      id: 'r_once',
      text: '开会',
      channel: 'web',
      conversationId: 'owner',
      nextAt: new Date('2026-10-29T23:00:00.000Z'),
      everyMs: null,
      cron: null,
      timezone: null,
      missedPolicy: 'fire-once',
      pausedAt: null,
      firedAt: new Date('2026-10-29T23:00:01.000Z'),
    },
  ]

  async create(_input: ScheduleInput): Promise<Scheduled> {
    throw new Error('测试日程服务不支持 create')
  }

  async list(): Promise<Scheduled[]> {
    return [...this.items]
  }

  async cancel(id: string): Promise<boolean> {
    const index = this.items.findIndex((item) => item.id === id)
    if (index < 0) return false
    this.items = this.items.filter((item) => item.id !== id)
    this.cancelled.push(id)
    return true
  }

  async pause(id: string): Promise<boolean> {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.firedAt) return false
    if (!item.pausedAt) item.pausedAt = new Date('2026-10-30T12:00:00.000Z')
    this.paused.push(id)
    return true
  }

  async resume(id: string): Promise<boolean> {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.firedAt) return false
    item.pausedAt = null
    this.resumed.push(id)
    return true
  }

  async update(id: string, patch: SchedulePatch): Promise<Scheduled | null> {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.firedAt) return null
    if (patch.cron !== undefined && patch.cron.trim().split(/\s+/).length !== 5) {
      throw new InvalidScheduleError('cron 表达式必须是 5 段')
    }
    if (patch.text !== undefined) item.text = patch.text
    return item
  }
}

test('记忆页 API：列表 / 修正 / 删除', async () => {
  type MemoryLike = {
    ingest: (records: unknown[]) => Promise<{ created: string[] }>
    listFacts: () => Promise<{ id: string; object: string }[]>
  }
  const memory = ctx.reflect.get('memory', false) as MemoryLike
  assert.ok(memory, '测试环境应加载 memory 服务')
  await memory.ingest([
    {
      kind: 'fact',
      subject: '主人',
      predicate: '喜欢',
      object: '黑咖啡',
      confidence: 0.9,
      sensitivity: 'private',
      origin: { kind: 'manual', id: 'test' },
    },
  ])
  const list = await fetch(`${base}/api/v1/memory/facts`, { headers: auth })
  assert.equal(list.status, 200)
  const listed = (await list.json()) as { facts: { id: string; object: string }[] }
  const fact = listed.facts.find((item) => item.object === '黑咖啡')
  assert.ok(fact, '应能列出刚写入的事实')

  const patch = await fetch(`${base}/api/v1/memory/facts/${fact.id}`, {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ object: '加奶咖啡' }),
  })
  assert.equal(patch.status, 200)

  const del = await fetch(`${base}/api/v1/memory/facts/${fact.id}`, { method: 'DELETE', headers: auth })
  assert.equal(del.status, 200)
  const after = (await (await fetch(`${base}/api/v1/memory/facts`, { headers: auth })).json()) as {
    facts: { object: string }[]
  }
  assert.equal(after.facts.some((item) => item.object === '加奶咖啡'), false)
})

test('admin 登录：返回 token + HttpOnly 会话，Cookie 可访问 API', async () => {
  const login = await fetch(`${base}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QM-Client': 'mobile' },
    body: JSON.stringify({ user: 'admin', password: TOKEN }),
  })
  assert.equal(login.status, 200)
  const body = (await login.json()) as { ok: boolean; token: string }
  assert.equal(body.ok, true)
  assert.equal(body.token, TOKEN)
  const cookie = login.headers.get('set-cookie') || ''
  assert.match(cookie, /qm_session=/)
  assert.match(cookie, /HttpOnly/)

  const session = await fetch(`${base}/api/v1/session`, {
    headers: { Cookie: cookie.split(';')[0] },
  })
  assert.equal(session.status, 200)

  const history = await fetch(`${base}/api/v1/messages?limit=1`, {
    headers: { Cookie: cookie.split(';')[0] },
  })
  assert.equal(history.status, 200)
})
