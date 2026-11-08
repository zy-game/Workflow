import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import { SqliteTask } from '@qingmei/qm-task'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as nudgePlugin from '../src/modules/nudge.ts'
import {
  ChannelService,
  type GatewayRequest,
  type GatewayResponse,
  type OutboundEnvelope,
  type SendResult,
  type TaskService,
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

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-nudge-'))
  const ctx = new Context()
  let clockMs = Date.now()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'nudge.db') })
  await storeFiber
  new SqliteTask(ctx, { workspaceRoot: join(dir, 'workspaces') })
  await ctx.plugin(gatewayPlugin)
  const channel = new FakeChannel(ctx)
  const nudgeFiber = ctx.plugin(nudgePlugin, {
    tickMs: 0,
    clock: () => new Date(clockMs),
  })
  await nudgeFiber
  const task = ctx.reflect.get('task', false) as TaskService

  return {
    ctx,
    task,
    channel,
    advance(ms: number) {
      clockMs += ms
    },
    nowMs: () => clockMs,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await nudgeFiber.dispose()
      await storeFiber.dispose()
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(nudgePlugin.name, 'qm-nudge')
  assert.deepEqual(nudgePlugin.inject, ['task', 'channel', 'gateway', 'store'])
})

test('L1：落后 >20% 且 1 小时无进展，发事实清单', async () => {
  const h = await setup()
  try {
    const start = h.nowMs()
    const run = await h.task.create({
      prompt: '写周报',
      contract: {
        deadline: new Date(start + 2 * 60 * 60 * 1000),
        enforcement: 'firm',
      },
    })
    h.advance(60 * 60 * 1000)

    const result = await h.call({ method: 'POST', path: '/api/v1/nudge/tick', query: {}, headers: {} })
    assert.equal(result.status, 200)
    assert.equal(h.channel.sent.length, 1)
    const text = (h.channel.sent[0]!.blocks[0] as { text: string }).text
    assert.match(text, /期望/)
    assert.match(text, /实际/)
    assert.match(text, /选项/)

    const listed = await h.call({ method: 'GET', path: '/api/v1/nudge', query: {}, headers: {} })
    const items = (listed.body as { items: { taskId: string; level: number }[] }).items
    assert.equal(items[0]?.taskId, run.id)
    assert.equal(items[0]?.level, 1)
  } finally {
    await h.dispose()
  }
})

test('逃生：暂停后不再提醒，每日次数用完返回 429', async () => {
  const h = await setup()
  try {
    const start = h.nowMs()
    const run = await h.task.create({
      prompt: '写周报',
      contract: {
        deadline: new Date(start + 2 * 60 * 60 * 1000),
        enforcement: 'firm',
        escape: { perDay: 1, hours: 2 },
      },
    })
    h.advance(60 * 60 * 1000)
    await h.call({ method: 'POST', path: '/api/v1/nudge/tick', query: {}, headers: {} })
    assert.equal(h.channel.sent.length, 1)

    const paused = await h.call({
      method: 'POST',
      path: '/api/v1/nudge/pause',
      query: {},
      headers: {},
      body: { taskId: run.id, hours: 2 },
    })
    assert.equal(paused.status, 200)

    h.advance(30 * 60 * 1000)
    await h.call({ method: 'POST', path: '/api/v1/nudge/tick', query: {}, headers: {} })
    assert.equal(h.channel.sent.length, 1, '暂停期间不再提醒')

    const again = await h.call({
      method: 'POST',
      path: '/api/v1/nudge/pause',
      query: {},
      headers: {},
      body: { taskId: run.id, hours: 2 },
    })
    assert.equal(again.status, 429)
  } finally {
    await h.dispose()
  }
})

test('expectedPercent：线性与自定义曲线', () => {
  const start = new Date('2026-11-01T00:00:00Z')
  const end = new Date('2026-11-01T10:00:00Z')
  const run = {
    id: 'r',
    taskId: 'r',
    title: 't',
    prompt: 'p',
    project: null,
    kind: 'task',
    priority: 5,
    dependsOn: [],
    contract: { deadline: end, enforcement: 'firm' },
    harnessId: 'dsh',
    sessionId: null,
    cwd: '.',
    status: 'running',
    progress: null,
    artifacts: [],
    usage: null,
    result: null,
    error: null,
    createdAt: start,
    startedAt: start,
    finishedAt: null,
  } as const
  const mid = new Date('2026-11-01T05:00:00Z')
  assert.equal(Math.round(nudgePlugin.expectedPercent(run, mid.getTime()) ?? -1), 50)

  const curved = {
    ...run,
    contract: {
      deadline: end,
      enforcement: 'firm',
      expected: [
        { at: start, percent: 0 },
        { at: mid, percent: 80 },
        { at: end, percent: 100 },
      ],
    },
  }
  assert.equal(Math.round(nudgePlugin.expectedPercent(curved, mid.getTime()) ?? -1), 80)
})


test('设备执行器已移除：/api/v1/enforcement/* 不再注册', async () => {
  const h = await setup()
  try {
    const res = await h.call({
      method: 'POST',
      path: '/api/v1/enforcement/request',
      query: {},
      headers: {},
      body: { taskId: 'x', level: 3 },
    })
    assert.equal(res.handled, false)
    assert.equal(res.status, 0)
  } finally {
    await h.dispose()
  }
})
