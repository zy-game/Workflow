import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import path from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
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
    if (this.options.hold) {
      await Promise.race([
        this.options.hold,
        new Promise((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      ])
    }
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
    queueTimeoutMs?: number
    leaseTimeoutMs?: number
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-task-orch-'))
  const workspaceRoot = join(dir, 'workspaces')
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'orchestrator.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const harness = harnessOptions ? new FakeHarness(ctx, harnessOptions) : null
  const orchestratorFiber = ctx.plugin(taskOrchestrator, {
    workspaceRoot,
    startPaused: true,
    timeoutMs: 10000,
    ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
    ...(options.quietHours ? { quietHours: options.quietHours } : {}),
    ...(options.queueTimeoutMs !== undefined ? { queueTimeoutMs: options.queueTimeoutMs } : {}),
    ...(options.leaseTimeoutMs !== undefined ? { leaseTimeoutMs: options.leaseTimeoutMs } : {}),
    ...(options.urgentPriority !== undefined ? { urgentPriority: options.urgentPriority } : {}),
  })
  await orchestratorFiber
  const task = ctx.reflect.get('task', false) as TaskService
  if (options.pre) await options.pre(task)
  const runner = ctx.reflect.get('taskRunner', false) as { start(): void; resumeOnRestart(): Promise<void> }
  await runner.resumeOnRestart()
  runner.start()

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
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(taskOrchestrator.name, 'qm-task')
  assert.deepEqual(taskOrchestrator.inject, ['store', 'gateway'])
})

test('排队超时：没有执行器接管时转 failed，不无限 queued', async () => {
  const h = await setup({}, {
    queueTimeoutMs: 1_000,
    pre: async (task) => {
      await task.create({
        prompt: '离线设备任务',
        target: { executorId: 'device:offline' },
      })
    },
  })
  try {
    const [queued] = await h.task.list(10)
    assert.equal(queued?.status, 'queued')
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await (h.ctx.taskRunner as unknown as { sweepExpired(): Promise<void> }).sweepExpired()
    const [expired] = await h.task.list(10)
    assert.equal(expired?.status, 'failed')
    assert.match(expired?.error ?? '', /排队超时/)
  } finally {
    await h.dispose()
  }
})

test('设备租约：running 的设备任务没有进展就收为 failed，不再永远 running', async () => {
  const h = await setup({}, {
    leaseTimeoutMs: 1_000,
    pre: async (task) => {
      const run = await task.create({ prompt: '设备任务', target: { executorId: 'device:dev-1' } })
      await task.start(run.id)
    },
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await (h.ctx.taskRunner as unknown as { sweepExpired(): Promise<void> }).sweepExpired()
    const [run] = await h.task.list(10)
    assert.equal(run?.status, 'failed')
    assert.match(run?.error ?? '', /设备失联/)
  } finally {
    await h.dispose()
  }
})

test('设备租约：刚报过进展的设备任务不被误杀', async () => {
  const h = await setup({}, {
    leaseTimeoutMs: 1_000,
    pre: async (task) => {
      const run = await task.create({ prompt: '设备任务', target: { executorId: 'device:dev-2' } })
      await task.start(run.id)
      await task.reportProgress(run.id, { phase: '读文件', percent: 20 })
    },
  })
  try {
    await (h.ctx.taskRunner as unknown as { sweepExpired(): Promise<void> }).sweepExpired()
    const [run] = await h.task.list(10)
    assert.equal(run?.status, 'running')
  } finally {
    await h.dispose()
  }
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
    assert.match(sent.text, /worker\/ACP/)
    assert.match(sent.text, /把测试跑一遍/)
    assert.equal(sent.cwd, path.resolve(done.target.cwd ?? ''))
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
    assert.deepEqual(created.body, { ok: false, error: '没有可用的执行器' })

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

test('重启恢复：执行中的 run 重新排队并再次派发', async () => {
  let runningId = ''
  const h = await setup(
    { chunks: ['恢复后继续跑'] },
    {
      pre: async (task) => {
        const run = await task.create({ prompt: '重启前正在跑的任务', title: '中断任务' })
        await task.start(run.id)
        runningId = run.id
      },
    },
  )
  try {
    const finished = await waitFor(async () => {
      const current = await h.task.get(runningId)
      return current && current.finishedAt ? current : null
    }, '中断任务恢复收尾')
    assert.equal(finished.status, 'done')
    assert.equal(h.harness!.requests.length, 1, '应重新派发一次')
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

test('DAG 依赖：前置未完成时不启动，完成后才跑', async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await setup({ chunks: ['ok'], hold }, { maxConcurrent: 2 })
  try {
    const first = await h.task.create({ prompt: '前置' })
    const second = await h.task.create({ prompt: '后置', dependsOn: [first.id] })
    h.ctx.taskRunner.dispatch(first)
    h.ctx.taskRunner.dispatch(second)

    await waitFor(() => h.harness!.requests.length === 1, '只启动前置')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(h.harness!.requests.length, 1, '前置未完成时后置不能启动')

    release()
    await waitFor(() => h.harness!.requests.length === 2, '前置完成后后置启动')
    await waitFor(() => h.ctx.taskRunner.stats().active === 0, '全部收尾')
    const prompts = h.harness!.requests.map((request) => /任务：(.+)$/m.exec(request.text)?.[1] ?? '?')
    assert.deepEqual(prompts, ['前置', '后置'])
  } finally {
    await h.dispose()
  }
})

test('DAG 依赖：前置失败/不存在时，后置直接失败', async () => {
  const h = await setup({ chunks: [], failWith: 'boom' }, { maxConcurrent: 2 })
  try {
    const first = await h.task.create({ prompt: '会失败' })
    const second = await h.task.create({ prompt: '依赖它', dependsOn: [first.id] })
    h.ctx.taskRunner.dispatch(first)
    h.ctx.taskRunner.dispatch(second)

    await waitFor(async () => {
      const current = await h.task.get(second.id)
      return current?.status === 'failed' ? current : null
    }, '后置失败')
    const dependent = await h.task.get(second.id)
    assert.match(dependent?.error ?? '', /前置任务.*失败/)

    const missing = await h.task.create({ prompt: '依赖不存在', dependsOn: ['run_missing'] })
    h.ctx.taskRunner.dispatch(missing)
    await waitFor(async () => {
      const current = await h.task.get(missing.id)
      return current?.status === 'failed' ? current : null
    }, '缺失依赖失败')
    assert.match((await h.task.get(missing.id))?.error ?? '', /不存在/)
  } finally {
    await h.dispose()
  }
})

test('取消：排队/执行中的 run 取消并记账', async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await setup({ chunks: ['ok'], hold }, { maxConcurrent: 1 })
  try {
    const first = await h.task.create({ prompt: '先跑' })
    const second = await h.task.create({ prompt: '排队' })
    h.ctx.taskRunner.dispatch(first)
    await waitFor(() => h.harness!.requests.length === 1, '第一个启动')
    h.ctx.taskRunner.dispatch(second)

    assert.equal(await h.ctx.taskRunner.cancel(second.id, '不跑了'), true)
    assert.equal((await h.task.get(second.id))?.status, 'cancelled')

    assert.equal(await h.ctx.taskRunner.cancel(first.id, '中断'), true)
    assert.equal((await h.task.get(first.id))?.status, 'cancelled')
    release()
    await waitFor(() => h.ctx.taskRunner.stats().active === 0, '收尾')
  } finally {
    await h.dispose()
  }
})

test('抢占：紧急任务取消一个已落 checkpoint 的低优 run', async () => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await setup({ chunks: ['ok'], hold }, { maxConcurrent: 1 })
  try {
    const low = await h.task.create({ prompt: '低优', priority: 1 })
    h.ctx.taskRunner.dispatch(low)
    await waitFor(() => h.harness!.requests.length === 1, '低优启动')
    await h.task.reportProgress(low.id, { phase: 'working' })

    const high = await h.task.create({ prompt: '紧急', priority: 9 })
    h.ctx.taskRunner.dispatch(high)
    await waitFor(() => h.harness!.requests.length === 2, '紧急任务抢占后启动')

    const lowRun = await h.task.get(low.id)
    assert.equal(lowRun?.status, 'cancelled')
    assert.match(lowRun?.error ?? '', /抢占/)
    release()
    await waitFor(() => h.ctx.taskRunner.stats().active === 0, '收尾')
  } finally {
    await h.dispose()
  }
})

test('POST /api/v1/tasks 透传任务合同', async () => {
  const h = await setup({ chunks: ['ok'] })
  try {
    const created = await h.call(
      request('POST', '/api/v1/tasks', {
        prompt: '合同任务',
        contract: {
          deadline: '2026-12-01T00:00:00.000Z',
          enforcement: 'strict',
          progressSignal: 'artifact',
        },
      }),
    )
    assert.equal(created.status, 202)
    const run = (created.body as { run: TaskRun }).run
    assert.equal(run.contract?.enforcement, 'strict')
    assert.equal(run.contract?.progressSignal, 'artifact')
    assert.ok(run.contract?.deadline)
    await waitFor(async () => {
      const current = await h.task.get(run.id)
      return current?.finishedAt ? current : null
    }, '任务收尾')
  } finally {
    await h.dispose()
  }
})

test('token 预算：超过合同上限立即中止并记 failed', async () => {
  const h = await setup({ chunks: ['继续跑'] })
  try {
    const created = await h.call(
      request('POST', '/api/v1/tasks', {
        prompt: '预算测试',
        contract: { enforcement: 'firm', tokenBudget: 10 },
      }),
    )
    const id = (created.body as { run: { id: string } }).run.id
    const finished = await waitFor(async () => {
      const current = await h.task.get(id)
      return current && current.finishedAt ? current : null
    }, '预算中止')
    assert.equal(finished.status, 'failed')
    assert.match(finished.error ?? '', /token 预算超限/)
    assert.equal(finished.usage?.totalTokens, 42)
  } finally {
    await h.dispose()
  }
})

test('统一任务模型：建议/定时任务带 origin/trigger/schedule，事件流可查', async () => {
  const h = await setup({ chunks: ['ok'] })
  try {
    const suggestion = await h.task.create({
      prompt: '要不要安排一次复盘',
      kind: 'suggestion',
      status: 'proposed',
      origin: 'autonomy',
      trigger: 'now',
    })
    assert.equal(suggestion.kind, 'suggestion')
    assert.equal(suggestion.status, 'proposed')
    assert.equal(suggestion.origin, 'autonomy')

    const at = new Date(Date.now() + 3_600_000)
    const scheduled = await h.task.create({
      prompt: '提醒开会',
      status: 'scheduled',
      origin: 'schedule',
      trigger: 'at',
      schedule: { at },
    })
    assert.equal(scheduled.trigger, 'at')
    assert.ok(scheduled.schedule?.at)

    const events = await (h.task as unknown as { events: (id: string) => Promise<Array<{ kind: string }>> }).events(
      suggestion.id,
    )
    assert.ok(events.some((event) => event.kind === 'created'))
    assert.equal(events[0]?.kind, 'created')
  } finally {
    await h.dispose()
  }
})

