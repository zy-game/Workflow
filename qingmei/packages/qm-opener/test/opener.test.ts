import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as openerPlugin from '../src/index.ts'
import {
  ChannelService,
  EVENTS,
  type GatewayRequest,
  type GatewayResponse,
  type InboundMessage,
  type OutboundEnvelope,
  type SendResult,
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

async function setup(start: Date) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-opener-'))
  const ctx = new Context()
  let clockMs = start.getTime()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'opener.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const channel = new FakeChannel(ctx)
  const openerFiber = ctx.plugin(openerPlugin, {
    auto: false,
    clock: () => new Date(clockMs),
  })
  await openerFiber

  return {
    ctx,
    channel,
    setClock(date: Date) {
      clockMs = date.getTime()
    },
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await openerFiber.dispose()
      await storeFiber.dispose()
    },
  }
}

function message(text: string): InboundMessage {
  return {
    platformMessageId: `m_${Math.random().toString(36).slice(2)}`,
    channel: 'web',
    accountId: 'owner',
    conversation: { id: 'owner', kind: 'dm' },
    sender: { platformUserId: 'owner', displayName: '我' },
    blocks: [{ type: 'text', text }],
    receivedAt: new Date(),
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, label: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${label}`)
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(openerPlugin.name, 'qm-opener')
  assert.deepEqual(openerPlugin.inject, ['store', 'channel', 'gateway'])
})

test('承诺解析：明天带饭 → 次日 20:00', () => {
  const parsed = openerPlugin.parseCommitment('明天带饭', new Date(2026, 10, 3, 20, 0, 0))
  assert.ok(parsed)
  assert.equal(parsed!.dueAt.getDate(), 4)
  assert.equal(parsed!.dueAt.getHours(), 20)
  assert.match(openerPlugin.parseCommitment('后天下午交周报', new Date(2026, 10, 3, 9, 0, 0))!.text, /后天/)
})

test('A6/A7：承诺到期 → 窗口内有理由开场，回应后记账', async () => {
  const h = await setup(new Date(2026, 10, 3, 20, 0, 0))
  try {
    h.ctx.events.emit(EVENTS.inbound, message('明天带饭'))
    const commitments = await waitFor(async () => {
      const listed = await h.call({ method: 'GET', path: '/api/v1/openings/commitments', query: {}, headers: {} })
      const items = (listed.body as { items: { id: string; text: string }[] }).items
      return items.length > 0 ? items : null
    }, '承诺落库')
    assert.match(commitments[0]!.text, /带饭/)

    h.setClock(new Date(2026, 10, 4, 20, 30, 0))
    const tick = await h.call({ method: 'POST', path: '/api/v1/openings/tick', query: {}, headers: {} })
    const created = (tick.body as { created: { id: string; text: string; reason: string }[] }).created
    assert.equal(created.length, 1)
    assert.match(created[0]!.text, /带饭/)
    assert.match(created[0]!.reason, /承诺到期/)
    assert.equal(h.channel.sent.length, 1)

    const responded = await h.call({
      method: 'POST',
      path: '/api/v1/openings/respond',
      query: {},
      headers: {},
      body: { id: created[0]!.id, response: 'answered' },
    })
    assert.equal(responded.status, 200)

    const topics = await h.call({ method: 'GET', path: '/api/v1/openings/topics', query: {}, headers: {} })
    const topic = (topics.body as { items: { id: string; answered: number }[] }).items.find((item) => item.id === 'commitment')
    assert.equal(topic?.answered, 1)
  } finally {
    await h.dispose()
  }
})

test('A6：窗口外不开口', async () => {
  const h = await setup(new Date(2026, 10, 4, 12, 30, 0))
  try {
    h.ctx.events.emit(EVENTS.inbound, message('明天带饭'))
    await waitFor(async () => {
      const listed = await h.call({ method: 'GET', path: '/api/v1/openings/commitments', query: {}, headers: {} })
      return (listed.body as { items: unknown[] }).items.length > 0 ? true : null
    }, '承诺落库')
    h.setClock(new Date(2026, 10, 5, 12, 30, 0))
    const tick = await h.call({ method: 'POST', path: '/api/v1/openings/tick', query: {}, headers: {} })
    assert.equal((tick.body as { created: unknown[] }).created.length, 0)
    assert.equal(h.channel.sent.length, 0)
  } finally {
    await h.dispose()
  }
})

test('A8：7 天内不重复同一句，用尽则本次不说', () => {
  const phrases = ['第一句', '第二句', '第三句']
  const at = new Date(2026, 10, 4, 20, 30).getTime()
  assert.equal(openerPlugin.choosePhrase(phrases, [], at), '第一句')
  assert.equal(openerPlugin.choosePhrase(phrases, [{ text: '第一句', at }], at), '第二句')
  assert.equal(
    openerPlugin.choosePhrase(phrases, [{ text: '第一句', at }, { text: '第二句', at }, { text: '第三句', at }], at),
    null,
  )
  const eightDaysAgo = at - 8 * 24 * 60 * 60 * 1000
  assert.equal(openerPlugin.choosePhrase(phrases, [{ text: '第一句', at: eightDaysAgo }], at), '第一句')
  assert.equal(openerPlugin.currentWindow(new Date(at))?.id, 'evening')
})
