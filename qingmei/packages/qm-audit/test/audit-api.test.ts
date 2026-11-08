import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as auditApi from '../src/index.ts'
import {
  EVENTS,
  type AuditEntry,
  type AuditService,
  type GatewayRequest,
  type GatewayResponse,
} from '@qingmei/core'

function fakeResponse() {
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

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-audit-api-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'audit.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const apiFiber = ctx.plugin(auditApi)
  await apiFiber
  const audit = ctx.reflect.get('audit', false) as AuditService

  return {
    audit,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await apiFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function request(query: Record<string, string> = {}): GatewayRequest {
  return { method: 'GET', path: '/api/v1/audit', query, headers: {} }
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    at: new Date(),
    actorId: 'owner',
    channel: 'web',
    action: 'tool.invoke:schedule_list',
    target: 'schedule_list',
    decision: 'allow',
    traceId: 'trace_1',
    ...overrides,
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(auditApi.name, 'qm-audit')
  assert.deepEqual(auditApi.inject, ['store', 'gateway'])
})

test('GET /api/v1/audit：按时间倒序返回，支持 limit', async () => {
  const h = await setup()
  try {
    await h.audit.append(entry({ at: new Date('2026-11-02T02:00:00Z') }))
    await h.audit.append(entry({ at: new Date('2026-11-02T03:00:00Z'), action: 'tool.invoke:shell' }))

    const res = await h.call(request())
    assert.equal(res.status, 200)
    const items = (res.body as { items: AuditEntry[] }).items
    assert.equal(items.length, 2)
    assert.equal(items[0]!.action, 'tool.invoke:shell', '新的在前')

    const limited = await h.call(request({ limit: '1' }))
    assert.equal((limited.body as { items: AuditEntry[] }).items.length, 1)
  } finally {
    await h.dispose()
  }
})

test('GET /api/v1/audit：decision / action / actor 过滤', async () => {
  const h = await setup()
  try {
    await h.audit.append(entry({ decision: 'allow', action: 'tool.invoke:a' }))
    await h.audit.append(entry({ decision: 'deny', action: 'tool.invoke:b' }))
    await h.audit.append(entry({ decision: 'deny', action: 'tool.invoke:a', actorId: 'guest' }))

    const denied = await h.call(request({ decision: 'deny' }))
    assert.deepEqual(
      (denied.body as { items: AuditEntry[] }).items.map((item) => item.decision),
      ['deny', 'deny'],
    )

    const action = await h.call(request({ action: 'tool.invoke:a' }))
    assert.equal((action.body as { items: AuditEntry[] }).items.length, 2)

    const actor = await h.call(request({ actor: 'guest' }))
    assert.equal((actor.body as { items: AuditEntry[] }).items.length, 1)
  } finally {
    await h.dispose()
  }
})

test('GET /api/v1/audit：非法 decision / since 返回 400', async () => {
  const h = await setup()
  try {
    const badDecision = await h.call(request({ decision: 'maybe' }))
    assert.equal(badDecision.status, 400)
    const badSince = await h.call(request({ since: 'not-a-date' }))
    assert.equal(badSince.status, 400)
  } finally {
    await h.dispose()
  }
})
