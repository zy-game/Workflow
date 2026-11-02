import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as taskPlugin from '../src/index.ts'
import { EVENTS, type StoreService, type TaskRun, type TaskService } from '@qingmei/core'

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-task-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'task.db') })
  await storeFiber
  const taskFiber = ctx.plugin(taskPlugin)
  await taskFiber
  const task = ctx.reflect.get('task', false) as TaskService | undefined
  assert.ok(task, '应注册 task 服务')

  const events: { type: string; run: TaskRun }[] = []
  ctx.events.on(EVENTS.taskRunStarted, (run: TaskRun) => events.push({ type: 'started', run }))
  ctx.events.on(EVENTS.taskProgress, (run: TaskRun) => events.push({ type: 'progress', run }))
  ctx.events.on(EVENTS.taskFinished, (run: TaskRun) => events.push({ type: 'finished', run }))

  const store = ctx.reflect.get('store', false) as StoreService
  return {
    task,
    events,
    store,
    async dispose() {
      await taskFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(taskPlugin.name, 'provider-task-sqlite')
  assert.deepEqual(taskPlugin.inject, ['store'])
})

test('create：queued 状态、taskId 与 run 目录', async () => {
  const h = await setup()
  try {
    const run = await h.task.create({ prompt: '  把测试跑一遍  ' })
    assert.equal(run.status, 'queued')
    assert.equal(run.prompt, '把测试跑一遍')
    assert.equal(run.taskId, run.id)
    assert.equal(run.harnessId, 'dsh')
    assert.match(run.cwd, /data\/workspaces\/run_/)
    assert.equal(run.progress, null)
    assert.equal(run.startedAt, null)
    assert.ok(run.createdAt instanceof Date)

    await assert.rejects(h.task.create({ prompt: '   ' }), /不能为空/)
  } finally {
    await h.dispose()
  }
})

test('start：进入 running 并只发一次 run-started', async () => {
  const h = await setup()
  try {
    const run = await h.task.create({ prompt: '跑测试' })
    const started = await h.task.start(run.id)
    assert.ok(started)
    assert.equal(started.status, 'running')
    assert.ok(started.startedAt instanceof Date)

    const again = await h.task.start(run.id)
    assert.equal(again?.status, 'running')
    assert.equal(h.events.filter((event) => event.type === 'started').length, 1)

    assert.equal(await h.task.start('run_nope'), null)
  } finally {
    await h.dispose()
  }
})

test('reportProgress：写入最近一条进度并发事件', async () => {
  const h = await setup()
  try {
    const run = await h.task.create({ prompt: '跑测试' })
    await h.task.start(run.id)

    const updated = await h.task.reportProgress(run.id, { phase: '跑测试', percent: 60, note: '3 个用例失败' })
    assert.ok(updated)
    assert.equal(updated.progress?.phase, '跑测试')
    assert.equal(updated.progress?.percent, 60)
    assert.equal(updated.progress?.note, '3 个用例失败')
    assert.ok(updated.progress?.at instanceof Date)
    assert.equal(h.events.filter((event) => event.type === 'progress').length, 1)

    // 第二次覆盖最近一条，不累积
    const second = await h.task.reportProgress(run.id, { phase: '修用例' })
    assert.equal(second?.progress?.phase, '修用例')
    assert.equal(second?.progress?.percent, undefined)

    await assert.rejects(h.task.reportProgress(run.id, { phase: '  ' }), /必须有 phase/)
  } finally {
    await h.dispose()
  }
})

test('start：已在 running 时补记 sessionId', async () => {
  const h = await setup()
  try {
    const run = await h.task.create({ prompt: '跑测试' })
    await h.task.start(run.id)
    assert.equal((await h.task.get(run.id))?.sessionId, null)

    const updated = await h.task.start(run.id, { sessionId: 'sess_1' })
    assert.equal(updated?.sessionId, 'sess_1')
    assert.equal(h.events.filter((event) => event.type === 'started').length, 1, '补记 sessionId 不应重复发 run-started')
  } finally {
    await h.dispose()
  }
})

test('setStatus：running ⇄ needs_approval', async () => {
  const h = await setup()
  try {
    const run = await h.task.create({ prompt: '跑测试' })
    await h.task.start(run.id)

    const waiting = await h.task.setStatus(run.id, 'needs_approval')
    assert.equal(waiting?.status, 'needs_approval')
    const back = await h.task.setStatus(run.id, 'running')
    assert.equal(back?.status, 'running')
  } finally {
    await h.dispose()
  }
})

test('finish：写入结论与时间，重复收尾幂等', async () => {
  const h = await setup()
  try {
    const run = await h.task.create({ prompt: '跑测试' })
    await h.task.start(run.id)

    const done = await h.task.finish(run.id, { status: 'done', result: '全绿' })
    assert.ok(done)
    assert.equal(done.status, 'done')
    assert.equal(done.result, '全绿')
    assert.ok(done.finishedAt instanceof Date)
    assert.equal(h.events.filter((event) => event.type === 'finished').length, 1)

    const again = await h.task.finish(run.id, { status: 'failed', error: '不该覆盖' })
    assert.equal(again?.status, 'done', '已结束的 run 不应被再次收尾覆盖')
    assert.equal(again?.error, null)
    assert.equal(h.events.filter((event) => event.type === 'finished').length, 1)

    // 结束后不再接受进度
    assert.equal(await h.task.reportProgress(run.id, { phase: '迟到的进度' }), null)
  } finally {
    await h.dispose()
  }
})

test('list：按创建时间倒序并受 limit 约束', async () => {
  const h = await setup()
  try {
    const first = await h.task.create({ prompt: '任务一' })
    const second = await h.task.create({ prompt: '任务二' })
    const third = await h.task.create({ prompt: '任务三' })

    const all = await h.task.list()
    assert.deepEqual(
      all.map((run) => run.id),
      [third.id, second.id, first.id],
    )

    const limited = await h.task.list(2)
    assert.equal(limited.length, 2)
    assert.equal(limited[0]!.id, third.id)
  } finally {
    await h.dispose()
  }
})

test('落库在 qm_task_run 集合，列名与 docs/07 §5 的字段对应', async () => {
  const h = await setup()
  try {
    const run = await h.task.create({ prompt: '跑测试' })
    const rows = await h.store.collection<Record<string, unknown>>('qm_task_run').find({})
    assert.equal(rows.length, 1)
    const row = rows[0]!
    assert.equal(row.id, run.id)
    assert.equal(row.task_id, run.id)
    assert.equal(row.harness_id, 'dsh')
    assert.equal(row.status, 'queued')
    assert.equal(row.cwd, run.cwd)
    assert.equal(row.started_at, null)
    assert.equal(row.finished_at, null)
  } finally {
    await h.dispose()
  }
})
