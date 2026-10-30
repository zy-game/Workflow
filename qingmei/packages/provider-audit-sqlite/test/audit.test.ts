import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as auditPlugin from '../src/index.ts'
import type { AuditService, StoreService } from '@qingmei/core'

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-audit-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'audit.db') })
  await storeFiber
  const auditFiber = ctx.plugin(auditPlugin)
  await auditFiber
  const audit = ctx.reflect.get('audit', false) as AuditService | undefined
  assert.ok(audit, '应注册 audit 服务')
  const store = ctx.reflect.get('store', false) as StoreService
  return {
    audit,
    store,
    async dispose() {
      await auditFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function entry(overrides: Partial<Parameters<AuditService['append']>[0]> = {}) {
  return {
    at: new Date('2026-10-30T12:00:00.000Z'),
    actorId: 'owner',
    channel: 'web' as const,
    action: 'tool.invoke:schedule_create',
    target: 'schedule_create',
    decision: 'allow' as const,
    traceId: 'trace_1',
    ...overrides,
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(auditPlugin.name, 'provider-audit-sqlite')
  assert.deepEqual(auditPlugin.inject, ['store'])
})

test('append 落库，query 按时间倒序返回', async () => {
  const h = await setup()
  try {
    await h.audit.append(entry({ at: new Date('2026-10-30T12:00:00.000Z'), traceId: 'a' }))
    await h.audit.append(entry({ at: new Date('2026-10-30T12:00:02.000Z'), traceId: 'b' }))
    await h.audit.append(entry({ at: new Date('2026-10-30T12:00:01.000Z'), traceId: 'c' }))

    const rows = await h.audit.query({})
    assert.deepEqual(
      rows.map((row) => row.traceId),
      ['b', 'c', 'a'],
    )
    assert.equal(rows[0]!.action, 'tool.invoke:schedule_create')
    assert.equal(rows[0]!.actorId, 'owner')
    assert.equal(rows[0]!.decision, 'allow')
    assert.ok(rows[0]!.at instanceof Date)
  } finally {
    await h.dispose()
  }
})

test('query 支持 since / actorId / action / limit 过滤', async () => {
  const h = await setup()
  try {
    await h.audit.append(entry({ at: new Date('2026-10-30T10:00:00.000Z'), traceId: 'old' }))
    await h.audit.append(entry({ at: new Date('2026-10-30T12:00:00.000Z'), traceId: 'new' }))
    await h.audit.append(
      entry({
        at: new Date('2026-10-30T12:00:01.000Z'),
        traceId: 'guest',
        actorId: 'guest',
        action: 'tool.invoke:memory_recall',
        decision: 'deny',
      }),
    )

    const since = await h.audit.query({ since: new Date('2026-10-30T11:00:00.000Z') })
    assert.deepEqual(since.map((row) => row.traceId), ['guest', 'new'])

    const byActor = await h.audit.query({ actorId: 'guest' })
    assert.deepEqual(byActor.map((row) => row.traceId), ['guest'])

    const byAction = await h.audit.query({ action: 'tool.invoke:memory_recall' })
    assert.deepEqual(byAction.map((row) => row.traceId), ['guest'])

    const limited = await h.audit.query({ limit: 1 })
    assert.deepEqual(limited.map((row) => row.traceId), ['guest'])
  } finally {
    await h.dispose()
  }
})

test('detail 原样往返（提醒：只放已脱敏摘要）', async () => {
  const h = await setup()
  try {
    await h.audit.append(entry({ detail: { effect: 'deny', reason: '群聊里不能读或改你的日程' } }))
    const [row] = await h.audit.query({})
    assert.deepEqual(row?.detail, { effect: 'deny', reason: '群聊里不能读或改你的日程' })
  } finally {
    await h.dispose()
  }
})

test('审计是只追加的：服务上没有 update / delete', async () => {
  const h = await setup()
  try {
    const exposed = h.audit as unknown as Record<string, unknown>
    assert.equal(exposed.update, undefined)
    assert.equal(exposed.delete, undefined)
  } finally {
    await h.dispose()
  }
})

test('数据落在 qm_audit 集合，字段按 docs/04 的列名', async () => {
  const h = await setup()
  try {
    await h.audit.append(entry({ detail: { effect: 'allow' } }))
    const rows = await h.store.collection<Record<string, unknown>>('qm_audit').find({})
    assert.equal(rows.length, 1)
    const row = rows[0]!
    assert.equal(typeof row.at, 'number')
    assert.equal(row.actor_id, 'owner')
    assert.equal(row.channel, 'web')
    assert.equal(row.action, 'tool.invoke:schedule_create')
    assert.equal(row.target, 'schedule_create')
    assert.equal(row.decision, 'allow')
    assert.equal(JSON.parse(String(row.detail_json)).effect, 'allow')
    assert.equal(row.trace_id, 'trace_1')
  } finally {
    await h.dispose()
  }
})
