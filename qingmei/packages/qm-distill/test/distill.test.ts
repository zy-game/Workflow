/**
 * 会话凝练插件的测试：候选落库、采纳才写记忆、可回滚、群聊不参与、LLM 默认不调。
 * 这些行为错一条，要么污染召回，要么让「可审阅」变成摆设。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import {
  EVENTS,
  LlmService,
  MemoryService,
  type GatewayRequest,
  type GatewayResponse,
  type MemoryRecord,
  type RecallQuery,
  type RecallResult,
  type TurnEnd,
} from '@qingmei/core'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as distill from '../src/index.ts'

class FakeMemory extends MemoryService {
  readonly ingested: MemoryRecord[] = []
  readonly forgotten: string[] = []
  private seq = 0

  async ingest(records: MemoryRecord[]): Promise<{ created: string[]; merged: string[] }> {
    const created: string[] = []
    for (const record of records) {
      this.ingested.push(record)
      created.push(`fact_${++this.seq}`)
    }
    return { created, merged: [] }
  }

  async recall(_query: RecallQuery): Promise<RecallResult> {
    return { facts: [], reason: 'ok' } as RecallResult
  }

  async forget(ids: string[]): Promise<number> {
    this.forgotten.push(...ids)
    return ids.length
  }
}

class FakeLlm extends LlmService {
  calls = 0
  private readonly reply: string
  constructor(ctx: Context, reply: string) {
    super(ctx)
    this.reply = reply
  }
  async *chat(): AsyncIterable<{ type: 'text'; text: string }> {
    this.calls += 1
    yield { type: 'text', text: this.reply }
  }
}

function response(): { res: GatewayResponse; read: () => { status: number; body: any } } {
  let status = 0
  let body: unknown
  const res: GatewayResponse = {
    status(code) { status = code; return res },
    header() { return res },
    send(payload) { body = payload },
  }
  return { res, read: () => ({ status, body }) }
}

async function boot(options: { config?: distill.DistillConfig; llmReply?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-distill-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'qm.db') })
  await storeFiber
  const gatewayFiber = ctx.plugin(gatewayPlugin)
  await gatewayFiber
  // Service 在构造时把自己注册到 ctx（与 qm-task 测试里的 FakeHarness 同一套用法）
  const memory = new FakeMemory(ctx)
  const llm = options.llmReply === undefined ? null : new FakeLlm(ctx, options.llmReply)
  const distillFiber = ctx.plugin(distill, options.config ?? {})
  await distillFiber

  const call = async (method: string, path: string, body?: unknown, query: Record<string, string> = {}) => {
    const r = response()
    await ctx.gateway.dispatch({ method, path, query, headers: {}, body } as GatewayRequest, r.res)
    return r.read()
  }
  const turn = (userText: string, extra: Partial<TurnEnd> = {}) => {
    ctx.events.emit(EVENTS.turnEnd, {
      sessionId: 's_owner',
      traceId: `t_${Math.random().toString(36).slice(2, 8)}`,
      ok: true,
      text: '好的',
      userText,
      audience: 'owner',
      ...extra,
    } as TurnEnd)
  }
  return {
    ctx,
    memory,
    llm,
    call,
    turn,
    async dispose() {
      await distillFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, label: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${label}`)
}

test('owner 回合里的陈述会变成待确认候选，但不写记忆', async () => {
  const h = await boot()
  try {
    h.turn('我对花生过敏')
    const item = await waitFor(async () => {
      const { body } = await h.call('GET', '/api/v1/memory/candidates')
      return body.items?.[0] ?? null
    }, '候选')
    assert.equal(item.predicate, '过敏')
    assert.equal(item.object, '花生')
    assert.equal(item.status, 'pending')
    assert.equal(h.memory.ingested.length, 0, '没采纳之前不能写记忆')
  } finally {
    await h.dispose()
  }
})

test('群聊回合不凝练', async () => {
  const h = await boot()
  try {
    h.turn('我对花生过敏', { audience: 'group:feishu:g1' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const { body } = await h.call('GET', '/api/v1/memory/candidates')
    assert.equal(body.items.length, 0)
  } finally {
    await h.dispose()
  }
})

test('采纳：写入记忆并记录 factId；拒绝：不写', async () => {
  const h = await boot()
  try {
    h.turn('我对花生过敏')
    const item = await waitFor(async () => (await h.call('GET', '/api/v1/memory/candidates')).body.items?.[0], '候选')

    const accepted = await h.call('POST', '/api/v1/memory/candidates/decide', { id: item.id, allow: true })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.item.status, 'accepted')
    assert.ok(accepted.body.factId)
    assert.equal(h.memory.ingested.length, 1)
    assert.equal(h.memory.ingested[0].origin.kind, 'distilled')
    assert.equal(h.memory.ingested[0].audience, 'owner')

    h.turn('我喜欢美式咖啡')
    const second = await waitFor(async () => {
      const { body } = await h.call('GET', '/api/v1/memory/candidates')
      return body.items?.find((row: { predicate: string }) => row.predicate === '喜欢') ?? null
    }, '第二条候选')
    const rejected = await h.call('POST', '/api/v1/memory/candidates/decide', { id: second.id, allow: false })
    assert.equal(rejected.body.item.status, 'rejected')
    assert.equal(h.memory.ingested.length, 1, '拒绝的不能被写入')
  } finally {
    await h.dispose()
  }
})

test('重复的陈述只留一条待确认', async () => {
  const h = await boot()
  try {
    h.turn('我对花生过敏')
    h.turn('我对花生过敏')
    await new Promise((resolve) => setTimeout(resolve, 80))
    const { body } = await h.call('GET', '/api/v1/memory/candidates')
    assert.equal(body.items.length, 1)
  } finally {
    await h.dispose()
  }
})

test('回滚：按批次撤回已采纳的事实', async () => {
  const h = await boot()
  try {
    h.turn('我对花生过敏')
    const item = await waitFor(async () => (await h.call('GET', '/api/v1/memory/candidates')).body.items?.[0], '候选')
    const accepted = await h.call('POST', '/api/v1/memory/candidates/decide', { id: item.id, allow: true })
    const factId = accepted.body.factId

    const rollback = await h.call('POST', '/api/v1/memory/candidates/rollback', { batchId: item.batch_id })
    assert.equal(rollback.body.rolledBack, 1)
    assert.deepEqual(h.memory.forgotten, [factId])
    const { body } = await h.call('GET', '/api/v1/memory/candidates', undefined, { status: 'all' })
    assert.equal(body.items[0].status, 'rolled_back')
  } finally {
    await h.dispose()
  }
})

test('默认不调用 LLM', async () => {
  const h = await boot({ llmReply: '[{"subject":"主人","predicate":"喜欢","object":"拿铁"}]' })
  try {
    h.turn('我最近在学冲咖啡')
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(h.llm?.calls, 0)
    const { body } = await h.call('GET', '/api/v1/memory/candidates')
    assert.equal(body.items.length, 0)
  } finally {
    await h.dispose()
  }
})

test('打开 LLM 抽取才调用，且有每日配额', async () => {
  const h = await boot({
    config: { llmExtract: true, llmDailyLimit: 1 },
    llmReply: '[{"subject":"主人","predicate":"喜欢","object":"拿铁"}]',
  })
  try {
    h.turn('我最近在学冲咖啡')
    const item = await waitFor(async () => (await h.call('GET', '/api/v1/memory/candidates')).body.items?.[0], 'LLM 候选')
    assert.equal(item.rule, 'llm')
    assert.equal(h.llm?.calls, 1)

    h.turn('我最近在学手冲')
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(h.llm?.calls, 1, '超过每日配额不应再调模型')
  } finally {
    await h.dispose()
  }
})

