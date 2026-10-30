import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, type Fiber } from 'cordis'
import {
  StoreService,
  type Collection,
  type GatewayEvent,
  type InboundMessage,
  type Query,
  type Row,
} from '@qingmei/core'
import * as GatewayPlugin from '@qingmei/service-gateway'
import type { GatewayHub } from '@qingmei/service-gateway'
import * as ChannelPlugin from '@qingmei/service-channel'
import * as WebChannelPlugin from '@qingmei/channel-web'
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

  host = ctx.plugin(HostGateway, {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    webRoot,
  })
  await host

  const info = getServerInfo(ctx)
  assert.ok(info, 'host-gateway 监听成功后应登记实际端口')
  base = info.url
})

after(async () => {
  if (host) await host.dispose()
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
  new HistoryStore(historyCtx, [
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
