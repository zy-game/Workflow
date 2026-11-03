import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as restPlugin from '../src/index.ts'
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

async function setup(clock: Date) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-rest-'))
  const ctx = new Context()
  let clockMs = clock.getTime()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'rest.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const channel = new FakeChannel(ctx)
  const restFiber = ctx.plugin(restPlugin, {
    tickMs: 0,
    clock: () => new Date(clockMs),
  })
  await restFiber
  const store = ctx.reflect.get('store', false) as StoreService

  return {
    ctx,
    channel,
    store,
    advance(ms: number) {
      clockMs += ms
    },
    setClock(date: Date) {
      clockMs = date.getTime()
    },
    nowMs: () => clockMs,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await restFiber.dispose()
      await storeFiber.dispose()
    },
  }
}

async function seedUserMessages(h, at: number[], prefix = 'm'): Promise<void> {
  const messages = h.store.collection('qm_message')
  let index = 0
  for (const ts of at) {
    index += 1
    await messages.insert({ id: `${prefix}${index}`, role: 'user', text: '在吗', created_at: ts })
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(restPlugin.name, 'qm-rest')
  assert.deepEqual(restPlugin.inject, ['store', 'channel', 'gateway'])
})

test('连续活跃 90 分钟 → 建议休息，同一周期不重复', async () => {
  const h = await setup(new Date(2026, 10, 3, 12, 0, 0))
  try {
    const now = h.nowMs()
    await seedUserMessages(h, [now - 20 * 60_000, now - 50 * 60_000])

    const first = await h.call({ method: 'POST', path: '/api/v1/rest/tick', query: {}, headers: {} })
    assert.deepEqual((first.body as { sent: string[] }).sent, ['break'])
    assert.match((h.channel.sent[0]!.blocks[0] as { text: string }).text, /连续忙了/)

    await h.call({ method: 'POST', path: '/api/v1/rest/tick', query: {}, headers: {} })
    assert.equal(h.channel.sent.length, 1, '同一周期不重复提醒')
  } finally {
    await h.dispose()
  }
})

test('23:30 后仍有活动 → 收工提醒（每天一次）', async () => {
  const h = await setup(new Date(2026, 10, 3, 23, 40, 0))
  try {
    await seedUserMessages(h, [h.nowMs() - 5 * 60_000])
    const first = await h.call({ method: 'POST', path: '/api/v1/rest/tick', query: {}, headers: {} })
    assert.ok((first.body as { sent: string[] }).sent.includes('wind-down'))
    const texts = h.channel.sent.map((item) => (item.blocks[0] as { text: string }).text)
    assert.ok(texts.some((text) => /收工/.test(text)))

    const count = h.channel.sent.length
    await h.call({ method: 'POST', path: '/api/v1/rest/tick', query: {}, headers: {} })
    assert.equal(h.channel.sent.length, count, '当天不重复')
  } finally {
    await h.dispose()
  }
})

test('连续 6 天活跃 → 建议低强度一天（每周一次）', async () => {
  const h = await setup(new Date(2026, 10, 3, 12, 0, 0))
  try {
    const now = h.nowMs()
    const timestamps = [0, 1, 2, 3, 4, 5].map((day) => now - day * 24 * 60 * 60 * 1000)
    await seedUserMessages(h, timestamps)
    const result = await h.call({ method: 'POST', path: '/api/v1/rest/tick', query: {}, headers: {} })
    assert.ok((result.body as { sent: string[] }).sent.includes('streak'))
    const texts = h.channel.sent.map((item) => (item.blocks[0] as { text: string }).text)
    assert.ok(texts.some((text) => /低强度/.test(text)))
  } finally {
    await h.dispose()
  }
})
