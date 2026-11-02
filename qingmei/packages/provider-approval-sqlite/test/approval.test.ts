import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as approvalPlugin from '../src/index.ts'
import { EVENTS, type ApprovalRequest, type ApprovalService } from '@qingmei/core'

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-approval-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'approval.db') })
  await storeFiber
  const approvalFiber = ctx.plugin(approvalPlugin)
  await approvalFiber
  const approval = ctx.reflect.get('approval', false) as ApprovalService | undefined
  assert.ok(approval, '应注册 approval 服务')

  const events: { type: string; request: ApprovalRequest }[] = []
  ctx.events.on(EVENTS.approvalRequested, (request: ApprovalRequest) => events.push({ type: 'requested', request }))
  ctx.events.on(EVENTS.approvalDecided, (request: ApprovalRequest) => events.push({ type: 'decided', request }))

  return {
    approval,
    events,
    async dispose() {
      await approvalFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(approvalPlugin.name, 'provider-approval-sqlite')
  assert.deepEqual(approvalPlugin.inject, ['store'])
})

test('create：落一条 pending 并发 approval/requested', async () => {
  const h = await setup()
  try {
    const request = await h.approval.create({
      action: 'acp:bash: npm test',
      prompt: '子 agent 请求执行：bash: npm test',
      requester: 'harness:dsh',
      runId: 'run_1',
    })
    assert.equal(request.status, 'pending')
    assert.equal(request.action, 'acp:bash: npm test')
    assert.equal(request.runId, 'run_1')
    assert.equal(request.requester, 'harness:dsh')
    assert.equal(request.channel, 'web')
    assert.equal(request.decidedAt, null)
    assert.ok(request.createdAt instanceof Date)
    assert.equal(h.events.filter((event) => event.type === 'requested').length, 1)

    await assert.rejects(h.approval.create({ action: ' ', prompt: 'x' }), /必须有 action/)
    await assert.rejects(h.approval.create({ action: 'a', prompt: ' ' }), /必须有 prompt/)
  } finally {
    await h.dispose()
  }
})

test('decide：批准/拒绝写状态与理由，重复判定不覆盖', async () => {
  const h = await setup()
  try {
    const allowed = await h.approval.create({ action: 'tool.invoke:shell', prompt: '要跑 shell' })
    const decided = await h.approval.decide(allowed.id, { allow: true })
    assert.equal(decided?.status, 'allowed')
    assert.ok(decided?.decidedAt instanceof Date)

    const again = await h.approval.decide(allowed.id, { allow: false, reason: '不该改' })
    assert.equal(again?.status, 'allowed', '已判定的请求不应被覆盖')

    const denied = await h.approval.create({ action: 'tool.invoke:shell', prompt: '再来一次' })
    const rejected = await h.approval.decide(denied.id, { allow: false, reason: '太危险' })
    assert.equal(rejected?.status, 'denied')
    assert.equal(rejected?.reason, '太危险')
    assert.equal(h.events.filter((event) => event.type === 'decided').length, 2)

    assert.equal(await h.approval.decide('ap_nope', { allow: true }), null)
  } finally {
    await h.dispose()
  }
})

test('list：按状态过滤、按时间倒序', async () => {
  const h = await setup()
  try {
    const first = await h.approval.create({ action: 'a', prompt: '第一条' })
    const second = await h.approval.create({ action: 'b', prompt: '第二条' })
    await h.approval.decide(first.id, { allow: true })

    assert.deepEqual(
      (await h.approval.list()).map((request) => request.id),
      [second.id, first.id],
    )
    assert.deepEqual(
      (await h.approval.list('pending')).map((request) => request.id),
      [second.id],
    )
    assert.deepEqual(
      (await h.approval.list('allowed')).map((request) => request.id),
      [first.id],
    )
  } finally {
    await h.dispose()
  }
})

test('wait：判定后返回结果，超时返回 null', async () => {
  const h = await setup()
  try {
    const request = await h.approval.create({ action: 'a', prompt: '等一会儿' })
    setTimeout(() => {
      void h.approval.decide(request.id, { allow: true })
    }, 120)
    const decided = await h.approval.wait(request.id, 2000)
    assert.equal(decided?.status, 'allowed')

    const pending = await h.approval.create({ action: 'b', prompt: '没人理' })
    assert.equal(await h.approval.wait(pending.id, 300), null)
    assert.equal(await h.approval.wait('ap_nope', 100), null)
  } finally {
    await h.dispose()
  }
})
