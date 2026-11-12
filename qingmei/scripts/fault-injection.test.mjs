/**
 * 故障注入：坏环境下系统怎么表现。
 *
 * 覆盖 P0 里能在单进程内复现的四种：
 *   1. SQLite 被别的连接锁住 → 写操作显式失败，解锁后恢复；
 *   2. 进程重启 → 待审批仍在，重启后可以继续决定；
 *   3. 设备失联被租约收尾后，迟到的 finish 不会把 failed 复活；
 *   4. 进程重启时设备任务保持 running（等租约），不被误判失败。
 *
 * 真起进程才能验证的（DSH 子进程崩溃、端口冲突）留给 smoke 与部署后 healthz。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from 'cordis'
import * as storePlugin from '../packages/provider-store-sqlite/src/index.ts'
import * as gatewayPlugin from '../packages/service-gateway/src/index.ts'
import * as channelPlugin from '../packages/service-channel/src/index.ts'
import * as approvalPlugin from '../packages/qm-approval/src/index.ts'
import * as taskPlugin from '../packages/qm-task/src/index.ts'

async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-faults-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('SQLite 被锁：写操作快速失败并给出原因，解锁后恢复', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'qm.db')
    const ctx = new Context()
    const storeFiber = ctx.plugin(storePlugin, { path: dbPath })
    await storeFiber
    await ctx.store.ready()
    const collection = ctx.store.collection('qm_fault_probe')
    await collection.insert({ id: 'before', value: 1 })

    const locker = new DatabaseSync(dbPath)
    locker.exec('BEGIN IMMEDIATE')
    try {
      const started = Date.now()
      await assert.rejects(() => collection.insert({ id: 'locked', value: 2 }), /busy|locked/i)
      assert.ok(Date.now() - started < 3_000, '锁冲突不能把请求挂住：要快速失败')
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }

    await collection.insert({ id: 'after', value: 3 })
    assert.equal(await collection.count(), 2, '解锁后写操作要能继续')
    await storeFiber.dispose()
  })
})

test('进程重启：待审批不丢，重启后仍可决定', async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, 'qm.db')
    const boot = async (ctx) => {
      const storeFiber = ctx.plugin(storePlugin, { path: dbPath })
      await storeFiber
      const gatewayFiber = ctx.plugin(gatewayPlugin)
      await gatewayFiber
      const channelFiber = ctx.plugin(channelPlugin)
      await channelFiber
      const approvalFiber = ctx.plugin(approvalPlugin, {})
      await approvalFiber
      return { storeFiber, gatewayFiber, channelFiber, approvalFiber }
    }

    const ctx1 = new Context()
    const first = await boot(ctx1)
    const created = await ctx1.approval.create({ action: 'acp:写文件', prompt: '允许写 notes.txt？', requester: 'test' })
    await first.approvalFiber.dispose()
    await first.channelFiber.dispose()
    await first.gatewayFiber.dispose()
    await first.storeFiber.dispose()

    const ctx2 = new Context()
    const second = await boot(ctx2)
    try {
      const pending = await ctx2.approval.list('pending')
      assert.ok(pending.some((item) => item.id === created.id), '重启后待审批应该还在')

      const decided = await ctx2.approval.decide(created.id, { allow: true })
      assert.equal(decided?.status, 'allowed')
      assert.equal((await ctx2.approval.get(created.id))?.status, 'allowed')
    } finally {
      await second.approvalFiber.dispose()
      await second.channelFiber.dispose()
      await second.gatewayFiber.dispose()
      await second.storeFiber.dispose()
    }
  })
})

async function bootTask(dir, config = {}) {
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'qm.db') })
  await storeFiber
  const gatewayFiber = ctx.plugin(gatewayPlugin)
  await gatewayFiber
  const taskFiber = ctx.plugin(taskPlugin, { startPaused: true, timeoutMs: 3_000, ...config })
  await taskFiber
  return { ctx, storeFiber, gatewayFiber, taskFiber }
}

test('设备失联：租约收尾为 failed 后，迟到的 finish 不会复活', async () => {
  await withTempDir(async (dir) => {
    const { ctx, storeFiber, gatewayFiber, taskFiber } = await bootTask(dir, { leaseTimeoutMs: 1_000 })
    try {
      const run = await ctx.task.create({ prompt: '设备任务', target: { executorId: 'device:dev-1' } })
      await ctx.task.start(run.id)
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      await ctx.taskRunner.sweepExpired()

      const expired = await ctx.task.get(run.id)
      assert.equal(expired?.status, 'failed')
      assert.match(expired?.error ?? '', /设备失联/)

      // 设备恢复后迟到的结果：账本已收尾，finish 幂等，不能把 failed 改成 done
      await ctx.task.finish(run.id, { status: 'done', result: '迟到的结果' })
      const after = await ctx.task.get(run.id)
      assert.equal(after?.status, 'failed')
      assert.equal(after?.result, null)
    } finally {
      await taskFiber.dispose()
      await gatewayFiber.dispose()
      await storeFiber.dispose()
    }
  })
})

test('进程重启：设备任务保持 running 等租约，不被直接判死', async () => {
  await withTempDir(async (dir) => {
    const { ctx, storeFiber, gatewayFiber, taskFiber } = await bootTask(dir, { leaseTimeoutMs: 60_000 })
    try {
      const run = await ctx.task.create({ prompt: '设备任务', target: { executorId: 'device:dev-2' } })
      await ctx.task.start(run.id)
      await ctx.taskRunner.resumeOnRestart()
      const after = await ctx.task.get(run.id)
      assert.equal(after?.status, 'running', '设备任务在设备侧可能还在跑，重启不能直接标 failed')
    } finally {
      await taskFiber.dispose()
      await gatewayFiber.dispose()
      await storeFiber.dispose()
    }
  })
})
