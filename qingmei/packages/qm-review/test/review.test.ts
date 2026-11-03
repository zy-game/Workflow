import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as reviewPlugin from '../src/index.ts'
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

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-review-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'review.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const channel = new FakeChannel(ctx)
  const reviewFiber = ctx.plugin(reviewPlugin, { minScore: 6 })
  await reviewFiber
  const store = ctx.reflect.get('store', false) as StoreService

  return {
    ctx,
    channel,
    store,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await reviewFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(reviewPlugin.name, 'qm-review')
  assert.deepEqual(reviewPlugin.inject, ['store', 'channel', 'gateway'])
})

test('生成月报：统计回合/任务/故障并推给 owner', async () => {
  const h = await setup()
  try {
    const now = Date.now()
    const turns = h.store.collection('qm_turn')
    await turns.insert({ id: 't1', status: 'ok', latency_ms: 100, created_at: now })
    await turns.insert({ id: 't2', status: 'ok', latency_ms: 300, created_at: now })
    await turns.insert({ id: 't3', status: 'failed', latency_ms: 200, error_code: '模型超时', created_at: now })
    const tasks = h.store.collection('qm_task_run')
    await tasks.insert({ id: 'run1', status: 'done', created_at: now })
    await tasks.insert({ id: 'run2', status: 'failed', created_at: now })
    const messages = h.store.collection('qm_message')
    await messages.insert({ id: 'm1', role: 'user', text: '在吗', created_at: now - 2000 })
    await messages.insert({ id: 'm2', role: 'assistant', text: '在的', created_at: now - 1000 })
    const incidents = h.store.collection('qm_incident')
    await incidents.insert({ id: 'inc1', status: 'proposed', message: '模型超时', first_at: now })

    const response = await h.call({ method: 'POST', path: '/api/v1/review/run', query: {}, headers: {} })
    assert.equal(response.status, 200)
    const review = (response.body as { review: { id: string; markdown: string; metrics: { turns: { total: number; failed: number }; tasks: { done: number }; incidents: { total: number } } } }).review
    assert.match(review.markdown, /月度复盘/)
    assert.match(review.markdown, /3 回合/)
    assert.match(review.markdown, /模型超时/)
    assert.equal(review.metrics.turns.total, 3)
    assert.equal(review.metrics.turns.failed, 1)
    assert.equal(review.metrics.tasks.done, 1)
    assert.equal(review.metrics.incidents.total, 1)
    assert.match(review.markdown, /## 抽样/)
    assert.match(review.markdown, /在吗/)
    assert.equal(review.metrics.samples.length, 2)
    assert.equal(h.channel.sent.length, 1)

    const listed = await h.call({ method: 'GET', path: '/api/v1/review', query: {}, headers: {} })
    assert.equal((listed.body as { items: unknown[] }).items.length, 1)
  } finally {
    await h.dispose()
  }
})

test('评分：低分给改进提醒；重复生成不重复建行', async () => {
  const h = await setup()
  try {
    const first = await h.call({ method: 'POST', path: '/api/v1/review/run', query: {}, headers: {} })
    const id = (first.body as { review: { id: string } }).review.id

    const low = await h.call({
      method: 'POST',
      path: '/api/v1/review/score',
      query: {},
      headers: {},
      body: { id, score: 5, note: '太吵' },
    })
    assert.equal(low.status, 200)
    assert.equal(h.channel.sent.length, 2, '低分应追加一条提醒')

    const proposals = await h.call({ method: 'GET', path: '/api/v1/review/proposals', query: {}, headers: {} })
    const proposalItems = (proposals.body as { items: { id: string; suggestion: string }[] }).items
    assert.equal(proposalItems.length, 1)
    assert.match(proposalItems[0]!.suggestion, /建议/)

    const dismissed = await h.call({
      method: 'POST',
      path: '/api/v1/review/proposals/dismiss',
      query: {},
      headers: {},
      body: { id: proposalItems[0]!.id },
    })
    assert.equal(dismissed.status, 200)
    const afterDismiss = await h.call({ method: 'GET', path: '/api/v1/review/proposals', query: {}, headers: {} })
    assert.equal((afterDismiss.body as { items: unknown[] }).items.length, 0)

    await h.call({ method: 'POST', path: '/api/v1/review/run', query: {}, headers: {} })
    const listed = await h.call({ method: 'GET', path: '/api/v1/review', query: {}, headers: {} })
    assert.equal((listed.body as { items: unknown[] }).items.length, 1, '同月只保留一份')

    const bad = await h.call({
      method: 'POST',
      path: '/api/v1/review/score',
      query: {},
      headers: {},
      body: { id, score: 11 },
    })
    assert.equal(bad.status, 400)
  } finally {
    await h.dispose()
  }
})

test('逐条评分卡：月报生成后抽样成卡，可逐条打分', async () => {
  const h = await setup()
  try {
    const now = Date.now()
    const messages = h.store.collection('qm_message')
    for (let i = 0; i < 3; i += 1) {
      await messages.insert({ id: `c${i}`, role: i % 2 ? 'assistant' : 'user', text: `样本 ${i}`, created_at: now - i })
    }
    const run = await h.call({ method: 'POST', path: '/api/v1/review/run', query: {}, headers: {} })
    assert.equal(run.status, 200)
    const listed = await h.call({ method: 'GET', path: '/api/v1/review/cards', query: {}, headers: {} })
    const cards = (listed.body as { items: { id: string; text: string }[] }).items
    assert.equal(cards.length, 3)
    const scored = await h.call({
      method: 'POST',
      path: '/api/v1/review/cards/score',
      query: {},
      headers: {},
      body: { id: cards[0]!.id, score: 8, note: '这句好' },
    })
    assert.equal(scored.status, 200)
  } finally {
    await h.dispose()
  }
})
