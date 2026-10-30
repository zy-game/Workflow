import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as channelPlugin from '@qingmei/service-channel'
import * as historyPlugin from '@qingmei/qm-history'
import * as reminderPlugin from '../src/index.ts'
import {
  EVENTS,
  type ChannelAdapter,
  type ChannelCapabilities,
  type OutboundEnvelope,
  type Row,
  type Scheduled,
  type SendResult,
  type StoreService,
} from '@qingmei/core'

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

interface MessageRow extends Row {
  session_id: string
  role: 'user' | 'assistant'
  text: string
}

function due(text = '喝水'): Scheduled {
  return {
    id: 'r_1',
    text,
    channel: 'web',
    conversationId: 'owner',
    nextAt: new Date(),
    everyMs: null,
    cron: null,
    timezone: null,
    missedPolicy: 'fire-once',
    firedAt: null,
  }
}

/**
 * @param withHistory 是否加载 qm-history。
 *   不带它时用来证明「提醒自己不写 qm_message」。
 */
async function setup(withHistory: boolean, failSend = false) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-reminder-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'reminder.db') })
  await storeFiber
  await ctx.plugin(channelPlugin)
  await ctx.plugin(reminderPlugin)
  const historyFiber = withHistory ? ctx.plugin(historyPlugin) : null
  if (historyFiber) await historyFiber

  const sent: OutboundEnvelope[] = []
  const adapter: ChannelAdapter = {
    id: 'web',
    capabilities: CAPS,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async send(envelope: OutboundEnvelope): Promise<SendResult> {
      if (failSend) throw new Error('渠道离线')
      sent.push(envelope)
      return { ok: true, platformMessageId: `out_${sent.length}` }
    },
  }
  ctx.channel.register(adapter)
  const store = ctx.reflect.get('store', false) as StoreService

  return {
    ctx,
    sent,
    async rows(): Promise<MessageRow[]> {
      return store.collection<MessageRow>('qm_message').find({})
    },
    async dispose() {
      if (historyFiber) await historyFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('插件形态与契约一致：name / inject（不再依赖 store）', () => {
  assert.equal(reminderPlugin.name, 'qm-reminder')
  assert.deepEqual(reminderPlugin.inject, ['channel'])
})

test('到点投递提醒，落库由 qm-history 完成', async () => {
  const h = await setup(true)
  try {
    h.ctx.events.emit(EVENTS.scheduleDue, due('喝水'))

    await waitFor(async () => (await h.rows()).length === 1, '提醒落库')
    assert.equal(h.sent.length, 1)
    assert.deepEqual(h.sent[0], {
      channel: 'web',
      conversationId: 'owner',
      blocks: [{ type: 'text', text: '⏰ 提醒：喝水' }],
    })

    const [row] = await h.rows()
    assert.ok(row)
    assert.equal(row.session_id, 's_owner')
    assert.equal(row.role, 'assistant')
    assert.equal(row.text, '⏰ 提醒：喝水')
  } finally {
    await h.dispose()
  }
})

test('没有 qm-history 时提醒不自己写库', async () => {
  const h = await setup(false)
  try {
    h.ctx.events.emit(EVENTS.scheduleDue, due('喝水'))
    await new Promise((resolve) => setTimeout(resolve, 60))

    assert.equal(h.sent.length, 1)
    assert.equal((await h.rows()).length, 0)
  } finally {
    await h.dispose()
  }
})

test('投递失败：不落库、不抛错', async () => {
  const h = await setup(true, true)
  try {
    h.ctx.events.emit(EVENTS.scheduleDue, due('喝水'))
    await new Promise((resolve) => setTimeout(resolve, 60))

    assert.equal(h.sent.length, 0)
    assert.equal((await h.rows()).length, 0)
  } finally {
    await h.dispose()
  }
})
