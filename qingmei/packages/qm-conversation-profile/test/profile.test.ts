import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as profilePlugin from '../src/index.ts'
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
    return [{ id: 'feishu' as const, online: true }]
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
  const dir = mkdtempSync(join(tmpdir(), 'qm-profile-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'profile.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const channel = new FakeChannel(ctx)
  const pluginFiber = ctx.plugin(profilePlugin)
  await pluginFiber
  // 等启动时的画像缓存加载
  await new Promise((resolve) => setTimeout(resolve, 20))

  return {
    ctx,
    channel,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await pluginFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function groupMessage(id = 'm1'): InboundMessage {
  return {
    platformMessageId: id,
    channel: 'feishu',
    accountId: 'cli',
    conversation: { kind: 'group', id: 'oc_group' },
    sender: { platformUserId: 'ou_1', displayName: '我' },
    blocks: [{ type: 'text', text: '在吗' }],
    receivedAt: new Date(),
  }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${label}`)
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(profilePlugin.name, 'qm-conversation-profile')
  assert.deepEqual(profilePlugin.inject, ['store', 'channel', 'gateway'])
})

test('未配置群：确定性回「权限未配置」，不进入模型', async () => {
  const h = await setup()
  try {
    const message = groupMessage()
    h.ctx.events.emit(EVENTS.inbound, message)
    assert.equal(message.handledBy, 'conversation-profile')
    await waitFor(() => h.channel.sent.length === 1, '固定话术')
    assert.deepEqual(h.channel.sent[0]?.blocks, [{ type: 'text', text: '权限未配置' }])

    const listed = await h.call({ method: 'GET', path: '/api/v1/conversations', query: {}, headers: {} })
    const items = (listed.body as { items: { status: string; channel: string }[] }).items
    assert.equal(items[0]?.status, 'pending')
    assert.equal(items[0]?.channel, 'feishu')
  } finally {
    await h.dispose()
  }
})

test('打标签后按策略回复：未配置门关闭，策略取更严格', async () => {
  const h = await setup()
  try {
    h.ctx.events.emit(EVENTS.inbound, groupMessage('m1'))
    await waitFor(() => h.channel.sent.length === 1, '先走一次未配置')

    const configured = await h.call({
      method: 'POST',
      path: '/api/v1/conversations/configure',
      query: {},
      headers: {},
      body: { channel: 'feishu', conversationId: 'oc_group', tags: ['work', 'casual'], title: '测试群' },
    })
    assert.equal(configured.status, 200)
    const body = configured.body as { policy: { maxChars: number; tone: string }; profile: { status: string } }
    assert.equal(body.profile.status, 'configured')
    assert.equal(body.policy.maxChars, 100, '取更严格的长度')
    assert.equal(body.policy.tone, 'neutral', '取更严格的口吻（formal > neutral > casual）')

    const next = groupMessage('m2')
    h.ctx.events.emit(EVENTS.inbound, next)
    assert.equal(next.handledBy, undefined, '配置后应进入模型')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(h.channel.sent.length, 1, '不再回固定话术')
  } finally {
    await h.dispose()
  }
})

test('configure 参数校验：未知标签 400', async () => {
  const h = await setup()
  try {
    const bad = await h.call({
      method: 'POST',
      path: '/api/v1/conversations/configure',
      query: {},
      headers: {},
      body: { channel: 'feishu', conversationId: 'oc_group', tags: ['unknown'] },
    })
    assert.equal(bad.status, 400)
    assert.match((bad.body as { error: string }).error, /未知标签/)
  } finally {
    await h.dispose()
  }
})
