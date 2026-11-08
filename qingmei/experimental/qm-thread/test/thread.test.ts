import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as threadPlugin from '../src/index.ts'
import type { GatewayRequest, GatewayResponse } from '@qingmei/core'

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
  const dir = mkdtempSync(join(tmpdir(), 'qm-thread-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'thread.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const fiber = ctx.plugin(threadPlugin)
  await fiber
  return {
    ctx,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await fiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('创建 thread、按会话/任务查回同一缝合点', async () => {
  const h = await setup()
  try {
    const created = await h.call({
      method: 'POST',
      path: '/api/v1/threads',
      query: {},
      headers: {},
      body: { title: '杭州出差', conversationId: 'owner', summary: '订票与酒店' },
    })
    assert.equal(created.status, 200)
    const id = (created.body as { thread: { id: string } }).thread.id

    const linked = await h.call({
      method: 'POST',
      path: '/api/v1/threads/link',
      query: {},
      headers: {},
      body: { id, taskId: 'run_1', summary: '任务已完成，遗留报销' },
    })
    assert.equal(linked.status, 200)

    const byConversation = await h.call({
      method: 'GET',
      path: '/api/v1/threads',
      query: { conversationId: 'owner' },
      headers: {},
    })
    const byTask = await h.call({
      method: 'GET',
      path: '/api/v1/threads',
      query: { taskId: 'run_1' },
      headers: {},
    })
    assert.equal((byConversation.body as { items: unknown[] }).items.length, 1)
    assert.equal((byTask.body as { items: unknown[] }).items.length, 1)
    assert.equal((byTask.body as { items: { id: string }[] }).items[0]?.id, id)
  } finally {
    await h.dispose()
  }
})

test('关闭 thread 后仍能按任务查到，但 status 过滤生效', async () => {
  const h = await setup()
  try {
    const created = await h.call({
      method: 'POST',
      path: '/api/v1/threads',
      query: {},
      headers: {},
      body: { title: '临时话题', taskId: 'run_2' },
    })
    const id = (created.body as { thread: { id: string } }).thread.id
    await h.call({
      method: 'POST',
      path: '/api/v1/threads/link',
      query: {},
      headers: {},
      body: { id, status: 'closed' },
    })
    const open = await h.call({ method: 'GET', path: '/api/v1/threads', query: { status: 'open' }, headers: {} })
    const closed = await h.call({
      method: 'GET',
      path: '/api/v1/threads',
      query: { status: 'closed' },
      headers: {},
    })
    assert.equal((open.body as { items: unknown[] }).items.length, 0)
    assert.equal((closed.body as { items: unknown[] }).items.length, 1)
  } finally {
    await h.dispose()
  }
})
