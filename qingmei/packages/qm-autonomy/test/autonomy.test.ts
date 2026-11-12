import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as autonomyPlugin from '../src/index.ts'
import {
  EVENTS,
  ApprovalService,
  ChannelService,
  ScheduleService,
  TaskRunnerService,
  TaskService,
  type ApprovalRequest,
  type ChannelAdapter,
  type OutboundEnvelope,
  type SendResult,
  type AutonomyService,
  type CreateApprovalInput,
  type GatewayRequest,
  type GatewayResponse,
  type Scheduled,
  type ScheduleInput,
  type SchedulePatch,
  type TaskRun,
  type CreateTaskInput,
} from '@qingmei/core'

class FakeApproval extends ApprovalService {
  pending: ApprovalRequest[] = []

  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    throw new Error('不需要在自主循环测试里创建审批')
  }
  async get(): Promise<ApprovalRequest | null> {
    return null
  }
  async list(status?: string): Promise<ApprovalRequest[]> {
    return status === 'pending' ? this.pending : []
  }
  async decide(): Promise<ApprovalRequest | null> {
    return null
  }
  async wait(): Promise<ApprovalRequest | null> {
    return null
  }
}

class FakeTask extends TaskService {
  runs: TaskRun[] = []

  async create(input: CreateTaskInput): Promise<TaskRun> {
    const run = taskRun({
      id: `run_` + (this.runs.length + 1),
      title: input.title ?? '任务',
      prompt: input.prompt,
      status: 'queued',
      retryOf: input.retryOf ?? null,
      ...(input.target ? { target: input.target } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    })
    this.runs.push(run)
    return run
  }
  async get(id: string): Promise<TaskRun | null> {
    return this.runs.find((run) => run.id === id) ?? null
  }
  async list(limit = 20): Promise<TaskRun[]> {
    return this.runs.slice(0, limit)
  }
  async start(): Promise<TaskRun | null> {
    return null
  }
  async setStatus(): Promise<TaskRun | null> {
    return null
  }
  async reportProgress(): Promise<TaskRun | null> {
    return null
  }
  async addArtifact(): Promise<TaskRun | null> {
    return null
  }
  async reportUsage(): Promise<TaskRun | null> {
    return null
  }
  async finish(): Promise<TaskRun | null> {
    return null
  }
}

class FakeChannel extends ChannelService {
  readonly sent: OutboundEnvelope[] = []
  fail = false

  async register(_adapter: ChannelAdapter): Promise<() => void> {
    return () => undefined
  }
  async send(envelope: OutboundEnvelope): Promise<SendResult> {
    if (this.fail) return { ok: false, error: '渠道离线' }
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

class FakeSchedule extends ScheduleService {
  schedules: Scheduled[] = []

  async create(_input: ScheduleInput): Promise<Scheduled> {
    throw new Error('not used')
  }
  async list(): Promise<Scheduled[]> {
    return this.schedules
  }
  async cancel(): Promise<boolean> {
    return false
  }
  async pause(): Promise<boolean> {
    return false
  }
  async resume(): Promise<boolean> {
    return false
  }
  async update(_id: string, _patch: SchedulePatch): Promise<Scheduled | null> {
    return null
  }
}

function approvalRequest(prompt = '子 agent 请求执行：bash: npm test'): ApprovalRequest {
  return {
    id: 'ap_1',
    action: 'acp:bash: npm test',
    prompt,
    status: 'pending',
    runId: null,
    requester: 'harness:dsh',
    channel: 'web',
    createdAt: new Date(),
    decidedAt: null,
    reason: null,
  }
}

function taskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run_1',
    title: '跑测试',
    prompt: '跑测试',
    project: null,
    kind: 'task',
    priority: 5,
    dependsOn: [],
    retryOf: null,
    contract: null,
    target: { executorId: 'local', cwd: './data/workspaces/run_1' },
    sessionId: null,
    status: 'running',
    progress: null,
    progressHistory: [],
    artifacts: [],
    usage: null,
    result: null,
    error: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    ...overrides,
  }
}

function scheduled(overrides: Partial<Scheduled> = {}): Scheduled {
  return {
    id: 'sch_1',
    text: '开会',
    channel: 'web',
    conversationId: 'owner',
    nextAt: new Date(Date.now() + 10 * 60_000),
    everyMs: null,
    cron: null,
    timezone: null,
    missedPolicy: 'fire-once',
    pausedAt: null,
    firedAt: null,
    ...overrides,
  }
}

async function setup(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-autonomy-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'autonomy.db') })
  await storeFiber
  await ctx.plugin(FakeApproval)
  await ctx.plugin(FakeTask)
  await ctx.plugin(FakeSchedule)
  await ctx.plugin(FakeChannel)
  await ctx.plugin(FakeTaskRunner)
  await ctx.plugin(gatewayPlugin)
  const autonomyFiber = ctx.plugin(autonomyPlugin, { tickMs: 0, quietStart: 0, quietEnd: 0, ...config })
  await autonomyFiber

  const autonomy = ctx.reflect.get('autonomy', false) as AutonomyService
  const approval = ctx.reflect.get('approval', false) as FakeApproval
  const task = ctx.reflect.get('task', false) as FakeTask
  const schedule = ctx.reflect.get('schedule', false) as FakeSchedule

  return {
    ctx,
    autonomy,
    approval,
    task,
    schedule,
    channel: ctx.reflect.get('channel', false) as FakeChannel,
    taskRunner: ctx.reflect.get('taskRunner', false) as FakeTaskRunner,
    async call(req: GatewayRequest) {
      let status = 0
      let body: unknown
      const res: GatewayResponse = {
        status(code: number) {
          status = code
          return res
        },
        header() {
          return res
        },
        send(payload: unknown) {
          body = payload
        },
      }
      const handled = await ctx.gateway.dispatch(req, res)
      return { handled, status, body }
    },
    async dispose() {
      await autonomyFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(autonomyPlugin.name, 'qm-autonomy')
  assert.deepEqual(autonomyPlugin.inject, ['store', 'approval', 'task', 'schedule', 'gateway', 'channel', 'taskRunner'])
})

test('tick：有待确认的审批 → 选它，预算 +1，账本留痕', async () => {
  const h = await setup()
  try {
    h.approval.pending = [approvalRequest()]
    const trace = await h.autonomy.tick('manual')

    assert.equal(trace.mode, 'A1')
    assert.equal(trace.chosen?.id, 'approval.pending')
    assert.match(trace.reason, /最早一条/)
    assert.equal(trace.budget.used, 1)
    assert.equal(trace.snapshot.pendingApprovals, 1)
    assert.equal(trace.trigger, 'manual')

    const traces = await h.autonomy.list()
    assert.equal(traces.length, 1)
    assert.equal(traces[0]!.id, trace.id)
  } finally {
    await h.dispose()
  }
})

test('tick：同一规则在冷却期内不再重复建议', async () => {
  const h = await setup({ cooldownMinutes: 60 })
  try {
    h.approval.pending = [approvalRequest()]
    const first = await h.autonomy.tick('tick')
    assert.equal(first.chosen?.id, 'approval.pending')

    const second = await h.autonomy.tick('tick')
    assert.equal(second.chosen, null)
    assert.equal(second.budget.used, 1, '冷却中的候选不消耗预算')
    assert.equal(second.suppressed[0]?.id, 'approval.pending')
    assert.match(second.suppressed[0]!.reason, /冷却中/)
  } finally {
    await h.dispose()
  }
})

test('tick：预算用完就不再建议，并说明原因', async () => {
  const h = await setup({ dailyBudget: 1, cooldownMinutes: 0 })
  try {
    h.schedule.schedules = [scheduled()]
    const first = await h.autonomy.tick('tick')
    assert.equal(first.chosen?.id, 'schedule.upcoming')
    assert.equal(first.budget.used, 1)

    const second = await h.autonomy.tick('tick')
    assert.equal(second.chosen, null)
    assert.equal(second.budget.used, 1)
    assert.match(second.reason, /已用 1\/1/)
    assert.equal(second.suppressed[0]?.reason, '今日预算用完')
  } finally {
    await h.dispose()
  }
})

test('tick：dailyBudget=0 表示不限量，同一天可以继续发建议', async () => {
  const h = await setup({ dailyBudget: 0, cooldownMinutes: 0 })
  try {
    h.schedule.schedules = [scheduled()]
    const first = await h.autonomy.tick('tick')
    assert.equal(first.chosen?.id, 'schedule.upcoming')
    const second = await h.autonomy.tick('tick')
    assert.equal(second.chosen?.id, 'schedule.upcoming', '不限量时第二次仍可发')
    assert.equal(second.budget.limit, 0)
  } finally {
    await h.dispose()
  }
})
test('tick：静默时段只记录，不消耗预算', async () => {
  const h = await setup({ quietStart: 0, quietEnd: 24 })
  try {
    h.approval.pending = [approvalRequest()]
    const trace = await h.autonomy.tick('tick')
    assert.equal(trace.chosen, null)
    assert.equal(trace.budget.used, 0)
    assert.match(trace.reason, /静默时段/)
    assert.equal(trace.suppressed[0]?.reason, '静默时段')
  } finally {
    await h.dispose()
  }
})

test('tick：A0 观察模式只记录不动作', async () => {
  const h = await setup({ mode: 'A0' })
  try {
    h.approval.pending = [approvalRequest()]
    const trace = await h.autonomy.tick('tick')
    assert.equal(trace.mode, 'A0')
    assert.equal(trace.chosen, null)
    assert.match(trace.reason, /A0/)
  } finally {
    await h.dispose()
  }
})

test('tick：失败任务给 task.retry 建议；日程给 notify', async () => {
  const h = await setup()
  try {
    h.task.runs = [
      taskRun({ id: 'run_failed', status: 'failed', error: '测试挂了', finishedAt: new Date() }),
    ]
    const failedTrace = await h.autonomy.tick('tick')
    assert.equal(failedTrace.chosen?.id, 'task.failed')
    assert.equal(failedTrace.chosen?.action, 'task.retry')
    assert.match(failedTrace.reason, /测试挂了/)

    h.task.runs = []
    h.approval.pending = []
    h.schedule.schedules = [scheduled({ text: '开会' })]
    await h.autonomy.tick('tick')
    const scheduleTrace = (await h.autonomy.list())[0]!
    assert.equal(scheduleTrace.chosen?.id, 'schedule.upcoming')
    assert.equal(scheduleTrace.chosen?.action, 'notify.self')
    assert.match(scheduleTrace.reason, /开会/)
  } finally {
    await h.dispose()
  }
})

test('HTTP：GET /api/v1/autonomy 返回模式、预算与账本；POST tick 立即跑一次', async () => {
  const h = await setup({ dailyBudget: 2 })
  try {
    h.approval.pending = [approvalRequest()]
    const ticked = await h.call({ method: 'POST', path: '/api/v1/autonomy/tick', query: {}, headers: {} })
    assert.equal(ticked.status, 200)
    assert.equal((ticked.body as { trace: { chosen: { id: string } | null } }).trace.chosen?.id, 'approval.pending')

    const listed = await h.call({ method: 'GET', path: '/api/v1/autonomy', query: {}, headers: {} })
    assert.equal(listed.status, 200)
    const body = listed.body as { mode: string; budget: { used: number; limit: number }; items: unknown[] }
    assert.equal(body.mode, 'A1')
    assert.deepEqual(body.budget, { used: 1, limit: 2 })
    assert.equal(body.items.length, 1)
  } finally {
    await h.dispose()
  }
})

test('状态落库：重启后预算与冷却不丢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-autonomy-restart-'))
  try {
    const boot = async () => {
      const ctx = new Context()
      const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'state.db') })
      await storeFiber
      await ctx.plugin(FakeApproval)
      await ctx.plugin(FakeTask)
      await ctx.plugin(FakeSchedule)
  await ctx.plugin(FakeChannel)
  await ctx.plugin(FakeTaskRunner)
      await ctx.plugin(gatewayPlugin)
      const fiber = ctx.plugin(autonomyPlugin, { tickMs: 0, quietStart: 0, quietEnd: 0 })
      await fiber
      return { ctx, async dispose() { await fiber.dispose(); await storeFiber.dispose() } }
    }

    const first = await boot()
    const approval = first.ctx.reflect.get('approval', false) as FakeApproval
    const autonomy = first.ctx.reflect.get('autonomy', false) as AutonomyService
    approval.pending = [approvalRequest()]
    await autonomy.tick('tick')
    await first.dispose()

    const second = await boot()
    const autonomy2 = second.ctx.reflect.get('autonomy', false) as AutonomyService
    const state = await autonomy2.status()
    assert.equal(state.used, 1)
    assert.ok((state.cooldowns['approval.pending'] ?? 0) > Date.now())
    assert.equal((await autonomy2.list()).length, 1)
    await second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('执行：A1 遇到需要 A2 的动作，降级成建议并发出去', async () => {
  const h = await setup({ mode: 'A1' })
  try {
    h.task.runs = [taskRun({ id: 'run_failed', status: 'failed', error: '测试挂了', finishedAt: new Date() })]
    const trace = await h.autonomy.tick('tick')

    assert.equal(trace.chosen?.action, 'task.retry')
    assert.equal(trace.execution?.status, 'suggested')
    assert.equal(trace.execution?.action, 'notify.self')
    assert.match(trace.execution?.detail ?? '', /需要 A2/)
    assert.equal(h.channel.sent.length, 1, '建议应真的发到主人私聊')
    assert.match((h.channel.sent[0]!.blocks[0] as { text: string }).text, /💡/)
    assert.equal(h.taskRunner.dispatched.length, 0, 'A1 不允许直接重试')
  } finally {
    await h.dispose()
  }
})

test('执行：A2 才会真的重试失败任务，并带回执 runId', async () => {
  const h = await setup({ mode: 'A2' })
  try {
    h.task.runs = [taskRun({ id: 'run_failed', status: 'failed', error: '测试挂了', finishedAt: new Date() })]
    const trace = await h.autonomy.tick('tick')

    assert.equal(trace.execution?.status, 'executed')
    assert.equal(trace.execution?.action, 'task.retry')
    assert.ok(trace.execution?.runId, '回执要带新 run 的 id')
    assert.equal(h.taskRunner.dispatched.length, 1)
    assert.equal(h.channel.sent.length, 0, 'A2 直接执行，不再重复发建议')
    const created = h.task.runs.find((run) => run.id === trace.execution!.runId)
    assert.equal(created?.title, '重试：跑测试')
  } finally {
    await h.dispose()
  }
})

test('执行：A2 重试保留原任务的目标与优先级', async () => {
  const h = await setup({ mode: 'A2' })
  try {
    h.task.runs = [
      taskRun({
        id: 'run_failed',
        status: 'failed',
        error: '设备上的任务挂了',
        finishedAt: new Date(),
        target: { executorId: 'device:dev-1', workspaceId: 'ws-1' },
        priority: 7,
      }),
    ]
    const trace = await h.autonomy.tick('tick')
    const created = h.task.runs.find((run) => run.id === trace.execution?.runId)
    assert.equal(created?.target.executorId, 'device:dev-1', '设备任务不能因为重试悄悄跑到服务器上')
    assert.equal(created?.target.workspaceId, 'ws-1')
    assert.equal(created?.priority, 7)
  } finally {
    await h.dispose()
  }
})

test('执行：同一个失败任务只重试一次，不产生重试风暴', async () => {
  const h = await setup({ mode: 'A2' })
  try {
    const finishedAt = new Date()
    h.task.runs = [
      taskRun({ id: 'run_failed', status: 'failed', error: '测试挂了', finishedAt }),
      taskRun({
        id: 'run_retry',
        title: '重试：跑测试',
        status: 'done',
        createdAt: new Date(finishedAt.getTime() + 1_000),
        finishedAt: new Date(finishedAt.getTime() + 2_000),
      }),
    ]
    const trace = await h.autonomy.tick('tick')
    assert.equal(trace.execution?.status, 'skipped')
    assert.match(trace.execution?.detail ?? '', /已经重试过/)
    assert.equal(h.taskRunner.dispatched.length, 0)
  } finally {
    await h.dispose()
  }
})

test('执行：重试出来的任务再失败，不再继续重试', async () => {
  const h = await setup({ mode: 'A2' })
  try {
    h.task.runs = [
      taskRun({
        id: 'run_retry',
        title: '重试：跑测试',
        status: 'failed',
        retryOf: 'run_orig',
        error: '重试也挂了',
        finishedAt: new Date(),
      }),
    ]
    const trace = await h.autonomy.tick('tick')
    assert.equal(trace.execution?.status, 'skipped')
    assert.match(trace.execution?.detail ?? '', /本身是重试/)
    assert.equal(h.taskRunner.dispatched.length, 0)
  } finally {
    await h.dispose()
  }
})

test('执行：notify.self 在 A1 就允许，发送失败要记 failed 回执', async () => {
  const h = await setup({ mode: 'A1', cooldownMinutes: 0 })
  try {
    h.approval.pending = [approvalRequest()]
    const ok = await h.autonomy.tick('tick')
    assert.equal(ok.execution?.status, 'executed', ok.execution?.detail)
    assert.equal(h.channel.sent.length, 1)

    h.approval.pending = [approvalRequest()]
    h.channel.fail = true
    const failed = await h.autonomy.tick('tick')
    assert.equal(failed.chosen?.id, 'approval.pending')
    assert.equal(failed.execution?.status, 'failed')
    assert.match(failed.execution?.detail ?? '', /渠道离线/)
  } finally {
    await h.dispose()
  }
})

test('执行：A0 只有记录，没有回执', async () => {
  const h = await setup({ mode: 'A0' })
  try {
    h.approval.pending = [approvalRequest()]
    const trace = await h.autonomy.tick('tick')
    assert.equal(trace.chosen, null)
    assert.equal(trace.execution, null)
    assert.equal(h.channel.sent.length, 0)
  } finally {
    await h.dispose()
  }
})

test('账本保留期：超过 retentionDays 的 trace 被清掉，新的保留', async () => {
  const h = await setup({ retentionDays: 1 })
  try {
    const old = {
      id: 'aut_old',
      at: Date.now() - 3 * 86_400_000,
      trigger: 'tick',
      mode: 'A1',
      snapshot_json: JSON.stringify({ at: new Date().toISOString(), pendingApprovals: 0, runningTasks: 0, failedTasks: 0, upcomingSchedules: 0 }),
      candidates_json: '[]',
      chosen_json: null,
      execution_json: null,
      suppressed_json: '[]',
      budget_json: JSON.stringify({ day: 'x', limit: 3, used: 0 }),
      reason: '旧的',
    }
    await h.ctx.store.collection('qm_autonomy_trace').insert(old)

    h.approval.pending = [approvalRequest()]
    await h.autonomy.tick('tick')

    const ids = (await h.autonomy.list(50)).map((trace) => trace.id)
    assert.ok(!ids.includes('aut_old'), '过期 trace 应被清理')
    assert.ok(ids.length >= 1)
  } finally {
    await h.dispose()
  }
})

test('盘点任务收尾后把结论回推给主人，普通任务不回推', async () => {
  const h = await setup()
  try {
    h.ctx.events.emit(EVENTS.taskFinished, taskRun({ id: 'run_inv', kind: 'inventory', project: '青梅', status: 'done', result: '现状：正常' }))
    assert.equal(h.channel.sent.length, 1)
    const text = (h.channel.sent[0]!.blocks[0] as { text: string }).text
    assert.match(text, /盘点完成（青梅）/)
    assert.match(text, /现状：正常/)

    h.ctx.events.emit(EVENTS.taskFinished, taskRun({ id: 'run_task', kind: 'task', project: '青梅', status: 'done', result: '普通任务' }))
    assert.equal(h.channel.sent.length, 1, '普通任务不应该触发汇报')
  } finally {
    await h.dispose()
  }
})

test('采纳：建议发出后有人说话，pending 清空并累计 streak', async () => {
  const h = await setup()
  try {
    h.approval.pending = [approvalRequest()]
    await h.autonomy.tick('tick')
    const pendingBefore = (await h.autonomy.status()).pending
    assert.ok(pendingBefore, '发出去的建议应进入等回应状态')
    assert.equal(pendingBefore?.candidateId, 'approval.pending')

    h.ctx.events.emit(EVENTS.inbound, {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    const after = await h.autonomy.status()
    assert.equal(after.accepted, 1)
    assert.equal(after.streak, 1)
    assert.equal(after.pending, null)
  } finally {
    await h.dispose()
  }
})

test('忽略：过了回应窗口还没人理，记一次忽略并中断 streak', async () => {
  const h = await setup({ acceptWindowMinutes: 0 })
  try {
    h.approval.pending = [approvalRequest()]
    await h.autonomy.tick('tick')
    await new Promise((resolve) => setTimeout(resolve, 5))

    await h.autonomy.tick('tick')
    const state = await h.autonomy.status()
    assert.equal(state.ignored, 1)
    assert.equal(state.streak, 0)
    assert.equal(state.ignoredByRule['approval.pending'], 1)
  } finally {
    await h.dispose()
  }
})

test('降频：同一规则被忽略 3 次后，冷却翻倍', async () => {
  const h = await setup({ cooldownMinutes: 60 })
  try {
    await h.ctx.store.collection('qm_autonomy_state').insert({
      id: 'state',
      mode: 'A1',
      day: '',
      used: 0,
      last_tick_at: null,
      cooldowns_json: '{}',
      accepted: 0,
      ignored: 0,
      streak: 0,
      pending_json: null,
      ignored_by_rule_json: JSON.stringify({ 'approval.pending': 3 }),
    })

    h.approval.pending = [approvalRequest()]
    const before = Date.now()
    await h.autonomy.tick('tick')
    const until = (await h.autonomy.status()).cooldowns['approval.pending'] ?? 0
    const minutes = (until - before) / 60_000
    assert.ok(minutes >= 115 && minutes <= 125, `冷却应约为 120 分钟，实际 ${minutes}`)
  } finally {
    await h.dispose()
  }
})

test('信任升级：autoUpgrade 打开且连续采纳达标才升到 A2，并通知', async () => {
  const h = await setup({ autoUpgrade: true, upgradeAfter: 2, acceptWindowMinutes: 60, cooldownMinutes: 0 })
  try {
    h.approval.pending = [approvalRequest()]
    await h.autonomy.tick('tick')
    h.ctx.events.emit(EVENTS.inbound, {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    await h.autonomy.tick('tick')
    h.ctx.events.emit(EVENTS.inbound, {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal((await h.autonomy.status()).streak, 2)

    h.approval.pending = []
    await h.autonomy.tick('tick')
    assert.equal((await h.autonomy.status()).mode, 'A2')
    assert.ok(h.channel.sent.some((envelope) => JSON.stringify(envelope.blocks).includes('已升到 A2')))
  } finally {
    await h.dispose()
  }
})

test('信任升级：autoUpgrade 默认关闭时只记账，不改变级别', async () => {
  const h = await setup({ upgradeAfter: 2, acceptWindowMinutes: 60, cooldownMinutes: 0 })
  try {
    h.approval.pending = [approvalRequest()]
    await h.autonomy.tick('tick')
    h.ctx.events.emit(EVENTS.inbound, {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    await h.autonomy.tick('tick')
    h.ctx.events.emit(EVENTS.inbound, {})

    h.approval.pending = []
    await h.autonomy.tick('tick')
    const state = await h.autonomy.status()
    assert.equal(state.mode, 'A1')
    assert.equal(state.streak, 2)
  } finally {
    await h.dispose()
  }
})

test('信任接口：手动切级别、锁死，非法级别 400', async () => {
  const h = await setup({ autoUpgrade: true, upgradeAfter: 1, cooldownMinutes: 0 })
  try {
    const set = await h.call({ method: 'POST', path: '/api/v1/autonomy/trust', query: {}, headers: {}, body: { level: 'A2' } })
    assert.equal(set.status, 200)
    assert.deepEqual(set.body, { ok: true, mode: 'A2', locked: false })

    const listed = await h.call({ method: 'GET', path: '/api/v1/autonomy', query: {}, headers: {} })
    assert.equal((listed.body as { mode: string }).mode, 'A2')
    assert.equal((listed.body as { locked: boolean }).locked, false)

    const lock = await h.call({ method: 'POST', path: '/api/v1/autonomy/trust', query: {}, headers: {}, body: { locked: true } })
    assert.equal(lock.status, 200)
    assert.deepEqual(lock.body, { ok: true, mode: 'A2', locked: true })

    const bad = await h.call({ method: 'POST', path: '/api/v1/autonomy/trust', query: {}, headers: {}, body: { level: 'A9' } })
    assert.equal(bad.status, 400)
    const empty = await h.call({ method: 'POST', path: '/api/v1/autonomy/trust', query: {}, headers: {}, body: {} })
    assert.equal(empty.status, 400)
  } finally {
    await h.dispose()
  }
})

test('锁死后即使 autoUpgrade 打开也不升级', async () => {
  const h = await setup({ autoUpgrade: true, upgradeAfter: 1, acceptWindowMinutes: 60, cooldownMinutes: 0 })
  try {
    await h.call({ method: 'POST', path: '/api/v1/autonomy/trust', query: {}, headers: {}, body: { level: 'A1', locked: true } })
    h.approval.pending = [approvalRequest()]
    await h.autonomy.tick('tick')
    await new Promise((resolve) => setTimeout(resolve, 10))
    h.ctx.events.emit(EVENTS.inbound, {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    h.approval.pending = []
    await h.autonomy.tick('tick')
    const state = await h.autonomy.status()
    assert.equal(state.mode, 'A1')
    assert.equal(state.locked, true)
  } finally {
    await h.dispose()
  }
})

test('摘要：被忽略太多次的规则不再即时打扰，只进摘要队列', async () => {
  const h = await setup({ digestAfter: 2, digestHour: 25 })
  try {
    await h.ctx.store.collection('qm_autonomy_state').insert({
      id: 'state',
      mode: 'A1',
      day: '',
      used: 0,
      last_tick_at: null,
      cooldowns_json: '{}',
      accepted: 0,
      ignored: 0,
      streak: 0,
      pending_json: null,
      ignored_by_rule_json: JSON.stringify({ 'approval.pending': 2 }),
      locked: false,
      digest_json: JSON.stringify({ day: '', items: [] }),
    })

    h.approval.pending = [approvalRequest()]
    const trace = await h.autonomy.tick('tick')
    assert.equal(trace.chosen, null)
    assert.equal(trace.execution, null)
    assert.match(trace.reason, /已降级到摘要/)
    assert.equal(trace.suppressed[0]?.reason, '已降级到摘要')
    assert.equal(h.channel.sent.length, 0, '降级后不应即时发消息')
    assert.equal((await h.autonomy.status()).used, 0, '摘要不消耗即时预算')

    const listed = await h.call({ method: 'GET', path: '/api/v1/autonomy', query: {}, headers: {} })
    assert.equal((listed.body as { digest: { count: number } }).digest.count, 1)
  } finally {
    await h.dispose()
  }
})

test('摘要：手动发送后清空，再发返回 400', async () => {
  const h = await setup({ digestAfter: 2, digestHour: 25 })
  try {
    await h.ctx.store.collection('qm_autonomy_state').insert({
      id: 'state',
      mode: 'A1',
      day: '',
      used: 0,
      last_tick_at: null,
      cooldowns_json: '{}',
      accepted: 0,
      ignored: 0,
      streak: 0,
      pending_json: null,
      ignored_by_rule_json: JSON.stringify({ 'approval.pending': 2 }),
      locked: false,
      digest_json: JSON.stringify({ day: '', items: [] }),
    })
    h.approval.pending = [approvalRequest()]
    await h.autonomy.tick('tick')

    const sent = await h.call({ method: 'POST', path: '/api/v1/autonomy/digest', query: {}, headers: {} })
    assert.equal(sent.status, 200)
    assert.deepEqual(sent.body, { ok: true, sent: 1 })
    assert.match((h.channel.sent.at(-1)!.blocks[0] as { text: string }).text, /📥 今日摘要（1 条）/)

    const again = await h.call({ method: 'POST', path: '/api/v1/autonomy/digest', query: {}, headers: {} })
    assert.equal(again.status, 400)
  } finally {
    await h.dispose()
  }
})

test('摘要：到点自动发一次，同一天不重复', async () => {
  const h = await setup({ digestAfter: 2, digestHour: 0 })
  try {
    await h.ctx.store.collection('qm_autonomy_state').insert({
      id: 'state',
      mode: 'A1',
      day: '',
      used: 0,
      last_tick_at: null,
      cooldowns_json: '{}',
      accepted: 0,
      ignored: 0,
      streak: 0,
      pending_json: null,
      ignored_by_rule_json: JSON.stringify({ 'approval.pending': 2 }),
      locked: false,
      digest_json: JSON.stringify({ day: '', items: [] }),
    })
    h.approval.pending = [approvalRequest()]
    await h.autonomy.tick('tick')
    assert.equal(h.channel.sent.filter((envelope) => JSON.stringify(envelope.blocks).includes('📥')).length, 1)

    await h.autonomy.tick('tick')
    assert.equal(
      h.channel.sent.filter((envelope) => JSON.stringify(envelope.blocks).includes('📥')).length,
      1,
      '每天只发一次',
    )
  } finally {
    await h.dispose()
  }
})

test('A5 投诉：降一级、清空待回应、记录次数；锁定只记录不降', async () => {
  const h = await setup()
  try {
    await h.call({ method: 'POST', path: '/api/v1/autonomy/trust', query: {}, headers: {}, body: { level: 'A2' } })

    const first = await h.call({
      method: 'POST',
      path: '/api/v1/autonomy/complaint',
      query: {},
      headers: {},
      body: { reason: '这条建议没用' },
    })
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { ok: true, before: 'A2', after: 'A1', complaints: 1, locked: false })

    const second = await h.call({ method: 'POST', path: '/api/v1/autonomy/complaint', query: {}, headers: {}, body: {} })
    assert.equal((second.body as { after: string }).after, 'A0')
    const third = await h.call({ method: 'POST', path: '/api/v1/autonomy/complaint', query: {}, headers: {}, body: {} })
    assert.equal((third.body as { after: string }).after, 'A0', 'A0 不再降')

    const listed = await h.call({ method: 'GET', path: '/api/v1/autonomy', query: {}, headers: {} })
    const trust = (listed.body as { trust: { complaints: number } }).trust
    assert.equal(trust.complaints, 3)

    await h.call({ method: 'POST', path: '/api/v1/autonomy/trust', query: {}, headers: {}, body: { level: 'A2', locked: true } })
    const locked = await h.call({ method: 'POST', path: '/api/v1/autonomy/complaint', query: {}, headers: {}, body: {} })
    assert.equal((locked.body as { after: string }).after, 'A2', '锁定时不自动降级')
    assert.equal((locked.body as { locked: boolean }).locked, true)
  } finally {
    await h.dispose()
  }
})

test('A5 回滚：取消派生任务、trace 标 rolled_back、降一级', async () => {
  const h = await setup({ mode: 'A2' })
  try {
    h.task.runs = [taskRun({ id: 'run_failed', status: 'failed', error: '测试挂了', finishedAt: new Date() })]
    const trace = await h.autonomy.tick('tick')
    assert.equal(trace.execution?.status, 'executed')
    assert.equal(trace.execution?.action, 'task.retry')

    const result = await h.autonomy.rollback({ traceId: trace.id, reason: '回滚测试' })
    assert.equal(result.ok, true)
    assert.equal(result.action, 'task.retry')
    assert.equal(result.before, 'A2')
    assert.equal(result.after, 'A1')
    assert.equal(h.taskRunner.cancelled.length, 1, '应取消派生的 run')

    const updated = (await h.autonomy.list()).find((item) => item.id === trace.id)
    assert.equal(updated?.execution?.status, 'rolled_back')
  } finally {
    await h.dispose()
  }
})

test('A5 回滚：没有可回滚动作时返回错误，不改级别', async () => {
  const h = await setup({ mode: 'A2' })
  try {
    const result = await h.autonomy.rollback()
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /没有可回滚/)
    assert.equal(result.before, 'A2')
    assert.equal(result.after, 'A2')
  } finally {
    await h.dispose()
  }
})




