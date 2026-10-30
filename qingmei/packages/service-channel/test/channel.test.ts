import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import {
  type ChannelAdapter,
  type ChannelCapabilities,
  type OutboundEnvelope,
  type OutboundRecord,
  type SendResult,
} from '@qingmei/core'
import * as channelPlugin from '../src/index.ts'

const CAPS: ChannelCapabilities = {
  markdown: true,
  card: true,
  button: true,
  image: true,
  voice: false,
  file: false,
  edit: false,
  thread: false,
  maxTextLength: 4000,
}

interface FakeOptions {
  failSend?: string
}

async function setup(options: FakeOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(channelPlugin)
  const sent: OutboundEnvelope[] = []
  const adapter: ChannelAdapter = {
    id: 'web',
    capabilities: CAPS,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async send(envelope: OutboundEnvelope): Promise<SendResult> {
      if (options.failSend) throw new Error(options.failSend)
      sent.push(envelope)
      return { ok: true, platformMessageId: `out_${sent.length}` }
    },
  }
  ctx.channel.register(adapter)
  return { ctx, sent }
}

const envelope: OutboundEnvelope = {
  channel: 'web',
  conversationId: 'conv-1',
  blocks: [{ type: 'text', text: '你好' }],
}

test('send 成功后发出 qm/outbound，并等订阅者写完', async () => {
  const { ctx } = await setup()
  const events: OutboundRecord[] = []
  let finished = false
  ctx.events.on('qm/outbound', async (record: OutboundRecord) => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    events.push(record)
    finished = true
  })

  const result = await ctx.channel.send(envelope)

  assert.equal(result.ok, true)
  assert.equal(events.length, 1)
  assert.equal(events[0]!.platformMessageId, 'out_1')
  assert.deepEqual(events[0]!.blocks, [{ type: 'text', text: '你好' }])
  assert.equal(finished, true, 'send 返回时订阅者必须已经跑完')
})

test('投递失败不发 qm/outbound', async () => {
  const { ctx } = await setup({ failSend: '渠道离线' })
  const events: OutboundRecord[] = []
  ctx.events.on('qm/outbound', (record: OutboundRecord) => {
    events.push(record)
  })

  const result = await ctx.channel.send(envelope)
  assert.deepEqual(result, { ok: false, error: '渠道离线' })
  assert.equal(events.length, 0)
})

test('没有适配器时返回 no adapter，也不发事件', async () => {
  const { ctx } = await setup()
  const events: OutboundRecord[] = []
  ctx.events.on('qm/outbound', (record: OutboundRecord) => {
    events.push(record)
  })

  const result = await ctx.channel.send({ ...envelope, channel: 'qq' })
  assert.deepEqual(result, { ok: false, error: 'no adapter' })
  assert.equal(events.length, 0)
})

test('订阅者抛错不影响发送结果', async () => {
  const { ctx } = await setup()
  ctx.events.on('qm/outbound', () => {
    throw new Error('落库失败')
  })

  const result = await ctx.channel.send(envelope)
  assert.equal(result.ok, true)
  assert.equal(result.platformMessageId, 'out_1')
})

test('qm/outbound 的载荷带上 platformMessageId', async () => {
  const { ctx } = await setup()
  const seen: OutboundRecord[] = []
  ctx.events.on('qm/outbound', (record: OutboundRecord) => {
    seen.push(record)
  })

  await ctx.channel.send({ ...envelope, idempotencyKey: 'idem-1' })
  assert.equal(seen[0]!.idempotencyKey, 'idem-1')
  assert.equal(seen[0]!.conversationId, 'conv-1')
  assert.equal(seen[0]!.channel, 'web')
})

test('register 之后才能 send，release 后回到 no adapter', async () => {
  const ctx = new Context()
  await ctx.plugin(channelPlugin)
  const adapter: ChannelAdapter = {
    id: 'web',
    capabilities: CAPS,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async send(): Promise<SendResult> {
      return { ok: true, platformMessageId: 'x' }
    },
  }
  const release = ctx.channel.register(adapter)
  assert.equal((await ctx.channel.send(envelope)).ok, true)

  release()
  // release 是异步收尾，等它把适配器摘掉
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(await ctx.channel.send(envelope), { ok: false, error: 'no adapter' })
})
