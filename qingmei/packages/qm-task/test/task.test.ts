import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import path from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as taskPlugin from '@qingmei/provider-task-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as taskOrchestrator from '../src/index.ts'
import {
  HarnessService,
  type GatewayRequest,
  type GatewayResponse,
  type HarnessEvent,
  type HarnessRequest,
  type TaskRun,
  type TaskService,
} from '@qingmei/core'

interface FakeHarnessOptions {
  chunks?: string[]
  failWith?: string
  streamError?: string
  available?: boolean
}

class FakeHarness extends HarnessService {
  readonly requests: HarnessRequest[] = []
  readonly closed: string[] = []
  private readonly options: FakeHarnessOptions

  constructor(ctx: Context, options: FakeHarnessOptions) {
    super(ctx)
    this.options = options
  }

  async available(): Promise<boolean> {
    return this.options.available ?? true
  }

  async *run(req: HarnessRequest): AsyncIterable<HarnessEvent> {
    this.requests.push(req)
    req.onSession?.('sess_fake')
    if (this.options.failWith) throw new Error(this.options.failWith)
    for (const text of this.options.chunks ?? []) {
      await new Promise((resolve) => setTimeout(resolve, 1))
      yield { type: 'text', text }
    }
    if (this.options.streamError) {
      yield { type: 'error', message: this.options.streamError }
      return
    }
    yield { type: 'done', stopReason: 'end_turn' }
  }

  async close(conversationId: string): Promise<void> {
    this.closed.push(conversationId)
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
    send(payload) {
      body = payload
    },
  }
  return { res, read: () => ({ status, body }) }
}

function request(method: string, path: string, body?: unknown, query: Record<string, string> = {}): GatewayRequest {
  return { method, path, query, headers: {}, body }
}

async function waitFor<T>(fn: () => Promise<T | null>, label: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${label}`)
}

async function setup(harnessOptions: FakeHarnessOptions | null = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-task-orch-'))
  const workspaceRoot = join(dir, 'workspaces')
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'orchestrator.db') })
  await storeFiber
  const taskFiber = ctx.plugin(taskPlugin, { workspaceRoot })
  await taskFiber
  await ctx.plugin(gatewayPlugin)
  const harness = harnessOptions ? new FakeHarness(ctx, harnessOptions) : null
  const orchestratorFiber = ctx.plugin(taskOrchestrator, { workspaceRoot, timeoutMs: 3000 })
  await orchestratorFiber

  const task = ctx.reflect.get('task', false) as TaskService
  return {
    ctx,
    task,
    harness,
    workspaceRoot,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await orchestratorFiber.dispose()
      await taskFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(taskOrchestrator.name, 'qm-task')
  assert.deepEqual(taskOrchestrator.inject, ['task', 'gateway'])
})

test('POST /api/v1/tasks：建 run、派给 harness、正常收尾为 done', async () => {
  const h = await setup({ chunks: ['我已经', '跑完了测试。'] })
  try {
    const created = await h.call(request('POST', '/api/v1/tasks', { prompt: '把测试跑一遍', title: '跑测试' }))
    assert.equal(created.status, 202)
    const run = (created.body as { run: TaskRun }).run
    assert.equal(run.status, 'queued')
    assert.equal(run.title, '跑测试')

    const done = await waitFor(async () => {
      const current = await h.task.get(run.id)
      return current && current.finishedAt ? current : null
    }, '任务收尾')

    assert.equal(done.status, 'done')
    assert.equal(done.result, '我已经跑完了测试。')
    assert.equal(h.harness!.requests.length, 1)

    const sent = h.harness!.requests[0]!
    assert.equal(sent.conversationId, `task_${run.id}`)
    assert.match(sent.text, new RegExp(`runId 是 ${run.id}`))
    assert.match(sent.text, /qm_report_progress/)
    assert.match(sent.text, /把测试跑一遍/)
    assert.equal(sent.cwd, path.resolve(done.cwd))
    assert.equal(done.sessionId, 'sess_fake', 'harness 侧 sessionId 应回填进账本')
    assert.deepEqual(h.harness!.closed, [`task_${run.id}`])
  } finally {
    await h.dispose()
  }
})

test('harness 报错：run 记 failed 并保留错误', async () => {
  const h = await setup({ streamError: '模型额度用尽' })
  try {
    const created = await h.call(request('POST', '/api/v1/tasks', { prompt: '跑测试' }))
    const run = (created.body as { run: TaskRun }).run

    const failed = await waitFor(async () => {
      const current = await h.task.get(run.id)
      return current && current.finishedAt ? current : null
    }, '任务失败收尾')

    assert.equal(failed.status, 'failed')
    assert.equal(failed.error, '模型额度用尽')
  } finally {
    await h.dispose()
  }
})

test('harness 直接抛错：run 记 failed', async () => {
  const h = await setup({ failWith: '管道断了' })
  try {
    const created = await h.call(request('POST', '/api/v1/tasks', { prompt: '跑测试' }))
    const run = (created.body as { run: TaskRun }).run

    const failed = await waitFor(async () => {
      const current = await h.task.get(run.id)
      return current && current.finishedAt ? current : null
    }, '任务失败收尾')

    assert.equal(failed.status, 'failed')
    assert.match(failed.error ?? '', /管道断了/)
  } finally {
    await h.dispose()
  }
})

test('没有 harness 时 POST 返回 503，且不建 run', async () => {
  const h = await setup(null)
  try {
    const created = await h.call(request('POST', '/api/v1/tasks', { prompt: '跑测试' }))
    assert.equal(created.status, 503)
    assert.deepEqual(created.body, { ok: false, error: '没有可用的 harness' })

    const list = await h.call(request('GET', '/api/v1/tasks'))
    assert.equal(list.status, 200)
    assert.deepEqual((list.body as { items: TaskRun[] }).items, [])
  } finally {
    await h.dispose()
  }
})

test('prompt 为空返回 400', async () => {
  const h = await setup()
  try {
    const created = await h.call(request('POST', '/api/v1/tasks', { prompt: '   ' }))
    assert.equal(created.status, 400)
  } finally {
    await h.dispose()
  }
})

test('GET /api/v1/tasks：列表与按 id 查询，未知 id 404', async () => {
  const h = await setup({ chunks: ['好'] })
  try {
    const created = await h.call(request('POST', '/api/v1/tasks', { prompt: '跑测试' }))
    const run = (created.body as { run: TaskRun }).run
    await waitFor(async () => {
      const current = await h.task.get(run.id)
      return current && current.finishedAt ? current : null
    }, '任务收尾')

    const list = await h.call(request('GET', '/api/v1/tasks'))
    assert.equal(list.status, 200)
    assert.equal((list.body as { items: TaskRun[] }).items.length, 1)

    const one = await h.call(request('GET', '/api/v1/tasks', undefined, { id: run.id }))
    assert.equal(one.status, 200)
    assert.equal((one.body as { run: TaskRun }).run.id, run.id)

    const missing = await h.call(request('GET', '/api/v1/tasks', undefined, { id: 'run_nope' }))
    assert.equal(missing.status, 404)
  } finally {
    await h.dispose()
  }
})
