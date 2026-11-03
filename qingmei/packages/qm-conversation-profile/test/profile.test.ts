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

async function setup(config: profilePlugin.ConversationProfileConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-profile-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'profile.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const channel = new FakeChannel(ctx)
  const pluginFiber = ctx.plugin(profilePlugin, config)
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
    await waitFor(() => h.channel.sent.length === 2, '固定话术 + owner 通知')
    assert.deepEqual(h.channel.sent[0]?.blocks, [{ type: 'text', text: '权限未配置' }])
    assert.equal(h.channel.sent[1]?.channel, 'web')
    assert.match(String((h.channel.sent[1]?.blocks[0] as { text: string }).text), /发现新群/)
    assert.match(String((h.channel.sent[1]?.blocks[0] as { text: string }).text), /oc_group/)

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
    await waitFor(() => h.channel.sent.length === 2, '先走一次未配置')

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
    assert.equal(h.channel.sent.length, 2, '不再回固定话术')
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

test('标签建议：消息够了给建议，采纳后写入画像', async () => {
  const h = await setup({ suggestAfterMessages: 3 })
  try {
    for (const [index, text] of ['合同要改', '报价再确认', '交付时间定一下'].entries()) {
      const message = groupMessage(`m${index}`)
      message.blocks = [{ type: 'text', text }]
      h.ctx.events.emit(EVENTS.inbound, message)
    }

    const listed = await (async () => {
      for (let i = 0; i < 50; i += 1) {
        const result = await h.call({ method: 'GET', path: '/api/v1/conversations/suggestions', query: {}, headers: {} })
        const items = (result.body as { items: { id: string; tag: string; evidence: string; conversationId: string }[] }).items
        if (items.length > 0) return items
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('等待建议超时')
    })()
    assert.equal(listed[0]?.tag, 'client')
    assert.match(listed[0]?.evidence ?? '', /合同|报价|交付/)

    const accepted = await h.call({
      method: 'POST',
      path: '/api/v1/conversations/suggestions/accept',
      query: {},
      headers: {},
      body: { id: listed[0]!.id },
    })
    assert.equal(accepted.status, 200)
    const profile = (accepted.body as { profile: { tags: string[]; status: string } }).profile
    assert.equal(profile.status, 'configured')
    assert.deepEqual(profile.tags, ['client'])

    const after = await h.call({ method: 'GET', path: '/api/v1/conversations/suggestions', query: {}, headers: {} })
    assert.equal((after.body as { items: unknown[] }).items.length, 0, '采纳后不再展示')
  } finally {
    await h.dispose()
  }
})

test('标签建议：拒绝后不再出现', async () => {
  const h = await setup({ suggestAfterMessages: 3 })
  try {
    for (const [index, text] of ['周会排期', '项目进度', '上线时间'].entries()) {
      const message = groupMessage(`d${index}`)
      message.blocks = [{ type: 'text', text }]
      h.ctx.events.emit(EVENTS.inbound, message)
    }
    const items = await (async () => {
      for (let i = 0; i < 50; i += 1) {
        const result = await h.call({ method: 'GET', path: '/api/v1/conversations/suggestions', query: {}, headers: {} })
        const rows = (result.body as { items: { id: string; tag: string }[] }).items
        if (rows.length > 0) return rows
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('等待建议超时')
    })()
    assert.equal(items[0]?.tag, 'work')

    const dismissed = await h.call({
      method: 'POST',
      path: '/api/v1/conversations/suggestions/dismiss',
      query: {},
      headers: {},
      body: { id: items[0]!.id },
    })
    assert.equal(dismissed.status, 200)
    const after = await h.call({ method: 'GET', path: '/api/v1/conversations/suggestions', query: {}, headers: {} })
    assert.equal((after.body as { items: unknown[] }).items.length, 0)
  } finally {
    await h.dispose()
  }
})
