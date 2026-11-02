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
  /** 卡住执行，直到测试放行（验证并发/排队） */
  hold?: Promise<void>
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
    if (this.options.hold) await this.options.hold
    for (const text of this.options.chunks ?? []) {
      await new Promise((resolve) => setTimeout(resolve, 1))
      yield { type: 'text', text }
    }
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 } }
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

async function setup(
  harnessOptions: FakeHarnessOptions | null = {},
  options: {
    maxConcurrent?: number
    pre?: (task: TaskService) => Promise<void>
    quietHours?: { start: string; end: string }
    urgentPriority?: number
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-task-orch-'))
  const workspaceRoot = join(dir, 'workspaces')
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'orchestrator.db') })
  await storeFiber
  const taskFiber = ctx.plugin(taskPlugin, { workspaceRoot })
  await taskFiber
  await ctx.plugin(gatewayPlugin)
  const task = ctx.reflect.get('task', false) as TaskService
  if (options.pre) await options.pre(task)
  const harness = harnessOptions ? new FakeHarness(ctx, harnessOptions) : null
  const orchestratorFiber = ctx.plugin(taskOrchestrator, {
    workspaceRoot,
    timeoutMs: 3000,
    ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
    ...(options.quietHours ? { quietHours: options.quietHours } : {}),
    ...(options.urgentPriority !== undefined ? { urgentPriority: options.urgentPriority } : {}),
  })
  await orchestratorFiber

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
    assert.equal(done.usage?.totalTokens, 42, 'ACP 的 usage 应记进账本')
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

test('并发容量：maxConcurrent=1 时第二个 run 排队，第一个结束后才开始', async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await setup({ chunks: ['好'], hold }, { maxConcurrent: 1 })
  try {
    const first = await h.call(request('POST', '/api/v1/tasks', { prompt: '第一个' }))
    const second = await h.call(request('POST', '/api/v1/tasks', { prompt: '第二个' }))
    const firstRun = (first.body as { run: TaskRun }).run
    const secondRun = (second.body as { run: TaskRun }).run

    await waitFor(async () => (h.harness!.requests.length === 1 ? true : null), '第一个开始执行')
    assert.equal((await h.task.get(secondRun.id))?.status, 'queued', '第二个应排队')
    assert.equal((await h.task.get(firstRun.id))?.status, 'running')

    release()

    const doneSecond = await waitFor(async () => {
      const current = await h.task.get(secondRun.id)
      return current && current.finishedAt ? current : null
    }, '第二个收尾')
    assert.equal(doneSecond.status, 'done')
    assert.deepEqual(
      h.harness!.requests.map((req) => req.text.includes('第一个') ? 'first' : 'second'),
      ['first', 'second'],
      '按 FIFO 顺序执行',
    )
  } finally {
    await h.dispose()
  }
})

test('重启恢复：排队中的 run 会重新排队并执行', async () => {
  let queuedId = ''
  const h = await setup(
    { chunks: ['恢复完成'] },
    {
      pre: async (task) => {
        const run = await task.create({ prompt: '重启前的排队任务', title: '排队任务' })
        queuedId = run.id
      },
    },
  )
  try {
    const done = await waitFor(async () => {
      const current = await h.task.get(queuedId)
      return current && current.finishedAt ? current : null
    }, '恢复后收尾')
    assert.equal(done.status, 'done')
    assert.equal(done.result, '恢复完成')
  } finally {
    await h.dispose()
  }
})

test('重启恢复：执行中的 run 没有 resume，如实记 failed', async () => {
  let runningId = ''
  const h = await setup(
    { chunks: ['不会跑到这里'] },
    {
      pre: async (task) => {
        const run = await task.create({ prompt: '重启前正在跑的任务', title: '中断任务' })
        await task.start(run.id)
        runningId = run.id
      },
    },
  )
  try {
    const failed = await waitFor(async () => {
      const current = await h.task.get(runningId)
      return current && current.finishedAt ? current : null
    }, '中断任务收尾')
    assert.equal(failed.status, 'failed')
    assert.match(failed.error ?? '', /进程重启/)
    assert.equal(h.harness!.requests.length, 0, '不应再拉起执行')
  } finally {
    await h.dispose()
  }
})

test('排队按优先级：高优先跑，同级按到达顺序', async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await setup({ chunks: ['ok'], hold }, { maxConcurrent: 1 })
  try {
    const a = await h.task.create({ prompt: 'A', priority: 1 })
    const b = await h.task.create({ prompt: 'B', priority: 9 })
    const c = await h.task.create({ prompt: 'C', priority: 5 })
    const d = await h.task.create({ prompt: 'D', priority: 5 })

    h.ctx.taskRunner.dispatch(a)
    await waitFor(() => h.harness!.requests.length === 1, 'A 开始')
    h.ctx.taskRunner.dispatch(b)
    h.ctx.taskRunner.dispatch(c)
    h.ctx.taskRunner.dispatch(d)
    release()

    await waitFor(() => h.harness!.requests.length === 4, '四个都开始')
    const prompts = h.harness!.requests.map((request) => /任务：(.+)$/m.exec(request.text)?.[1] ?? '?')
    assert.deepEqual(prompts, ['A', 'B', 'C', 'D'])
    await waitFor(() => h.ctx.taskRunner.stats().active === 0, '全部收尾')
  } finally {
    await h.dispose()
  }
})

test('静默时段：非紧急任务不启动，紧急任务照跑', async () => {
  const now = new Date()
  const clock = (offsetMinutes: number): string => {
    const date = new Date(now.getTime() + offsetMinutes * 60_000)
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  const h = await setup(
    { chunks: ['ok'] },
    { maxConcurrent: 1, quietHours: { start: clock(-60), end: clock(60) }, urgentPriority: 8 },
  )
  try {
    const normal = await h.task.create({ prompt: '普通任务', priority: 5 })
    const urgent = await h.task.create({ prompt: '紧急任务', priority: 9 })
    h.ctx.taskRunner.dispatch(normal)
    h.ctx.taskRunner.dispatch(urgent)

    await waitFor(() => h.harness!.requests.length === 1, '紧急任务启动')
    const prompts = h.harness!.requests.map((request) => /任务：(.+)$/m.exec(request.text)?.[1] ?? '?')
    assert.deepEqual(prompts, ['紧急任务'], '静默时段只放行紧急任务')
    assert.equal(h.ctx.taskRunner.stats().queued, 1)
    assert.equal(h.ctx.taskRunner.stats().quiet, true)
  } finally {
    await h.dispose()
  }
})

test('POST /api/v1/tasks 支持 priority，并持久化到 run', async () => {
  const h = await setup({ chunks: ['ok'] })
  try {
    const created = await h.call(request('POST', '/api/v1/tasks', { prompt: '紧急任务', priority: 9 }))
    assert.equal(created.status, 202)
    const run = (created.body as { run: TaskRun }).run
    assert.equal(run.priority, 9)
    await waitFor(async () => {
      const current = await h.task.get(run.id)
      return current?.finishedAt ? current : null
    }, '任务收尾')
  } finally {
    await h.dispose()
  }
})
