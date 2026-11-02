import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import {
  AuditService,
  MemoryService,
  PermissionService,
  ScheduleService,
  TaskRunnerService,
  TaskService,
  type AuditEntry,
  type Decision,
  type MemoryRecord,
  type RecallQuery,
  type RecallResult,
  type Scheduled,
  type ScheduleInput,
  type SchedulePatch,
  type TaskRun,
} from '@qingmei/core'
import * as permissionPlugin from '@qingmei/provider-permission-static'
import { createTools, guardToolCall, scheduleInputFrom, type HostTool, type ToolGuard } from '../src/index.ts'

// ────────────────────────────────────────────── 假服务

class FakeMemory extends MemoryService {
  readonly recalled: RecallQuery[] = []
  readonly ingested: MemoryRecord[][] = []
  nextText = '主人喜欢手冲咖啡'

  constructor(ctx: Context) {
    super(ctx)
  }

  async ingest(records: MemoryRecord[]): Promise<{ created: string[]; merged: string[] }> {
    this.ingested.push(records)
    return { created: records.map((_, index) => `m_${index}`), merged: [] }
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    this.recalled.push(query)
    return { facts: [], text: this.nextText }
  }

  async forget(): Promise<number> {
    return 0
  }
}

class FakeSchedule extends ScheduleService {
  readonly created: ScheduleInput[] = []
  readonly cancelled: string[] = []
  readonly paused: string[] = []
  readonly resumed: string[] = []
  readonly updated: { id: string; patch: SchedulePatch }[] = []
  items: Scheduled[] = []
  nextAt = new Date('2026-10-31T01:00:00.000Z')

  constructor(ctx: Context) {
    super(ctx)
  }

  async create(input: ScheduleInput): Promise<Scheduled> {
    this.created.push(input)
    const item: Scheduled = {
      id: `r_${this.created.length}`,
      text: input.text,
      channel: 'web',
      conversationId: 'owner',
      nextAt: this.nextAt,
      everyMs: input.everyMs ?? null,
      cron: input.cron ?? null,
      timezone: input.timezone ?? null,
      missedPolicy: input.missedPolicy ?? 'fire-once',
      pausedAt: null,
      firedAt: null,
    }
    this.items.push(item)
    return item
  }

  async list(): Promise<Scheduled[]> {
    return [...this.items]
  }

  async cancel(id: string): Promise<boolean> {
    const before = this.items.length
    this.items = this.items.filter((item) => item.id !== id)
    if (this.items.length === before) return false
    this.cancelled.push(id)
    return true
  }

  async pause(id: string): Promise<boolean> {
    const item = this.items.find((entry) => entry.id === id)
    if (!item) return false
    item.pausedAt = new Date('2026-10-30T12:00:00.000Z')
    this.paused.push(id)
    return true
  }

  async resume(id: string): Promise<boolean> {
    const item = this.items.find((entry) => entry.id === id)
    if (!item) return false
    item.pausedAt = null
    this.resumed.push(id)
    return true
  }

  async update(id: string, patch: SchedulePatch): Promise<Scheduled | null> {
    const item = this.items.find((entry) => entry.id === id)
    if (!item) return null
    if (patch.text !== undefined) item.text = patch.text
    if (patch.cron !== undefined) {
      item.cron = patch.cron
      item.timezone = patch.timezone ?? item.timezone
      item.everyMs = null
    }
    if (patch.at !== undefined) {
      item.nextAt = patch.at
      item.cron = null
      item.everyMs = null
    }
    if (patch.everyMs !== undefined) {
      item.everyMs = patch.everyMs
      item.cron = null
    }
    this.updated.push({ id, patch })
    return item
  }
}

class FakeRunner extends TaskRunnerService {
  readonly dispatched: string[] = []

  constructor(ctx: Context) {
    super(ctx)
  }

  dispatch(run: TaskRun): void {
    this.dispatched.push(run.id)
  }
}

function setup() {
  const ctx = new Context()
  const memory = new FakeMemory(ctx)
  const schedule = new FakeSchedule(ctx)
  const task = new FakeTask(ctx)
  const runner = new FakeRunner(ctx)
  const tools = createTools({ memory, schedule, task, runner })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = byName.get(name)
    assert.ok(tool, `缺少工具 ${name}`)
    return tool.call(args)
  }
  return { memory, schedule, task, runner, tools, byName, call }
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((block) => block.text).join('\n')
}

// ────────────────────────────────────────────── 假任务账本

class FakeTask extends TaskService {
  readonly runs = new Map<string, TaskRun>()
  readonly finished: { id: string; status: string; result?: string; error?: string }[] = []
  private seq = 0

  constructor(ctx: Context) {
    super(ctx)
  }

  seed(id: string, prompt = '跑测试'): TaskRun {
    const run: TaskRun = {
      id,
      taskId: id,
      title: prompt,
      prompt,
      harnessId: 'dsh',
      sessionId: 'session-1',
      cwd: `/tmp/${id}`,
      status: 'running',
      progress: null,
      result: null,
      error: null,
      createdAt: new Date('2026-10-30T12:00:00.000Z'),
      startedAt: new Date('2026-10-30T12:00:01.000Z'),
      finishedAt: null,
    }
    this.runs.set(id, run)
    return run
  }

  async create(input: { prompt: string; title?: string; cwd?: string }): Promise<TaskRun> {
    const id = `run_create${++this.seq}`
    const run = this.seed(id, input.prompt)
    run.status = 'queued'
    run.startedAt = null
    if (input.title) run.title = input.title
    if (input.cwd) run.cwd = input.cwd
    return run
  }

  async get(id: string): Promise<TaskRun | null> {
    return this.runs.get(id) ?? null
  }

  async list(): Promise<TaskRun[]> {
    return [...this.runs.values()]
  }

  async start(): Promise<TaskRun | null> {
    return null
  }

  async setStatus(): Promise<TaskRun | null> {
    return null
  }

  async reportProgress(
    id: string,
    progress: { phase: string; percent?: number; note?: string },
  ): Promise<TaskRun | null> {
    const run = this.runs.get(id)
    if (!run || run.finishedAt) return null
    run.progress = { ...progress, at: new Date('2026-10-30T12:00:02.000Z') }
    return run
  }

  async finish(
    id: string,
    input: { status: 'done' | 'failed' | 'cancelled'; result?: string; error?: string },
  ): Promise<TaskRun | null> {
    const run = this.runs.get(id)
    if (!run) return null
    if (run.finishedAt) return run
    run.status = input.status
    run.result = input.result ?? run.result
    run.error = input.error ?? run.error
    run.finishedAt = new Date('2026-10-30T12:05:00.000Z')
    this.finished.push({ id, ...input })
    return run
  }
}

// ────────────────────────────────────────────── 鉴权替身

class FakePermission extends PermissionService {
  private readonly decision: Decision

  constructor(ctx: Context, decision: Decision) {
    super(ctx)
    this.decision = decision
  }

  async check(): Promise<Decision> {
    return this.decision
  }

  rules() {
    return []
  }

  addRule(): () => void {
    return () => {}
  }
}

class FakeAudit extends AuditService {
  readonly entries: AuditEntry[] = []

  constructor(ctx: Context) {
    super(ctx)
  }

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry)
  }

  async query(): Promise<AuditEntry[]> {
    return [...this.entries]
  }
}

function guardWith(decision: Decision): { guard: ToolGuard; audit: FakeAudit } {
  const ctx = new Context()
  const audit = new FakeAudit(ctx)
  const guard: ToolGuard = {
    permission: new FakePermission(ctx, decision),
    audit,
    actor: { id: 'owner', displayName: '主人', role: 'owner' },
    channel: 'web',
    conversation: 'dm',
  }
  return { guard, audit }
}

// ────────────────────────────────────────────── 用例

test('注册表覆盖全部工具，且 schema 与 handler 一一对应', () => {
  const { tools } = setup()
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'memory_recall',
      'memory_remember',
      'schedule_create',
      'schedule_cancel',
      'schedule_update',
      'schedule_pause',
      'schedule_resume',
      'qm_dispatch_task',
      'qm_report_progress',
      'qm_finish_task',
      'schedule_list',
    ],
  )
  for (const tool of tools) {
    assert.ok(tool.description.length > 0, `${tool.name} 缺少描述`)
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} 的 schema 必须是 object`)
    assert.equal(typeof tool.call, 'function', `${tool.name} 缺少 handler`)
  }
  // 名字不能重复，否则 tools/call 的查表会静默覆盖
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length)
})

test('memory_recall：透传 query 与 limit，空结果给固定话术', async () => {
  const { memory, call } = setup()
  const result = await call('memory_recall', { query: '喝什么', limit: 3 })
  assert.equal(textOf(result), '主人喜欢手冲咖啡')
  assert.deepEqual(memory.recalled, [{ text: '喝什么', limit: 3 }])

  memory.nextText = ''
  const empty = await call('memory_recall', { query: '不存在' })
  assert.equal(textOf(empty), '没有找到相关记忆。')

  await assert.rejects(call('memory_recall', { query: '   ' }), /query 不能为空/)
})

test('memory_remember：缺字段报错，正常写入一条 fact', async () => {
  const { memory, call } = setup()
  await assert.rejects(call('memory_remember', { subject: '主人' }), /都不能为空/)

  const result = await call('memory_remember', {
    subject: ' 主人 ',
    predicate: '喜欢',
    object: '手冲咖啡',
    confidence: 0.9,
  })
  assert.equal(textOf(result), '已记住')
  assert.equal(memory.ingested.length, 1)
  assert.deepEqual(memory.ingested[0]![0], {
    kind: 'fact',
    subject: '主人',
    predicate: '喜欢',
    object: '手冲咖啡',
    confidence: 0.9,
    sensitivity: 'private',
    origin: { kind: 'harness', id: 'mcp' },
  })
})

test('schedule_create：cron 走周期路径，返回带规则与下次时间', async () => {
  const { schedule, call } = setup()
  const result = await call('schedule_create', {
    text: '每天九点提醒我吃药',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
  })
  assert.match(textOf(result), /每次 0 9 \* \* \*（Asia\/Shanghai）/)
  assert.match(textOf(result), /2026-10-31T01:00:00\.000Z/)
  assert.deepEqual(schedule.created[0], {
    text: '每天九点提醒我吃药',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
  })
})

test('schedule_create：缺 text 报错', async () => {
  const { call } = setup()
  await assert.rejects(call('schedule_create', { cron: '0 9 * * *' }), /text 不能为空/)
})

test('schedule_cancel：命中与未命中两种话术', async () => {
  const { schedule, call } = setup()
  await call('schedule_create', { text: '喝水', cron: '0 9 * * *' })
  const id = schedule.items[0]!.id

  assert.equal(textOf(await call('schedule_cancel', { id })), '已取消')
  assert.deepEqual(schedule.cancelled, [id])
  assert.equal(textOf(await call('schedule_cancel', { id })), '没有找到这条提醒')
})

test('schedule_update：只改文本，或整体替换规则', async () => {
  const { schedule, call } = setup()
  await call('schedule_create', { text: '喝水', cron: '0 9 * * *', timezone: 'Asia/Shanghai' })
  const id = schedule.items[0]!.id

  const renamed = await call('schedule_update', { id, text: '喝一大杯水' })
  assert.match(textOf(renamed), /喝一大杯水/)
  assert.deepEqual(schedule.updated[0]!.patch, { text: '喝一大杯水' })

  const reruled = await call('schedule_update', { id, cron: '30 7 * * *', timezone: 'Asia/Shanghai' })
  assert.match(textOf(reruled), /每次 30 7 \* \* \*/)
  assert.deepEqual(schedule.updated[1]!.patch, { cron: '30 7 * * *', timezone: 'Asia/Shanghai' })

  await assert.rejects(call('schedule_update', { id }), /没有可修改的字段/)
  await assert.rejects(call('schedule_update', { id: 'r_nope', text: 'x' }), /不存在或已经结束/)
})

test('schedule_pause / schedule_resume：命中与未命中两种话术', async () => {
  const { schedule, call } = setup()
  await call('schedule_create', { text: '喝水', cron: '0 9 * * *' })
  const id = schedule.items[0]!.id

  assert.equal(textOf(await call('schedule_pause', { id })), '已暂停')
  assert.deepEqual(schedule.paused, [id])
  assert.match(textOf(await call('schedule_list')), /（已暂停）/)

  assert.equal(textOf(await call('schedule_resume', { id })), '已继续')
  assert.deepEqual(schedule.resumed, [id])
  assert.doesNotMatch(textOf(await call('schedule_list')), /（已暂停）/)

  assert.equal(textOf(await call('schedule_pause', { id: 'r_nope' })), '没有找到这条提醒')
  assert.equal(textOf(await call('schedule_resume', { id: 'r_nope' })), '这条提醒不存在或已经结束')
})

test('schedule_list：列出待触发项并带 id 与规则', async () => {
  const { schedule, call } = setup()
  await call('schedule_create', { text: '喝水', cron: '0 9 * * *', timezone: 'Asia/Shanghai' })
  const listed = textOf(await call('schedule_list'))
  assert.match(listed, new RegExp(`\\[${schedule.items[0]!.id}\\]`))
  assert.match(listed, /每次 0 9 \* \* \*（Asia\/Shanghai）/)
  assert.match(listed, /喝水/)

  // 已触发的行不出现在列表里
  schedule.items = schedule.items.map((item) => ({ ...item, firedAt: new Date() }))
  assert.equal(textOf(await call('schedule_list')), '没有待触发的提醒。')
})

test('scheduleInputFrom：cron > at > seconds，秒级请求是一次性的', () => {
  const cron = scheduleInputFrom('x', { cron: '0 9 * * *', at: '2026-01-01T00:00:00Z', seconds: 30 })
  assert.equal(cron.cron, '0 9 * * *')
  assert.equal(cron.at, undefined)
  assert.equal(cron.everyMs, undefined)

  const at = scheduleInputFrom('x', { at: '2026-03-02T01:00:00.000Z' })
  assert.equal(at.at?.toISOString(), '2026-03-02T01:00:00.000Z')

  const before = Date.now()
  const seconds = scheduleInputFrom('x', { seconds: 300 })
  assert.equal(seconds.everyMs, undefined)
  assert.ok((seconds.at?.getTime() ?? 0) >= before + 300_000)

  const fallback = scheduleInputFrom('x', { seconds: 'abc' })
  assert.ok((fallback.at?.getTime() ?? 0) >= before + 60_000)
})

test('qm_dispatch_task：建 run 并交给 runner，空 prompt 报错', async () => {
  const { task, runner, call } = setup()
  const result = await call('qm_dispatch_task', { prompt: '把测试跑一遍', title: '跑测试' })

  assert.match(textOf(result), /已派出：run_create1「跑测试」/)
  const run = task.runs.get('run_create1')!
  assert.equal(run.prompt, '把测试跑一遍')
  assert.equal(run.status, 'queued')
  assert.deepEqual(runner.dispatched, ['run_create1'])

  await assert.rejects(call('qm_dispatch_task', { prompt: '   ' }), /prompt 不能为空/)
})

test('qm_report_progress：写进账本；未知或已结束的 run 报错', async () => {
  const { task, call } = setup()
  task.seed('run_1')

  const result = await call('qm_report_progress', { runId: 'run_1', phase: '跑测试', percent: 60, note: '3 个用例失败' })
  assert.equal(textOf(result), '已记录进度：跑测试')
  assert.deepEqual(task.runs.get('run_1')?.progress, {
    phase: '跑测试',
    percent: 60,
    note: '3 个用例失败',
    at: new Date('2026-10-30T12:00:02.000Z'),
  })

  await assert.rejects(call('qm_report_progress', { runId: 'run_nope', phase: '跑测试' }), /没有这个任务/)
  await assert.rejects(call('qm_report_progress', { runId: 'run_1', phase: '  ' }), /phase 不能为空/)
  await assert.rejects(call('qm_report_progress', { runId: '  ', phase: '跑测试' }), /runId 不能为空/)
})

test('qm_finish_task：收尾并写入结构化记忆', async () => {
  const { task, memory, call } = setup()
  task.seed('run_1')

  const result = await call('qm_finish_task', {
    runId: 'run_1',
    status: 'done',
    summary: '测试全绿，顺手修了一个用例',
    memory: [{ subject: '项目:青梅', predicate: '测试状态', object: '全绿' }],
  })

  assert.match(textOf(result), /已收尾：done，写入 1 条记忆/)
  assert.deepEqual(task.finished, [{ id: 'run_1', status: 'done', result: '测试全绿，顺手修了一个用例' }])
  assert.equal(memory.ingested.length, 1)
  const record = memory.ingested[0]![0]!
  assert.equal(record.origin.kind, 'harness')
  assert.equal(record.origin.id, 'task:run_1')
  assert.equal(record.subject, '项目:青梅')
})

test('qm_finish_task：failed 记 error；空记忆条目被丢掉', async () => {
  const { task, memory, call } = setup()
  task.seed('run_1')

  const result = await call('qm_finish_task', {
    runId: 'run_1',
    status: 'failed',
    summary: '磁盘满了',
    memory: [{ subject: '只有主语' }],
  })

  assert.match(textOf(result), /已收尾：failed/)
  assert.deepEqual(task.finished, [{ id: 'run_1', status: 'failed', error: '磁盘满了' }])
  assert.equal(memory.ingested.length, 0)

  await assert.rejects(call('qm_finish_task', { runId: 'run_nope' }), /没有这个任务/)
})

test('工具定义是纯数据，handler 只通过依赖访问服务', async () => {
  const ctx = new Context()
  const memory = new FakeMemory(ctx)
  const schedule = new FakeSchedule(ctx)
  const task = new FakeTask(ctx)
  const runner = new FakeRunner(ctx)
  const tools: HostTool[] = createTools({ memory, schedule, task, runner })
  // 同一份定义可以重复创建（没有模块级可变状态）
  const again = createTools({ memory, schedule, task, runner })
  assert.notEqual(tools[0], again[0])
  assert.deepEqual(
    tools.map((tool) => tool.name),
    again.map((tool) => tool.name),
  )
})

// ────────────────────────────────────────────── 准入与审计

test('guardToolCall：放行时留一条 allow 审计', async () => {
  const { guard, audit } = guardWith({ effect: 'allow' })
  await guardToolCall(guard, 'schedule_create')

  assert.equal(audit.entries.length, 1)
  const entry = audit.entries[0]!
  assert.equal(entry.action, 'tool.invoke:schedule_create')
  assert.equal(entry.target, 'schedule_create')
  assert.equal(entry.actorId, 'owner')
  assert.equal(entry.channel, 'web')
  assert.equal(entry.decision, 'allow')
  assert.equal(entry.detail, undefined)
  assert.match(entry.traceId, /^trace_/)
})

test('guardToolCall：拒绝时抛可读原因，并留一条 deny 审计', async () => {
  const { guard, audit } = guardWith({ effect: 'deny', reason: '群聊里不能读或改你的日程' })

  await assert.rejects(guardToolCall(guard, 'schedule_list'), /被拒绝：群聊里不能读或改你的日程/)
  assert.equal(audit.entries.length, 1)
  assert.equal(audit.entries[0]!.decision, 'deny')
  assert.deepEqual(audit.entries[0]!.detail, { effect: 'deny', reason: '群聊里不能读或改你的日程' })
})

test('guardToolCall：需要确认时按拒绝处理，审计里记下 effect=ask', async () => {
  const { guard, audit } = guardWith({ effect: 'ask', prompt: '执行 shell 前需要主人确认' })

  await assert.rejects(guardToolCall(guard, 'shell'), /需要主人确认：执行 shell 前需要主人确认/)
  assert.equal(audit.entries[0]!.decision, undefined)
  assert.deepEqual(audit.entries[0]!.detail, { effect: 'ask', reason: '执行 shell 前需要主人确认' })
})

test('当前全部工具在私聊里都能通过真实策略（新增工具忘了登记会在这里挂）', async () => {
  const { tools } = setup()
  const ctx = new Context()
  await ctx.plugin(permissionPlugin)
  const permission = ctx.reflect.get('permission', false) as PermissionService

  for (const tool of tools) {
    const decision = await permission.check({
      actor: { id: 'owner', displayName: '主人', role: 'owner' },
      channel: 'web',
      conversation: 'dm',
      action: `tool.invoke:${tool.name}`,
      resource: tool.name,
    })
    assert.equal(decision.effect, 'allow', `${tool.name} 没在权限策略里登记，私聊也会被默认拒绝`)
  }
})
