import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import * as channelPlugin from '@qingmei/service-channel'
import * as feishuPlugin from '../src/index.ts'
import { stripMentions } from '../src/index.ts'
import {
  EVENTS,
  type InboundMessage,
  type OutboundEnvelope,
  type ChannelService,
} from '@qingmei/core'
import type { FeishuInboundEvent, FeishuTransport } from '../src/index.ts'

class FakeTransport implements FeishuTransport {
  started = 0
  stopped = 0
  readonly sent: { receiveId: string; receiveIdType: string; text: string }[] = []
  fail: string | null = null
  private handler: ((event: FeishuInboundEvent) => void) | null = null

  async start(onInbound: (event: FeishuInboundEvent) => void): Promise<void> {
    this.started += 1
    this.handler = onInbound
  }

  async sendText(input: { receiveId: string; receiveIdType: string; text: string }): Promise<{ messageId: string }> {
    if (this.fail) throw new Error(this.fail)
    this.sent.push(input)
    return { messageId: `om_sent_${this.sent.length}` }
  }

  async stop(): Promise<void> {
    this.stopped += 1
    this.handler = null
  }

  emit(event: Partial<FeishuInboundEvent> & { messageId: string }): void {
    this.handler?.({
      chatId: 'oc_chat',
      chatType: 'group',
      text: '你好',
      senderId: 'ou_user',
      ...event,
    })
  }
}

function envelope(text: string, conversationId = 'oc_chat'): OutboundEnvelope {
  return { channel: 'feishu', conversationId, blocks: [{ type: 'text', text }] }
}

async function setup(config: feishuPlugin.FeishuConfig = {}) {
  const ctx = new Context()
  const channelFiber = ctx.plugin(channelPlugin)
  await channelFiber
  const transport = new FakeTransport()
  const adapter = feishuPlugin.createFeishuAdapter(ctx, { appId: 'cli_test', ...config }, transport)
  const dispose = ctx.channel.register(adapter)
  const inbound: InboundMessage[] = []
  ctx.events.on(EVENTS.inbound, (message: InboundMessage) => inbound.push(message))
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

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(feishuPlugin.name, 'channel-feishu')
  assert.deepEqual(feishuPlugin.inject, ['channel'])
})

test('入站：归一化成 qm/inbound，同一 message_id 只发一次', async () => {
  const h = await setup()
  try {
    // 等 ChannelHub 异步调用 adapter.start
    for (let i = 0; i < 100 && h.transport.started === 0; i += 1) await tick()

    h.transport.emit({ messageId: 'om_1', chatId: 'oc_1', chatType: 'group', text: ' 在吗 \n', senderId: 'ou_1', senderName: '我', mentioned: true })
    h.transport.emit({ messageId: 'om_1', chatId: 'oc_1', chatType: 'group', text: ' 在吗 \n', senderId: 'ou_1', senderName: '我', mentioned: true })

    assert.equal(h.inbound.length, 1, '重投应被去重')
    const message = h.inbound[0]!
    assert.equal(message.channel, 'feishu')
    assert.equal(message.platformMessageId, 'om_1')
    assert.equal(message.conversation.kind, 'group')
    assert.equal(message.conversation.id, 'oc_1')
    assert.equal(message.sender.platformUserId, 'ou_1')
    assert.equal(message.sender.displayName, '我')
    assert.deepEqual(message.blocks, [{ type: 'text', text: '在吗' }])
  } finally {
    await h.dispose()
  }
})

test('入站：allowedChatIds 过滤 + 空文本丢弃 + 私聊映射成 dm', async () => {
  const h = await setup({ allowedChatIds: ['oc_ok'] })
  try {
    h.transport.emit({ messageId: 'm_filtered', chatId: 'oc_no' })
    h.transport.emit({ messageId: 'm_empty', chatId: 'oc_ok', text: '   ' })
    h.transport.emit({ messageId: 'm_ok', chatId: 'oc_ok', chatType: 'p2p', text: '在吗' })
    assert.equal(h.inbound.length, 1)
    assert.equal(h.inbound[0]!.conversation.kind, 'dm')
  } finally {
    await h.dispose()
  }
})

test('出站：文本投递到飞书，返回平台 message_id', async () => {
  const h = await setup()
  try {
    const result = await h.channel.send(envelope('好的'))
    assert.deepEqual(result, { ok: true, platformMessageId: 'om_sent_1' })
    assert.deepEqual(h.transport.sent, [{ receiveId: 'oc_chat', receiveIdType: 'chat_id', text: '好的' }])

    const custom = await setup({ receiveIdType: 'open_id' })
    try {
      await custom.channel.send(envelope('私聊', 'ou_owner'))
      assert.equal(custom.transport.sent[0]!.receiveIdType, 'open_id')
    } finally {
      await custom.dispose()
    }
  } finally {
    await h.dispose()
  }
})

test('出站：空消息不发送；传输失败返回可读错误', async () => {
  const h = await setup()
  try {
    const empty = await h.channel.send({ channel: 'feishu', conversationId: 'oc_chat', blocks: [] })
    assert.equal(empty.ok, false)
    assert.match(empty.error ?? '', /空消息/)

    h.transport.fail = '飞书返回 99991663'
    const failed = await h.channel.send(envelope('试试'))
    assert.equal(failed.ok, false)
    assert.match(failed.error ?? '', /99991663/)
    assert.equal(h.transport.sent.length, 0)
  } finally {
    await h.dispose()
  }
})

test('stop 会释放传输层', async () => {
  const h = await setup()
  try {
    await tick()
    assert.equal(h.transport.started, 1)
    await h.dispose()
    assert.equal(h.transport.stopped, 1)
  } finally {
    // dispose 已在 try 里调用
  }
})

test('缺凭据时 apply 不注册渠道', async () => {
  const ctx = new Context()
  const channelFiber = ctx.plugin(channelPlugin)
  await channelFiber
  // 确保环境变量为空，避免本机恰好配了凭据
  const savedId = process.env.QM_FEISHU_APP_ID
  const savedSecret = process.env.QM_FEISHU_APP_SECRET
  delete process.env.QM_FEISHU_APP_ID
  delete process.env.QM_FEISHU_APP_SECRET
  try {
    feishuPlugin.apply(ctx, {})
    const channel = ctx.reflect.get('channel', false) as ChannelService
    assert.deepEqual(channel.status(), [])
  } finally {
    if (savedId !== undefined) process.env.QM_FEISHU_APP_ID = savedId
    if (savedSecret !== undefined) process.env.QM_FEISHU_APP_SECRET = savedSecret
    await channelFiber.dispose()
  }
})

test('群聊：默认只在被 @ 时进 qm/inbound，私聊不受限', async () => {
  const h = await setup()
  try {
    h.transport.emit({ messageId: 'g1', chatId: 'oc_g', chatType: 'group', text: '没 @ 我', mentioned: false })
    h.transport.emit({ messageId: 'g2', chatId: 'oc_g', chatType: 'group', text: '@我 在吗', mentioned: true })
    h.transport.emit({ messageId: 'd1', chatId: 'oc_d', chatType: 'p2p', text: '私聊' })
    assert.deepEqual(
      h.inbound.map((message) => message.platformMessageId),
      ['g2', 'd1'],
    )
  } finally {
    await h.dispose()
  }
})

test('requireMentionInGroup=false 时群里不 @ 也进', async () => {
  const h = await setup({ requireMentionInGroup: false })
  try {
    h.transport.emit({ messageId: 'g1', chatId: 'oc_g', chatType: 'group', text: '没 @ 我', mentioned: false })
    assert.equal(h.inbound.length, 1)
  } finally {
    await h.dispose()
  }
})
