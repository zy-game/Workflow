/**
 * qm-cost：余额快照、每日花费差、没有 key 时明确报错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as costPlugin from '../src/index.ts'
import type { GatewayRequest, GatewayResponse } from '@qingmei/core'

function response(): { res: GatewayResponse; read: () => { status: number; body: any } } {
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
    send(payload) {
      body = payload
    },
  }
  return { res, read: () => ({ status, body }) }
}

async function boot(options: { fetchImpl?: typeof fetch; apiKey?: string; credentialsPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-cost-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'cost.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const pluginFiber = ctx.plugin(costPlugin, {
    apiKey: options.apiKey,
    credentialsPath: options.credentialsPath ?? join(dir, 'missing.yaml'),
    fetchImpl: options.fetchImpl,
  })
  await pluginFiber
  const call = async (method: string, path: string) => {
    const r = response()
    await ctx.gateway.dispatch({ method, path, query: {}, headers: {} } as GatewayRequest, r.res)
    return r.read()
  }
  return {
    ctx,
    call,
    async dispose() {
      await pluginFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('refresh：写入当日余额快照，GET /cost 返回与昨日差额', async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '98.50', granted_balance: '0', topped_up_balance: '98.50' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
  const h = await boot({ fetchImpl: fakeFetch, apiKey: 'sk-test' })
  try {
    const store = h.ctx.reflect.get('store', false) as { collection(name: string): any }
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    await store.collection('qm_cost_snapshot').insert({
      id: yesterday,
      day: yesterday,
      total: 100,
      granted: 0,
      toppedUp: 100,
      currency: 'CNY',
      at: Date.now() - 86_400_000,
    })

    const refreshed = await h.call('POST', '/api/v1/cost/refresh')
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.body.snapshot.total, 98.5)

    const today = new Date().toISOString().slice(0, 10)
    const month = today.slice(0, 7)
    await store.collection('qm_embedding_usage').insert({ id: today, day: today, tokens: 300, calls: 3, at: Date.now() })
    const earlierDay = today.endsWith('-01') ? `${month}-02` : `${month}-01`
    await store.collection('qm_embedding_usage').insert({ id: earlierDay, day: earlierDay, tokens: 700, calls: 5, at: Date.now() })

    const cost = await h.call('GET', '/api/v1/cost')
    assert.equal(cost.status, 200)
    assert.equal(cost.body.balance, 98.5)
    assert.equal(cost.body.spentSinceYesterday, 1.5)
    assert.equal(cost.body.embeddingTodayTokens, 300)
    assert.equal(cost.body.embeddingTodayCalls, 3)
    assert.equal(cost.body.embeddingMonthTokens, 1000)
    assert.match(String(cost.body.text), /今日用量/)
    assert.equal(cost.body.items[0].total, 98.5)
  } finally {
    await h.dispose()
  }
})

test('没有 key：refresh 返回 503 并说明去哪配', async () => {
  const previous = process.env.QM_DEEPSEEK_API_KEY
  const previousDeep = process.env.DEEPSEEK_API_KEY
  delete process.env.QM_DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  const h = await boot()
  try {
    const refreshed = await h.call('POST', '/api/v1/cost/refresh')
    assert.equal(refreshed.status, 503)
    assert.match(String(refreshed.body.error), /QM_DEEPSEEK_API_KEY|credentials/)
  } finally {
    if (previous !== undefined) process.env.QM_DEEPSEEK_API_KEY = previous
    if (previousDeep !== undefined) process.env.DEEPSEEK_API_KEY = previousDeep
    await h.dispose()
  }
})

