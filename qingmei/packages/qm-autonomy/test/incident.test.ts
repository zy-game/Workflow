import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import { SqliteTask } from '@qingmei/qm-task'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as incidentPlugin from '../src/modules/incident.ts'
import {
  ChannelService,
  EVENTS,
  TaskRunnerService,
  type GatewayRequest,
  type GatewayResponse,
  type OutboundEnvelope,
  type SendResult,
  type TaskRun,
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

class FakeTaskRunner extends TaskRunnerService {
  readonly dispatched: TaskRun[] = []
  readonly cancelled: string[] = []
  dispatch(run: TaskRun): void {
    this.dispatched.push(run)
  }
  async cancel(id: string): Promise<boolean> {
    this.cancelled.push(id)
    return true
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

async function setup(config: incidentPlugin.IncidentConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-incident-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'incident.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  new SqliteTask(ctx, { workspaceRoot: join(dir, 'workspaces') })
  const channel = new FakeChannel(ctx)
  const runner = new FakeTaskRunner(ctx)
  const incidentFiber = ctx.plugin(incidentPlugin, config)
  await incidentFiber

  return {
    ctx,
    channel,
    runner,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await incidentFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
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
  assert.equal(incidentPlugin.name, 'qm-incident')
  assert.deepEqual(incidentPlugin.inject, ['store', 'channel', 'gateway'])
})

test('回合失败 → 建 incident、推提案；同一故障去重并熔断', async () => {
  const h = await setup()
  try {
    h.ctx.events.emit(EVENTS.turnEnd, {
      sessionId: 's1',
      traceId: 't1',
      ok: false,
      error: '模型连接失败',
      userText: '在吗',
      latencyMs: 10,
    })
    await waitFor(() => h.channel.sent.length === 1, '提案通知')
    assert.match((h.channel.sent[0]!.blocks[0] as { text: string }).text, /检测到故障/)

    const first = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    const items = (first.body as { items: { id: string; count: number; status: string; fingerprint: string }[] }).items
    assert.equal(items.length, 1)
    assert.equal(items[0]?.count, 1)
    assert.equal(items[0]?.status, 'proposed')

    h.ctx.events.emit(EVENTS.turnEnd, {
      sessionId: 's1',
      traceId: 't2',
      ok: false,
      error: '模型连接失败',
      userText: '再来一次',
      latencyMs: 10,
    })
    await waitFor(() => h.channel.sent.length === 2, '熔断通知')
    const second = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    const rows = (second.body as { items: { count: number; status: string }[] }).items
    assert.equal(rows.length, 1, '同一指纹只保留一行')
    assert.equal(rows[0]?.count, 2)
    assert.equal(rows[0]?.status, 'fused')
  } finally {
    await h.dispose()
  }
})

test('每日提案上限：超出后熔断且不再通知', async () => {
  const h = await setup({ maxProposalsPerDay: 1 })
  try {
    h.ctx.events.emit(EVENTS.turnEnd, { sessionId: 's1', traceId: 'a', ok: false, error: '错误一', latencyMs: 1 })
    await waitFor(() => h.channel.sent.length === 1, '第一条提案')
    h.ctx.events.emit(EVENTS.turnEnd, { sessionId: 's1', traceId: 'b', ok: false, error: '错误二', latencyMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const listed = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    const items = (listed.body as { items: { status: string; message: string }[] }).items
    assert.equal(items.length, 2)
    assert.equal(items.filter((item) => item.status === 'proposed').length, 1)
    assert.equal(items.filter((item) => item.status === 'fused').length, 1)
    assert.equal(h.channel.sent.length, 1, '超限不再通知')
  } finally {
    await h.dispose()
  }
})

test('派诊断任务：建 run、派发、incident 变 acknowledged', async () => {
  const h = await setup()
  try {
    h.ctx.events.emit(EVENTS.turnEnd, { sessionId: 's1', traceId: 'x', ok: false, error: '命令失败', latencyMs: 1 })
    await waitFor(() => h.channel.sent.length === 1, '提案')
    const listed = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    const id = (listed.body as { items: { id: string }[] }).items[0]!.id

    const dispatched = await h.call({
      method: 'POST',
      path: '/api/v1/incidents/dispatch',
      query: {},
      headers: {},
      body: { id },
    })
    assert.equal(dispatched.status, 202)
    assert.ok((dispatched.body as { runId: string }).runId)
    assert.equal(h.runner.dispatched.length, 1)
    assert.match(h.runner.dispatched[0]!.prompt, /自愈诊断任务/)

    const after = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    assert.equal((after.body as { items: { status: string }[] }).items[0]?.status, 'acknowledged')
  } finally {
    await h.dispose()
  }
})

test('fingerprintOf：空白归一化后稳定', () => {
  assert.equal(incidentPlugin.fingerprintOf('turn', '  A  B  '), incidentPlugin.fingerprintOf('turn', 'a b'))
  assert.notEqual(incidentPlugin.fingerprintOf('turn', 'A'), incidentPlugin.fingerprintOf('task', 'A'))
})

test('playbook：解决后同故障再犯自动派诊断；拒绝 3 次停用', async () => {
  const h = await setup()
  try {
    // 首次故障 → 提案
    h.ctx.events.emit(EVENTS.turnEnd, { sessionId: 's1', traceId: 'p1', ok: false, error: '数据库连接失败', latencyMs: 1 })
    await waitFor(() => h.channel.sent.length === 1, '首次提案')
    let listed = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    let incident = (listed.body as { items: { id: string }[] }).items[0]!

    // 解决时写 playbook
    const resolved = await h.call({
      method: 'POST',
      path: '/api/v1/incidents/resolve',
      query: {},
      headers: {},
      body: { id: incident.id, rootCause: '连接池耗尽', action: '重启连接池并扩容' },
    })
    assert.equal(resolved.status, 200)
    assert.ok((resolved.body as { playbookId?: string }).playbookId)

    // 再犯 → 命中 playbook，自动派诊断
    h.ctx.events.emit(EVENTS.turnEnd, { sessionId: 's1', traceId: 'p2', ok: false, error: '数据库连接失败', latencyMs: 1 })
    await waitFor(() => h.runner.dispatched.length === 1, '自动派诊断')
    listed = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    const items = (listed.body as { items: { id: string; status: string }[] }).items
    incident = items[0]!
    assert.equal(incident.status, 'acknowledged')
    assert.match(h.runner.dispatched[0]!.prompt, /连接池耗尽/)

    // 拒绝 3 次 → playbook 停用
    for (let i = 0; i < 3; i += 1) {
      const rejected = await h.call({
        method: 'POST',
        path: '/api/v1/incidents/reject',
        query: {},
        headers: {},
        body: { id: incident.id, note: '没用' },
      })
      assert.equal(rejected.status, 200)
      if (i === 2) assert.equal((rejected.body as { playbookDisabled: boolean }).playbookDisabled, true)
    }
    // 把这次 incident 收掉，制造下一次复发
    await h.call({ method: 'POST', path: '/api/v1/incidents/resolve', query: {}, headers: {}, body: { id: incident.id } })

    h.ctx.events.emit(EVENTS.turnEnd, { sessionId: 's1', traceId: 'p3', ok: false, error: '数据库连接失败', latencyMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(h.runner.dispatched.length, 1, 'playbook 停用后不再自动派')
  } finally {
    await h.dispose()
  }
})

test('回滚：自动自愈任务可取消，incident 收尾', async () => {
  const h = await setup()
  try {
    h.ctx.events.emit(EVENTS.turnEnd, { sessionId: 's1', traceId: 'r1', ok: false, error: '磁盘满', latencyMs: 1 })
    await waitFor(() => h.channel.sent.length === 1, '首次提案')
    const listed = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    const first = (listed.body as { items: { id: string }[] }).items[0]!

    await h.call({
      method: 'POST',
      path: '/api/v1/incidents/resolve',
      query: {},
      headers: {},
      body: { id: first.id, rootCause: '日志占满磁盘', action: '清理旧日志' },
    })

    h.ctx.events.emit(EVENTS.turnEnd, { sessionId: 's1', traceId: 'r2', ok: false, error: '磁盘满', latencyMs: 1 })
    await waitFor(() => h.runner.dispatched.length === 1, '自动派诊断')
    const again = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    const incident = (again.body as { items: { id: string; runId: string; status: string }[] }).items[0]!
    assert.ok(incident.runId)

    const rolled = await h.call({
      method: 'POST',
      path: '/api/v1/incidents/rollback',
      query: {},
      headers: {},
      body: { id: incident.id },
    })
    assert.equal(rolled.status, 200)
    assert.equal((rolled.body as { cancelled: boolean }).cancelled, true)
    assert.deepEqual(h.runner.cancelled, [incident.runId])

    const after = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    assert.equal((after.body as { items: { status: string }[] }).items[0]?.status, 'resolved')
  } finally {
    await h.dispose()
  }
})

test('任务失败的故障挂 task_id，故障和任务共用账本', async () => {
  const h = await setup({ maxProposalsPerDay: 5 })
  try {
    h.ctx.events.emit(EVENTS.taskFinished, {
      id: 'run_failed_task',
      title: '检查三国',
      status: 'failed',
      error: '模型超时',
      project: null,
    } as TaskRun)
    await waitFor(() => h.channel.sent.length > 0, '故障通知')
    const res = await h.call({ method: 'GET', path: '/api/v1/incidents', query: {}, headers: {} })
    const items = (res.body as { items: Array<{ taskId?: string | null }> }).items
    assert.equal(items[0]?.taskId, 'run_failed_task')
  } finally {
    await h.dispose()
  }
})
