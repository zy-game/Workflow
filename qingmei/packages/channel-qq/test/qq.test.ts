import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import * as channelPlugin from '@qingmei/service-channel'
import * as qqPlugin from '../src/index.ts'
import {
  EVENTS,
  type ChannelService,
  type InboundMessage,
  type OutboundEnvelope,
} from '@qingmei/core'
import type { QqInboundEvent, QqTransport } from '../src/index.ts'

class FakeTransport implements QqTransport {
  started = 0
  stopped = 0
  readonly sent: { kind: string; conversationId: string; text: string }[] = []
  fail: string | null = null
  private handler: ((event: QqInboundEvent) => void) | null = null

  async start(onInbound: (event: QqInboundEvent) => void): Promise<void> {
    this.started += 1
    this.handler = onInbound
  }

  async sendMessage(input: { kind: 'dm' | 'group'; conversationId: string; text: string }): Promise<{ messageId?: string }> {
    if (this.fail) throw new Error(this.fail)
    this.sent.push(input)
    return { messageId: `qq_sent_${this.sent.length}` }
  }

  async stop(): Promise<void> {
    this.stopped += 1
    this.handler = null
  }

  emit(event: Partial<QqInboundEvent> & { messageId: string }): void {
    this.handler?.({
      kind: 'dm',
      conversationId: 'openid_1',
      text: '你好',
      senderId: 'openid_1',
      ...event,
    })
  }
}

function envelope(text: string, conversationId = 'dm:openid_1'): OutboundEnvelope {
  return { channel: 'qq', conversationId, blocks: [{ type: 'text', text }] }
}

async function setup(config: qqPlugin.QqConfig = {}) {
  const ctx = new Context()
  const channelFiber = ctx.plugin(channelPlugin)
  await channelFiber
  const transport = new FakeTransport()
  const adapter = qqPlugin.createQqAdapter(ctx, { appId: 'app_test', ...config }, transport)
  const dispose = ctx.channel.register(adapter)
  const inbound: InboundMessage[] = []
  ctx.events.on(EVENTS.inbound, (message: InboundMessage) => inbound.push(message))
  for (let i = 0; i < 100 && transport.started === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return {
    ctx,
    transport,
    inbound,
    channel: ctx.reflect.get('channel', false) as ChannelService,
    async dispose() {
      dispose()
      await channelFiber.dispose()
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(qqPlugin.name, 'channel-qq')
  assert.deepEqual(qqPlugin.inject, ['channel'])
})

test('会话 id：类型前缀可编码/解码', () => {
  assert.equal(qqPlugin.encodeConversationId('group', 'G1'), 'group:G1')
  assert.deepEqual(qqPlugin.decodeConversationId('group:G1'), { kind: 'group', rawId: 'G1' })
  assert.deepEqual(qqPlugin.decodeConversationId('dm:u1'), { kind: 'dm', rawId: 'u1' })
  assert.equal(qqPlugin.decodeConversationId('garbage'), null)
  assert.equal(qqPlugin.decodeConversationId('group:'), null)
})

test('入站：C2C/群消息映射成 qm/inbound，带类型前缀并去重', async () => {
  const h = await setup()
  try {
    h.transport.emit({ messageId: 'q1', kind: 'dm', conversationId: 'u1', text: ' 在吗 ', senderId: 'u1' })
    h.transport.emit({ messageId: 'q1', kind: 'dm', conversationId: 'u1', text: ' 在吗 ', senderId: 'u1' })
    h.transport.emit({ messageId: 'q2', kind: 'group', conversationId: 'G1', text: '<@!123> 你好', senderId: 'u2' })

    assert.equal(h.inbound.length, 2, '重投应被去重')
    assert.equal(h.inbound[0]!.conversation.id, 'dm:u1')
    assert.equal(h.inbound[0]!.conversation.kind, 'dm')
    assert.equal(h.inbound[1]!.conversation.id, 'group:G1')
    assert.equal(h.inbound[1]!.conversation.kind, 'group')
    assert.deepEqual(h.inbound[1]!.blocks, [{ type: 'text', text: '你好' }], '@ 占位符应被去掉')
  } finally {
    await h.dispose()
  }
})

test('入站：allowedConversationIds 过滤', async () => {
  const h = await setup({ allowedConversationIds: ['group:G1'] })
  try {
    h.transport.emit({ messageId: 'a1', kind: 'dm', conversationId: 'u1' })
    h.transport.emit({ messageId: 'a2', kind: 'group', conversationId: 'G1' })
    assert.equal(h.inbound.length, 1)
    assert.equal(h.inbound[0]!.conversation.id, 'group:G1')
  } finally {
    await h.dispose()
  }
})

test('出站：按前缀选用户/群接口，返回消息 id', async () => {
  const h = await setup()
  try {
    const dm = await h.channel.send(envelope('私聊'))
    assert.deepEqual(dm, { ok: true, platformMessageId: 'qq_sent_1' })
    assert.deepEqual(h.transport.sent[0], { kind: 'dm', conversationId: 'openid_1', text: '私聊' })

    await h.channel.send(envelope('群里', 'group:G1'))
    assert.equal(h.transport.sent[1]!.kind, 'group')
    assert.equal(h.transport.sent[1]!.conversationId, 'G1')
  } finally {
    await h.dispose()
  }
})

test('出站：无法识别会话 / 空消息 / 发送失败', async () => {
  const h = await setup()
  try {
    const bad = await h.channel.send(envelope('x', 'no-prefix'))
    assert.equal(bad.ok, false)
    assert.match(bad.error ?? '', /无法从 conversationId/)

    const empty = await h.channel.send({ channel: 'qq', conversationId: 'dm:u1', blocks: [] })
    assert.equal(empty.ok, false)

    h.transport.fail = 'QQ 发送失败：401'
    const failed = await h.channel.send(envelope('试试'))
    assert.equal(failed.ok, false)
    assert.match(failed.error ?? '', /401/)
  } finally {
    await h.dispose()
  }
})

test('parseDispatchEvent：只认 C2C 与群 @ 事件', () => {
  assert.deepEqual(
    qqPlugin.parseDispatchEvent('C2C_MESSAGE_CREATE', { id: 'm1', content: '你好', author: { user_openid: 'u1' } }),
    { messageId: 'm1', kind: 'dm', conversationId: 'u1', text: '你好', senderId: 'u1' },
  )
  assert.equal(qqPlugin.parseDispatchEvent('C2C_MESSAGE_CREATE', { id: 'm1', content: '', author: { user_openid: 'u1' } }), null)
  assert.equal(qqPlugin.parseDispatchEvent('UNKNOWN', { id: 'm1', content: 'x' }), null)
  const group = qqPlugin.parseDispatchEvent('GROUP_AT_MESSAGE_CREATE', {
    id: 'm2',
    content: '<@!9> 在吗',
    group_openid: 'G1',
    author: { member_openid: 'u2' },
  })
  assert.deepEqual(group, { messageId: 'm2', kind: 'group', conversationId: 'G1', text: '在吗', senderId: 'u2' })
})

test('缺凭据时 apply 不注册渠道', async () => {
  const ctx = new Context()
  const channelFiber = ctx.plugin(channelPlugin)
  await channelFiber
  const savedId = process.env.QM_QQ_APP_ID
  const savedSecret = process.env.QM_QQ_CLIENT_SECRET
  delete process.env.QM_QQ_APP_ID
  delete process.env.QM_QQ_CLIENT_SECRET
  try {
    qqPlugin.apply(ctx, {})
    const channel = ctx.reflect.get('channel', false) as ChannelService
    assert.deepEqual(channel.status(), [])
  } finally {
    if (savedId !== undefined) process.env.QM_QQ_APP_ID = savedId
    if (savedSecret !== undefined) process.env.QM_QQ_CLIENT_SECRET = savedSecret
    await channelFiber.dispose()
  }
})
