import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as hotspotPlugin from '../src/index.ts'
import {
  ChannelService,
  type GatewayRequest,
  type GatewayResponse,
  type OutboundEnvelope,
  type SendResult,
  type StoreService,
} from '@qingmei/core'

class FakeChannel extends ChannelService {
  readonly sent: OutboundEnvelope[] = []
  async register(): Promise<() => void> {
    return () => undefined
  }
  async send(envelope: OutboundEnvelope): Promise<SendResult> {
    this.sent.push(envelope)
    return { ok: true, platformMessageId: `out_${this.sent.length}` }
  }
  status() {
    return [{ id: 'web' as const, online: true }]
  }
}

interface FakeResponse {
  res: GatewayResponse
  read(): { status: number; body: unknown }
}

function fakeResponse(): FakeResponse {
  let status = 0
  let body: unknown
  const res: GatewayResponse = {
    status(code) {
      status = code
      return res
    },
    header() {
      return res
    },
    send(value) {
      body = value
      return res
    },
  }
  return { res, read: () => ({ status, body }) }
}

async function setup(maxRatio = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-hotspot-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'mem.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const channel = new FakeChannel(ctx)
  const pluginFiber = ctx.plugin(hotspotPlugin, {
    auto: false,
    maxRatio,
    maxDelta: 0.05,
    clock: () => new Date('2026-11-03T03:00:00Z'),
  })
  await pluginFiber
  const store = ctx.reflect.get('store', false) as StoreService

  return {
    ctx,
    store,
    channel,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await pluginFiber.dispose()
      await storeFiber.dispose()
    },
  }
}

async function seed(h) {
  const facts = h.store.collection('qm_mem_fact')
  const now = new Date('2026-11-03T03:00:00Z').getTime()
  let index = 0
  const add = async (overrides) => {
    index += 1
    await facts.insert({
      id: `f${index}`,
      subject: `主题${index}`,
      predicate: '是',
      object: `值${index}`,
      audience: 'owner',
      salience: 0.5,
      confidence: 0.8,
      created_at: now - 5 * 24 * 60 * 60 * 1000,
      hits: 0,
      valid_to: null,
      ...overrides,
    })
  }
  for (let i = 0; i < 3; i += 1) await add({ hits: 5, last_fired_at: now - 1000 })
  for (let i = 0; i < 2; i += 1) await add({ created_at: now - 40 * 24 * 60 * 60 * 1000 })
  for (let i = 0; i < 5; i += 1) await add({})
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(hotspotPlugin.name, 'qm-memory-hotspot')
  assert.deepEqual(hotspotPlugin.inject, ['store', 'channel', 'gateway'])
})

test('热点调整：常用 +0.05、长期未用 -0.05，且可回滚', async () => {
  const h = await setup(1)
  try {
    await seed(h)
    const runs = await h.call({ method: 'POST', path: '/api/v1/memory/hotspot/run', query: {}, headers: {} })
    assert.equal(runs.status, 200)
    const changes = (runs.body as { changes: { id: string; before: number; after: number; reason: string }[] }).changes
    assert.equal(changes.length, 5)
    assert.equal(changes.filter((item) => item.after > item.before).length, 3)
    assert.equal(changes.filter((item) => item.after < item.before).length, 2)

    const facts = h.store.collection('qm_mem_fact')
    const changed = changes.find((item) => item.after > item.before)!
    const stored = await facts.get(changed.id)
    assert.ok(Math.abs(Number(stored?.salience) - changed.after) < 1e-9)

    const id = (runs.body as { id: string }).id
    const rolled = await h.call({
      method: 'POST',
      path: '/api/v1/memory/hotspot/rollback',
      query: {},
      headers: {},
      body: { id },
    })
    assert.equal(rolled.status, 200)
    const restored = await facts.get(changed.id)
    assert.ok(Math.abs(Number(restored?.salience) - changed.before) < 1e-9)
  } finally {
    await h.dispose()
  }
})

test('批量比例上限：只动允许的条数', async () => {
  const h = await setup(0.1)
  try {
    await seed(h)
    const runs = await h.call({ method: 'POST', path: '/api/v1/memory/hotspot/run', query: {}, headers: {} })
    const changes = (runs.body as { changes: unknown[] }).changes
    assert.equal(changes.length, 1, '10 条事实 × 10% = 1 条')
  } finally {
    await h.dispose()
  }
})

test('周报：统计热点/冷记忆并推送', async () => {
  const h = await setup(1)
  try {
    await seed(h)
    const weekly = await h.call({ method: 'POST', path: '/api/v1/memory/weekly/run', query: {}, headers: {} })
    assert.equal(weekly.status, 200)
    const markdown = (weekly.body as { markdown: string }).markdown
    assert.match(markdown, /记忆周报/)
    assert.match(markdown, /热点 3/)
    assert.match(markdown, /长期未用 2/)
    assert.equal(h.channel.sent.length, 1)

    const listed = await h.call({ method: 'GET', path: '/api/v1/memory/weekly', query: {}, headers: {} })
    assert.equal((listed.body as { items: unknown[] }).items.length, 1)
  } finally {
    await h.dispose()
  }
})

test('记忆日报：生成、落库并推送 owner', async () => {
  const h = await setup(1)
  try {
    await seed(h)
    const run = await h.call({ method: 'POST', path: '/api/v1/memory/daily/run', query: {}, headers: {} })
    assert.equal(run.status, 200)
    const body = run.body as { day: string; markdown: string }
    assert.equal(body.day, '2026-11-03')
    assert.match(body.markdown, /# 记忆日报/)
    assert.match(body.markdown, /事实：10 条/)
    const list = await h.call({ method: 'GET', path: '/api/v1/memory/daily', query: {}, headers: {} })
    assert.equal(list.status, 200)
    assert.equal((list.body as { items: unknown[] }).items.length, 1)
    assert.equal(h.channel.sent.length, 1)
  } finally {
    await h.dispose()
  }
})
