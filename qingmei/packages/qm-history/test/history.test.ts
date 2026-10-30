import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as historyPlugin from '../src/index.ts'
import { EVENTS, type InboundMessage, type Row, type StoreService } from '@qingmei/core'

interface MessageRow extends Row {
  session_id: string
  role: 'user' | 'assistant'
  text: string
  platform_message_id?: string
  created_at: number
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-history-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'history.db') })
  await storeFiber
  const historyFiber = ctx.plugin(historyPlugin)
  await historyFiber
  const store = ctx.reflect.get('store', false) as StoreService
  const collection = store.collection<MessageRow>('qm_message')

  return {
    ctx,
    async rows(): Promise<MessageRow[]> {
      return collection.find({ order: [{ field: 'created_at', dir: 'asc' }] })
    },
    async dispose() {
      await historyFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function inbound(text: string, conversationId = 'conv-1', platformMessageId = 'pm_1'): InboundMessage {
  return {
    platformMessageId,
    channel: 'web',
    accountId: 'web',
    conversation: { kind: 'dm', id: conversationId },
    sender: { platformUserId: 'owner', displayName: '我' },
    blocks: [{ type: 'text', text }],
    receivedAt: new Date(),
  }
}

async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(historyPlugin.name, 'qm-history')
  assert.deepEqual(historyPlugin.inject, ['store'])
})

test('turn/start 写用户消息，带 platform_message_id', async () => {
  const h = await setup()
  try {
    h.ctx.events.emit(EVENTS.turnStart, { sessionId: 's_conv-1', message: inbound('在吗', 'conv-1', 'pm_a') })
    await waitFor(async () => (await h.rows()).length === 1, '用户消息落库')

    const [row] = await h.rows()
    assert.ok(row)
    assert.equal(row.session_id, 's_conv-1')
    assert.equal(row.role, 'user')
    assert.equal(row.text, '在吗')
    assert.equal(row.platform_message_id, 'pm_a')
    assert.equal(typeof row.created_at, 'number')
  } finally {
    await h.dispose()
  }
})

test('qm/outbound 写助手消息，并按事件顺序排时间戳', async () => {
  const h = await setup()
  try {
    h.ctx.events.emit(EVENTS.turnStart, { sessionId: 's_conv-1', message: inbound('在吗') })
    await h.ctx.events.parallel(EVENTS.outbound, {
      channel: 'web',
      conversationId: 'conv-1',
      blocks: [{ type: 'text', text: '在的。' }],
      platformMessageId: 'out_1',
    })
    // 出站监听器是 async 的，parallel 返回时已经写完；用户消息是异步写的，等它落库
    await waitFor(async () => (await h.rows()).length === 2, '两条消息')
    const rows = await h.rows()
    assert.deepEqual(
      rows.map((row) => [row.role, row.text]),
      [
        ['user', '在吗'],
        ['assistant', '在的。'],
      ],
    )
    assert.ok(rows[1]!.created_at > rows[0]!.created_at)
  } finally {
    await h.dispose()
  }
})

test('提醒这类主动消息只要走 outbound 就自动进历史', async () => {
  const h = await setup()
  try {
    await h.ctx.events.parallel(EVENTS.outbound, {
      channel: 'web',
      conversationId: 'owner',
      blocks: [{ type: 'text', text: '⏰ 提醒：喝水' }],
    })

    const rows = await h.rows()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.session_id, 's_owner')
    assert.equal(rows[0]!.role, 'assistant')
    assert.equal(rows[0]!.text, '⏰ 提醒：喝水')
  } finally {
    await h.dispose()
  }
})

test('没有文本的事件不落库', async () => {
  const h = await setup()
  try {
    h.ctx.events.emit(EVENTS.turnStart, { sessionId: 's_conv-1', message: inbound('') })
    await h.ctx.events.parallel(EVENTS.outbound, { channel: 'web', conversationId: 'conv-1', blocks: [] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await h.rows()).length, 0)
  } finally {
    await h.dispose()
  }
})
