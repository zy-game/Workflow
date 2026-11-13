import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as approvalApi from '../src/index.ts'
import { EVENTS, ChannelService, type OutboundEnvelope, type SendResult } from '@qingmei/core'
import type { ChannelCapabilities } from '@qingmei/core'

class FakeChannel extends ChannelService {
  readonly sent: OutboundEnvelope[] = []
  async register(): Promise<() => void> {
    return () => undefined
  }
  async send(envelope: OutboundEnvelope): Promise<SendResult> {
    this.sent.push(envelope)
    return { ok: true, platformMessageId: out_ }
  }
  status() {
    return [{ id: 'feishu' as const, online: true }]
  }
}
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
  const channel = new FakeChannel(ctx)
  await ctx.plugin(gatewayPlugin)
  const apiFiber = ctx.plugin(approvalApi)
  await apiFiber
  const approval = ctx.reflect.get('approval', false) as ApprovalService

  return {
    ctx,
    approval,
    channel,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await apiFiber.dispose()
      await apiFiber.dispose()
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
  assert.deepEqual(approvalApi.inject, ['gateway', 'store', 'channel'])
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

test('渠道回复「批准」：处理最早一条待确认并回执', async () => {
  const h = await setup()
  try {
    const first = await h.approval.create({ action: 'acp:bash: npm test', prompt: '跑测试' })
    const second = await h.approval.create({ action: 'tool.invoke:shell', prompt: '执行 shell' })

    const message = {
      platformMessageId: 'om_1',
      channel: 'feishu',
      accountId: 'cli',
      conversation: { kind: 'dm', id: 'oc_1' },
      sender: { platformUserId: 'ou_1', displayName: '我' },
      blocks: [{ type: 'text', text: '批准' }],
      receivedAt: new Date(),
    }
    h.ctx.events.emit(EVENTS.inbound, message)
    assert.equal(message.handledBy, 'approval', '审批回复应标记为控制指令')

    await new Promise((resolve) => setTimeout(resolve, 30))
    const rows = await h.approval.list()
    assert.equal(rows.find((row) => row.id === first.id)?.status, 'allowed')
    assert.equal(rows.find((row) => row.id === second.id)?.status, 'pending')
    assert.equal(h.channel.sent.length, 1)
    const text = (h.channel.sent[0]!.blocks[0] as { text: string }).text
    assert.match(text, /已批准：跑测试/)
    assert.match(text, /还有 1 条待确认/)
  } finally {
    await h.dispose()
  }
})

test('渠道回复「拒绝」与无关文本', async () => {
  const h = await setup()
  try {
    const only = await h.approval.create({ action: 'a', prompt: '危险操作' })
    h.ctx.events.emit(EVENTS.inbound, {
      platformMessageId: 'om_2',
      channel: 'feishu',
      accountId: 'cli',
      conversation: { kind: 'dm', id: 'oc_1' },
      sender: { platformUserId: 'ou_1', displayName: '我' },
      blocks: [{ type: 'text', text: '拒绝' }],
      receivedAt: new Date(),
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal((await h.approval.get(only.id))?.status, 'denied')

    const before = h.channel.sent.length
    h.ctx.events.emit(EVENTS.inbound, {
      platformMessageId: 'om_3',
      channel: 'feishu',
      accountId: 'cli',
      conversation: { kind: 'dm', id: 'oc_1' },
      sender: { platformUserId: 'ou_1', displayName: '我' },
      blocks: [{ type: 'text', text: '今天吃什么' }],
      receivedAt: new Date(),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(h.channel.sent.length, before, '无关文本不应触发审批')
  } finally {
    await h.dispose()
  }
})

test('审批请求会推到最近的渠道会话，Web 不重复发', async () => {
  const h = await setup()
  try {
    const inbound = (id: string, channel: 'feishu' | 'web', conversation: string) => ({
      platformMessageId: id,
      channel,
      accountId: 'acc',
      conversation: { kind: 'dm' as const, id: conversation },
      sender: { platformUserId: 'u1', displayName: '我' },
      blocks: [{ type: 'text' as const, text: '在吗' }],
      receivedAt: new Date(),
    })

    h.ctx.events.emit(EVENTS.inbound, inbound('m1', 'web', 'owner'))
    h.ctx.events.emit(EVENTS.inbound, inbound('m2', 'feishu', 'oc_dm'))
    await new Promise((resolve) => setTimeout(resolve, 30))

    const request = await h.approval.create({ action: 'tool.invoke:test', prompt: '需要你确认' })
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(h.channel.sent.length, 1, '只推飞书，不推 web')
    const envelope = h.channel.sent[0]!
    assert.equal(envelope.channel, 'feishu')
    assert.equal(envelope.conversationId, 'oc_dm')
    const text = (envelope.blocks[0] as { text: string }).text
    assert.match(text, /待确认：需要你确认/)
    assert.match(text, /回「批准」或「拒绝」/)
    const actions = envelope.blocks.find((block) => block.type === 'actions') as
      | { buttons: { id: string; label: string }[] }
      | undefined
    assert.deepEqual(
      actions?.buttons.map((button) => [button.label, button.id]),
      [
        ['同意', `approval:allow:${request.id}`],
        ['拒绝', `approval:deny:${request.id}`],
      ],
    )

    const listed = await h.call({ method: 'GET', path: '/api/v1/approvals', query: {}, headers: {} })
    const item = (listed.body as { items: { id: string; notifiedTo: string[] }[] }).items.find((row) => row.id === request.id)
    assert.deepEqual(item?.notifiedTo, ['feishu'])
  } finally {
    await h.dispose()
  }
})

test('卡片按钮：同意/拒绝直接决定并回执', async () => {
  const h = await setup()
  try {
    const allowOne = await h.approval.create({ action: 'tool.invoke:card', prompt: '按钮同意测试' })
    h.ctx.events.emit(EVENTS.action, {
      channel: 'feishu',
      conversationId: 'oc_card',
      actionId: `approval:allow:${allowOne.id}`,
      messageId: 'om_card_1',
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal((await h.approval.get(allowOne.id))?.status, 'allowed')
    assert.match((h.channel.sent.at(-1)!.blocks[0] as { text: string }).text, /已批准：按钮同意测试/)
    assert.equal(h.channel.sent.at(-1)!.editTarget, 'om_card_1', '应编辑原卡片而不是再发一条')

    const denyOne = await h.approval.create({ action: 'tool.invoke:card', prompt: '按钮拒绝测试' })
    h.ctx.events.emit(EVENTS.action, {
      channel: 'feishu',
      conversationId: 'oc_card',
      actionId: `approval:deny:${denyOne.id}`,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal((await h.approval.get(denyOne.id))?.status, 'denied')
    assert.match((h.channel.sent.at(-1)!.blocks[0] as { text: string }).text, /已拒绝：按钮拒绝测试/)
  } finally {
    await h.dispose()
  }
})

test('点已决定的旧卡片：把那张卡改成结果，不重复决定', async () => {
  const h = await setup()
  try {
    const request = await h.approval.create({ action: 'tool.invoke:old', prompt: '旧卡片测试' })
    await h.approval.decide(request.id, { allow: true })
    const before = h.channel.sent.length

    h.ctx.events.emit(EVENTS.action, {
      channel: 'feishu',
      conversationId: 'oc_1',
      actionId: `approval:allow:${request.id}`,
      messageId: 'om_old_card',
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(h.channel.sent.length, before + 1, '应更新旧卡片而不是再发一条')
    const last = h.channel.sent.at(-1)!
    assert.equal(last.editTarget, 'om_old_card')
    assert.match((last.blocks[0] as { text: string }).text, /已批准：旧卡片测试/)
    assert.equal((await h.approval.get(request.id))?.status, 'allowed', '状态不应被再次改动')
  } finally {
    await h.dispose()
  }
})

test('GET /api/v1/approvals/stats：接受率与按 action 统计', async () => {
  const h = await setup()
  try {
    const a = await h.approval.create({ action: 'qm.plan', prompt: '计划 A' })
    const b = await h.approval.create({ action: 'qm.plan', prompt: '计划 B' })
    const c = await h.approval.create({ action: 'group.send', prompt: '群消息' })
    await h.approval.decide(a.id, { allow: true })
    await h.approval.decide(b.id, { allow: false })
    const stats = await h.call(request('GET', '/api/v1/approvals/stats'))
    const body = stats.body as {
      total: number
      allowed: number
      denied: number
      pending: number
      acceptance: number
      byAction: Array<{ action: string; total: number }>
    }
    assert.equal(body.total, 3)
    assert.equal(body.allowed, 1)
    assert.equal(body.denied, 1)
    assert.equal(body.pending, 1)
    assert.equal(body.acceptance, 0.5)
    assert.equal(body.byAction[0]?.action, 'qm.plan')
    void c
  } finally {
    await h.dispose()
  }
})
