import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as plannerPlugin from '../src/index.ts'
import { parsePlan } from '../src/index.ts'
import { EVENTS } from '@qingmei/core'

function tempDb() {
  return join(mkdtempSync(join(tmpdir(), 'qm-planner-')), 'planner.db')
}

class FakeTask extends Service {
  readonly created: Array<Record<string, unknown>> = []
  readonly done = new Set<string>()
  constructor(ctx: Context) {
    super(ctx, 'task')
  }
  async create(input: Record<string, unknown>) {
    const run = { id: `run_${this.created.length + 1}`, status: 'queued', createdAt: new Date(), ...input }
    this.created.push(run)
    return run
  }
  async get(id: string) {
    const run = this.created.find((item) => item.id === id)
    if (!run) return null
    return { ...run, status: this.done.has(id) ? 'done' : 'queued' }
  }
  async list() {
    return [...this.created].slice(-10).reverse()
  }
}

class FakeHarness extends Service {
  reply = '{"nextTask":null,"reminder":null,"research":null,"skip":"无事"}'
  readonly prompts: string[] = []
  readonly conversations: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'harness')
  }
  async available() {
    return true
  }
  async *run(req: { text: string; conversationId?: string }) {
    this.prompts.push(req.text)
    this.conversations.push(String(req.conversationId ?? ''))
    yield { type: 'text', text: this.reply }
    yield { type: 'done' }
  }
  async close() {}
}

class FakeGateway extends Service {
  readonly routes: string[] = []
  constructor(ctx: Context) { super(ctx, 'gateway') }
  route(options: { path: string }) {
    this.routes.push(options.path)
    return () => undefined
  }
  publish() {}
}

class FakeApproval extends Service {
  readonly created: Array<{ id: string; action: string; prompt: string; status: string }> = []
  constructor(ctx: Context) { super(ctx, 'approval') }
  async create(input: { action: string; prompt: string }) {
    const request = { id: `ap_${this.created.length + 1}`, action: input.action, prompt: input.prompt, status: 'pending' }
    this.created.push(request)
    return request
  }
  async get(id: string) {
    return this.created.find((item) => item.id === id) ?? null
  }
  async list() {
    return this.created
  }
  async decide(id: string, input: { allow: boolean }) {
    const row = this.created.find((item) => item.id === id)
    if (!row) return null
    row.status = input.allow ? 'allowed' : 'denied'
    return row
  }
  async wait() {
    return null
  }
}

class FakeChannel extends Service {
  readonly sent: Array<{ channel: string; conversationId: string; text: string }> = []
  constructor(ctx: Context) {
    super(ctx, 'channel')
  }
  async send(envelope: { channel: string; conversationId: string; blocks: Array<{ type: string; text?: string }> }) {
    this.sent.push({
      channel: envelope.channel,
      conversationId: envelope.conversationId,
      text: envelope.blocks.map((block) => block.text ?? '').join(''),
    })
    return { ok: true }
  }
}

function makeRun(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `任务 ${id}`,
    prompt: '做点事',
    project: null,
    kind: 'task',
    priority: 5,
    dependsOn: [],
    retryOf: null,
    status: 'done',
    createdAt: new Date(),
    result: '完成',
    ...overrides,
  } as never
}

async function boot(overrides: Record<string, unknown> = {}) {
  const db = tempDb()
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: db })
  await storeFiber
  const taskFiber = ctx.plugin(FakeTask)
  const harnessFiber = ctx.plugin(FakeHarness)
  const gatewayFiber = ctx.plugin(FakeGateway)
  const approvalFiber = ctx.plugin(FakeApproval)
  const channelFiber = ctx.plugin(FakeChannel)
  const plannerFiber = ctx.plugin(plannerPlugin, {
    enabled: true,
    cooldownMinutes: 0,
    taskCooldownMinutes: 0,
    maxSelfTasksPerDay: 3,
    maxDepth: 1,
    ...overrides,
  })
  await Promise.all([taskFiber, harnessFiber, gatewayFiber, approvalFiber, channelFiber, plannerFiber])
  return {
    ctx,
    db,
    task: ctx.reflect.get('task', false) as FakeTask,
    harness: ctx.reflect.get('harness', false) as FakeHarness,
    channel: ctx.reflect.get('channel', false) as FakeChannel,
    approval: ctx.reflect.get('approval', false) as FakeApproval,
    planner: ctx.get('planner') as {
      replan: (run: never, options?: { trigger?: string; manual?: boolean }) => Promise<string>
      stats: (days?: number) => Promise<{ tasksCreated: number; tasksDone: number; acceptance: number; skips: number }>
      createGoal: (input: { title: string; why?: string; nextStep?: string }) => Promise<{ id: string; title: string }>
      listGoals: () => Promise<Array<{ id: string; title: string }>>
    },
    async dispose() {
      await plannerFiber.dispose()
      await channelFiber.dispose()
      await gatewayFiber.dispose()
      await approvalFiber.dispose()
      await harnessFiber.dispose()
      await taskFiber.dispose()
      await storeFiber.dispose()
      rmSync(join(db, '..'), { recursive: true, force: true })
    },
  }
}

test('parsePlan：容忍代码块与前后废话，坏 JSON 返回 null', () => {
  const plan = parsePlan('好的\n```json\n{"nextTask":{"prompt":"查日志","title":"查日志"},"skip":null}\n```')
  assert.equal(plan?.nextTask?.title, '查日志')
  assert.equal(parsePlan('没有 JSON'), null)
  assert.equal(parsePlan('{"nextTask":'), null)
})

test('replan：产出后续任务并记账，重复标题去重，日限生效', async () => {
  const h = await boot({ maxSelfTasksPerDay: 2 })
  try {
    h.harness.reply = JSON.stringify({
      nextTask: { prompt: '检查失败原因', title: '检查失败原因', why: '刚失败', evidence: ['run_1'] },
      reminder: null,
      research: null,
      skip: null,
    })
    const first = await h.planner.replan(makeRun('run_1'), { trigger: 'task-finished' })
    assert.equal(first, 'task')
    assert.equal(h.task.created.length, 1)
    assert.equal(h.task.created[0].title, '检查失败原因')

    const duplicate = await h.planner.replan(makeRun('run_2'), { trigger: 'task-finished' })
    assert.equal(duplicate, 'skip', '24 小时内同标题不再建')

    h.harness.reply = JSON.stringify({
      nextTask: { prompt: '另一件事', title: '另一件事' },
      reminder: null,
      research: null,
      skip: null,
    })
    const second = await h.planner.replan(makeRun('run_3'), { trigger: 'task-finished' })
    assert.equal(second, 'task')
    const third = await h.planner.replan(makeRun('run_4'), { trigger: 'task-finished' })
    assert.equal(third, 'skip', '日限 2 后不再建任务')

    const stats = await h.planner.stats(7)
    assert.equal(stats.tasksCreated, 2)
  } finally {
    await h.dispose()
  }
})

test('replan：深度到顶后只提醒，不再建任务', async () => {
  const h = await boot()
  try {
    h.harness.reply = JSON.stringify({
      nextTask: { prompt: '跟进', title: '跟进' },
      reminder: null,
      research: null,
      skip: null,
    })
    assert.equal(await h.planner.replan(makeRun('run_root')), 'task')
    const created = h.task.created[0]

    h.harness.reply = JSON.stringify({
      nextTask: { prompt: '继续跟进', title: '继续跟进' },
      reminder: { text: '三国那边有结论了，要不要看一下？', why: '刚完成检查' },
      research: null,
      skip: null,
    })
    const action = await h.planner.replan(makeRun(String(created.id)), { trigger: 'task-finished' })
    assert.equal(action, 'remind')
    assert.equal(h.task.created.length, 1, '深度 1 的自建任务不再建任务')
    assert.equal(h.channel.sent.length, 1)
    assert.match(h.channel.sent[0].text, /三国/)
  } finally {
    await h.dispose()
  }
})

test('目标账本：创建/列出/更新', async () => {
  const h = await boot()
  try {
    const goal = await h.planner.createGoal({ title: '重构记忆', why: '召回不稳', nextStep: '先跑评估' })
    assert.equal(goal.title, '重构记忆')
    const list = await h.planner.listGoals()
    assert.equal(list.length, 1)
  } finally {
    await h.dispose()
  }
})



test('研究申请：先走审批，批准后才建任务', async () => {
  const h = await boot()
  try {
    h.harness.reply = JSON.stringify({
      nextTask: null,
      reminder: null,
      research: { topic: 'Unity 射线检测常见坑', why: '同类问题反复出现', minutes: 10 },
      skip: null,
    })
    assert.equal(await h.planner.replan(makeRun('run_r')), 'research')
    assert.equal(h.approval.created.length, 1)
    assert.match(h.approval.created[0].prompt, /Unity 射线检测/)
    assert.equal(h.task.created.length, 0, '审批前不建任务')

    await h.approval.decide(h.approval.created[0].id, { allow: true })
    const request = { ...h.approval.created[0], status: 'allowed' }
    h.ctx.events.emit(EVENTS.approvalDecided, request)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(h.task.created.length, 1)
    assert.match(String(h.task.created[0].title), /资料研究/)
  } finally {
    await h.dispose()
  }
})


test('task-finished 用短冷却：定时冷却 60 分钟不挡任务完成触发的规划', async () => {
  const h = await boot({ cooldownMinutes: 60, taskCooldownMinutes: 0 })
  try {
    h.harness.reply = JSON.stringify({ nextTask: null, reminder: null, research: null, skip: '无事' })
    assert.equal(await h.planner.replan(makeRun('run_a'), { trigger: 'task-finished' }), 'skip')
    assert.equal(await h.planner.replan(makeRun('run_b'), { trigger: 'task-finished' }), 'skip')
    assert.ok(h.harness.prompts.length >= 2, '任务完成触发的第二次规划不应被 60 分钟冷却挡住')
  } finally {
    await h.dispose()
  }
})


test('单脑：规划复用 owner 会话，不再单开 planner 会话', async () => {
  const h = await boot()
  try {
    h.harness.reply = JSON.stringify({ nextTask: null, reminder: null, research: null, skip: '无事' })
    await h.planner.replan(makeRun('run_single'))
    assert.deepEqual(h.harness.conversations, ['s_owner'])
  } finally {
    await h.dispose()
  }
})
