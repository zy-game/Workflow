import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as approvalPlugin from '@qingmei/provider-approval-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as approvalApi from '../src/index.ts'
import {
  type ApprovalRequest,
  type ApprovalService,
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
  const dir = mkdtempSync(join(tmpdir(), 'qm-approval-api-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'api.db') })
  await storeFiber
  const approvalFiber = ctx.plugin(approvalPlugin)
  await approvalFiber
  await ctx.plugin(gatewayPlugin)
  const apiFiber = ctx.plugin(approvalApi)
  await apiFiber
  const approval = ctx.reflect.get('approval', false) as ApprovalService

  return {
    approval,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await apiFiber.dispose()
      await apiFiber.dispose()
      await approvalFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function request(method: string, path: string, body?: unknown, query: Record<string, string> = {}): GatewayRequest {
  return { method, path, query, headers: {}, body }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(approvalApi.name, 'qm-approval')
  assert.deepEqual(approvalApi.inject, ['approval', 'gateway'])
})

test('GET /api/v1/approvals：默认全部，?status=pending 只给待确认', async () => {
  const h = await setup()
  try {
    const first = await h.approval.create({ action: 'a', prompt: '第一条' })
    await h.approval.create({ action: 'b', prompt: '第二条' })
    await h.approval.decide(first.id, { allow: true })

    const all = await h.call(request('GET', '/api/v1/approvals'))
    assert.equal(all.status, 200)
    assert.equal((all.body as { items: ApprovalRequest[] }).items.length, 2)

    const pending = await h.call(request('GET', '/api/v1/approvals', undefined, { status: 'pending' }))
    assert.equal((pending.body as { items: ApprovalRequest[] }).items.length, 1)
    assert.equal((pending.body as { items: ApprovalRequest[] }).items[0]!.action, 'b')
  } finally {
    await h.dispose()
  }
})

test('POST /api/v1/approvals/decide：批准、拒绝、缺参、未知 id', async () => {
  const h = await setup()
  try {
    const request0 = await h.approval.create({ action: 'a', prompt: '待确认' })

    const missingId = await h.call(request('POST', '/api/v1/approvals/decide', { allow: true }))
    assert.equal(missingId.status, 400)

    const badAllow = await h.call(request('POST', '/api/v1/approvals/decide', { id: request0.id, allow: 'yes' }))
    assert.equal(badAllow.status, 400)

    const allowed = await h.call(request('POST', '/api/v1/approvals/decide', { id: request0.id, allow: true }))
    assert.equal(allowed.status, 200)
    assert.equal((allowed.body as { request: ApprovalRequest }).request.status, 'allowed')

    const unknown = await h.call(request('POST', '/api/v1/approvals/decide', { id: 'ap_nope', allow: true }))
    assert.equal(unknown.status, 404)
  } finally {
    await h.dispose()
  }
})
