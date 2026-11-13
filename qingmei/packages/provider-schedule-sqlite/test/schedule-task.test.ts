import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as schedulePlugin from '../src/index.ts'

class FakeTask extends Service {
  readonly created: Array<Record<string, unknown>> = []
  readonly enqueued: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'task')
  }
  async create(input: Record<string, unknown>) {
    const run = { id: `run_${this.created.length + 1}`, ...input }
    this.created.push(run)
    return run
  }
  async enqueue(id: string) {
    this.enqueued.push(id)
    return { id, status: 'queued' }
  }
  async finish() {
    return null
  }
}

test('日程 = 带触发时间的任务：创建日程时同时创建 scheduled reminder 任务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-schedule-task-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'schedule.db') })
  await storeFiber
  const taskFiber = ctx.plugin(FakeTask)
  await taskFiber
  const scheduleFiber = ctx.plugin(schedulePlugin, { tickMs: 20 })
  await scheduleFiber
  try {
    const schedule = ctx.get('schedule') as {
      create(input: { text: string; at: Date }): Promise<{ id: string }>
    }
    const at = new Date(Date.now() + 3_600_000)
    await schedule.create({ text: '下午三点开会', at })
    const task = ctx.get('task') as FakeTask
    assert.equal(task.created.length, 1)
    assert.equal(task.created[0].kind, 'reminder')
    assert.equal(task.created[0].status, 'scheduled')
    assert.equal(task.created[0].trigger, 'at')
    assert.equal((task.created[0].schedule as { at: Date }).at.getTime(), at.getTime())
  } finally {
    await scheduleFiber.dispose()
    await taskFiber.dispose()
    await storeFiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('到点后把任务从 scheduled 变 queued，不再直接投递', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-schedule-fire-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'schedule.db') })
  await storeFiber
  const taskFiber = ctx.plugin(FakeTask)
  await taskFiber
  const scheduleFiber = ctx.plugin(schedulePlugin, { tickMs: 20 })
  await scheduleFiber
  try {
    const schedule = ctx.get('schedule') as { create(input: { text: string; at: Date }): Promise<{ id: string }> }
    await schedule.create({ text: '马上提醒', at: new Date(Date.now() + 40) })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const task = ctx.get('task') as FakeTask
    assert.ok(task.enqueued.length >= 1, '到点应把任务入队')
    assert.equal(task.enqueued[0], task.created[0].id)
  } finally {
    await scheduleFiber.dispose()
    await taskFiber.dispose()
    await storeFiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
