/**
 * qm-agent 的回合行为测试。
 *
 * 用内存版 store/channel/gateway 与脚本化 llm 驱动真实的 cordis 容器，
 * 断言流式事件、上下文组装、落库与渠道回投的实际内容。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import {
  EVENTS,
  ChannelService,
  GatewayService,
  StoreService,
  type ChannelAdapter,
  type ChannelId,
  type Collection,
  type GatewayEvent,
  type InboundMessage,
  type OutboundEnvelope,
  type Query,
  type Row,
  type RouteDefinition,
  type SendResult,
  type TurnChunk,
  type TurnEnd,
} from '@qingmei/core'
import { LlmService, type ChatRequest, type ChatStreamChunk } from '@qingmei/service-llm'

import * as agent from '../src/index.ts'

const PERSONA = '你是青梅，回答简短。'

interface StoredMessage extends Row {
  session_id: string
  role: 'user' | 'assistant'
  text: string
  created_at: number
}

// ────────────────────────────────────────────── 内存集合

class MemoryCollection<T extends Row> implements Collection<T> {
  readonly name: string
  readonly rows = new Map<string, T>()
  private seq = 0

  constructor(name: string) {
    this.name = name
  }

  async get(id: string): Promise<T | null> {
    return this.rows.get(id) ?? null
  }

  async find(query?: Query<T>): Promise<T[]> {
    let result = [...this.rows.values()].filter((row) => matches(row, query?.where))
    if (query?.order) result = result.sort((a, b) => compareBy(a, b, query.order!))
    const offset = query?.offset ?? 0
    return query?.limit === undefined
      ? result.slice(offset)
      : result.slice(offset, offset + query.limit)
  }

  async insert(value: Omit<T, 'id'> & { id?: string }): Promise<T> {
    const id = value.id ?? `row_${this.name}_${++this.seq}`
    const row = { ...value, id } as T
    this.rows.set(id, row)
    return row
  }

  async update(id: string, patch: Partial<T>): Promise<void> {
    const existing = this.rows.get(id)
    if (!existing) throw new Error(`${this.name} 里没有 ${id}`)
    this.rows.set(id, { ...existing, ...patch, id } as T)
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id)
  }

  async count(query?: Query<T>): Promise<number> {
    return [...this.rows.values()].filter((row) => matches(row, query?.where)).length
  }
}

function matches<T extends Row>(row: T, where: Partial<T> | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(
    ([key, expected]) => (row as Record<string, unknown>)[key] === expected,
  )
}

function compareBy<T extends Row>(a: T, b: T, order: NonNullable<Query<T>['order']>): number {
  for (const { field, dir } of order) {
    const delta = compareValues(
      (a as Record<string, unknown>)[field as string],
      (b as Record<string, unknown>)[field as string],
    )
    if (delta !== 0) return dir === 'asc' ? delta : -delta
  }
  return 0
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1
  return String(a) < String(b) ? -1 : 1
}

function collectionOf<T extends Row>(
  collections: Map<string, MemoryCollection<Row>>,
  name: string,
): MemoryCollection<T> {
  let collection = collections.get(name)
  if (!collection) {
    collection = new MemoryCollection<Row>(name)
    collections.set(name, collection)
  }
  return collection as unknown as MemoryCollection<T>
}

// ────────────────────────────────────────────── 假服务

interface FakeOptions {
  /** 模型逐片吐出的文本 */
  chunks: string[]
  /** 相邻两片之间的停顿，用来观察并发 */
  delayMs?: number
  /** 非空则 chat 在吐出任何内容前抛错 */
  failWith?: string
  /** 非空则 channel.send 抛错 */
  failSend?: string
  /** 非空则 store 的 insert 抛错 */
  failInsert?: string
}

interface FakeState {
  collections: Map<string, MemoryCollection<Row>>
  sent: OutboundEnvelope[]
  published: GatewayEvent[]
  requests: ChatRequest[]
  active: number
  maxActive: number
  messages(): StoredMessage[]
}

function createFakes(options: FakeOptions) {
  const state: FakeState = {
    collections: new Map(),
    sent: [],
    published: [],
    requests: [],
    active: 0,
    maxActive: 0,
    messages(): StoredMessage[] {
      return [...collectionOf<StoredMessage>(this.collections, 'qm_message').rows.values()]
    },
  }

  class FakeStore extends StoreService {
    constructor(ctx: Context) {
      super(ctx)
    }

    ready(): Promise<void> {
      return Promise.resolve()
    }

    collection<T extends Row>(name: string): Collection<T> {
      const base = collectionOf<T>(state.collections, name)
      if (!options.failInsert) return base
      return {
        get: (id: string) => base.get(id),
        find: (query?: Query<T>) => base.find(query),
        insert: () => Promise.reject(new Error(options.failInsert)),
        update: (id: string, patch: Partial<T>) => base.update(id, patch),
        delete: (id: string) => base.delete(id),
        count: (query?: Query<T>) => base.count(query),
      }
    }

    // 测试替身：直接执行，不做回滚（真实回滚由 provider-store-sqlite 的测试覆盖）
    transaction<T>(fn: () => Promise<T> | T): Promise<T> {
      return Promise.resolve(fn())
    }

    migrate(): Promise<string[]> {
      return Promise.resolve([])
    }
  }

  class FakeChannel extends ChannelService {
    constructor(ctx: Context) {
      super(ctx)
    }

    register(_adapter: ChannelAdapter): () => void {
      return () => {}
    }

    async send(envelope: OutboundEnvelope): Promise<SendResult> {
      if (options.failSend) throw new Error(options.failSend)
      state.sent.push(envelope)
      return { ok: true, platformMessageId: `out_${state.sent.length}` }
    }

    status(): { id: ChannelId; online: boolean }[] {
      return []
    }
  }

  class FakeGateway extends GatewayService {
    constructor(ctx: Context) {
      super(ctx)
    }

    route(_def: RouteDefinition): () => void {
      return () => {}
    }

    publish(event: GatewayEvent): void {
      state.published.push(event)
    }
  }

  class FakeLlm extends LlmService {
    constructor(ctx: Context) {
      super(ctx)
    }

    async complete(req: ChatRequest): Promise<{ text: string }> {
      state.requests.push(req)
      return { text: options.chunks.join('') }
    }

    async *chat(req: ChatRequest): AsyncIterable<ChatStreamChunk> {
      state.requests.push(req)
      state.active += 1
      state.maxActive = Math.max(state.maxActive, state.active)
      try {
        if (options.failWith) throw new Error(options.failWith)
        for (const text of options.chunks) {
          if (req.signal?.aborted) return
          await delay(options.delayMs ?? 1)
          yield { type: 'text', text }
        }
        yield { type: 'done' }
      } finally {
        state.active -= 1
      }
    }
  }

  return { state, FakeStore, FakeChannel, FakeGateway, FakeLlm }
}

// ────────────────────────────────────────────── 测试脚手架

interface Harness {
  ctx: Context
  state: FakeState
  chunks: TurnChunk[]
  ends: TurnEnd[]
}

async function boot(options: FakeOptions = { chunks: ['好的。'] }): Promise<Harness> {
  const ctx = new Context()
  const fakes = createFakes(options)

  await ctx.plugin(fakes.FakeStore)
  await ctx.plugin(fakes.FakeChannel)
  await ctx.plugin(fakes.FakeGateway)
  await ctx.plugin(fakes.FakeLlm)
  await ctx.plugin(agent, { persona: PERSONA })

  const chunks: TurnChunk[] = []
  const ends: TurnEnd[] = []
  ctx.events.on(EVENTS.turnChunk, (chunk: TurnChunk) => {
    chunks.push(chunk)
  })
  ctx.events.on(EVENTS.turnEnd, (end: TurnEnd) => {
    ends.push(end)
  })

  return { ctx, state: fakes.state, chunks, ends }
}

function inbound(text: string, conversationId = 'conv-1'): InboundMessage {
  return {
    platformMessageId: 'pm_1',
    channel: 'web',
    accountId: 'account-1',
    conversation: { kind: 'dm', id: conversationId },
    sender: { platformUserId: 'user-1', displayName: '测试用户' },
    blocks: [{ type: 'text', text }],
    receivedAt: new Date(),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await delay(2)
  }
}

async function seed(
  state: FakeState,
  sessionId: string,
  role: StoredMessage['role'],
  text: string,
  createdAt: number,
): Promise<void> {
  await collectionOf<StoredMessage>(state.collections, 'qm_message').insert({
    session_id: sessionId,
    role,
    text,
    created_at: createdAt,
  })
}

// ────────────────────────────────────────────── 用例

test('插件形态与契约一致：name / inject', () => {
  assert.equal(agent.name, 'qm-agent')
  assert.deepEqual(agent.inject, ['llm', 'store', 'channel', 'gateway'])
})

test('一次 inbound：chunk 事件、turn/end、store 两条消息、渠道回投', async () => {
  const h = await boot({ chunks: ['你好呀', '，我是青梅', '。'] })

  h.ctx.events.emit(EVENTS.inbound, inbound('在吗'))
  await waitFor(() => h.ends.length === 1, 'turn/end')

  // 流式事件
  assert.deepEqual(h.chunks.map((chunk) => chunk.text), ['你好呀', '，我是青梅', '。'])
  assert.ok(h.chunks.every((chunk) => chunk.sessionId === 's_conv-1'))

  // 网关广播与 chunk 事件同源同内容
  assert.equal(h.state.published.length, 3)
  assert.ok(h.state.published.every((event) => event.type === 'chunk'))
  assert.deepEqual(
    h.state.published.map((event) => (event.data as TurnChunk).text),
    ['你好呀', '，我是青梅', '。'],
  )

  // turn/end
  assert.equal(h.ends.length, 1)
  assert.deepEqual(h.ends[0], {
    sessionId: 's_conv-1',
    ok: true,
    text: '你好呀，我是青梅。',
  })

  // 交给模型的上下文：system + 当前 user（无历史）
  assert.equal(h.state.requests.length, 1)
  assert.deepEqual(h.state.requests[0].messages, [
    { role: 'system', content: PERSONA },
    { role: 'user', content: '在吗' },
  ])

  // 落库：user 与 assistant 各一条，带齐 P1 约定字段
  const rows = h.state.messages()
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((row) => [row.session_id, row.role, row.text]),
    [
      ['s_conv-1', 'user', '在吗'],
      ['s_conv-1', 'assistant', '你好呀，我是青梅。'],
    ],
  )
  assert.ok(rows[0].id.length > 0 && rows[1].id.length > 0)
  assert.notEqual(rows[0].id, rows[1].id)
  assert.ok(rows[1].created_at > rows[0].created_at)

  // 渠道回投完整回复
  assert.equal(h.state.sent.length, 1)
  assert.deepEqual(h.state.sent[0], {
    channel: 'web',
    conversationId: 'conv-1',
    blocks: [{ type: 'text', text: '你好呀，我是青梅。' }],
  })
})

test('上下文只取本会话最近 20 条历史，并按 created_at 升序拼在 system 之后', async () => {
  const h = await boot({ chunks: ['收到。'] })

  for (let i = 1; i <= 25; i++) {
    await seed(h.state, 's_conv-1', i % 2 === 1 ? 'user' : 'assistant', `旧消息 ${i}`, i)
  }
  await seed(h.state, 's_other', 'user', '别的会话的消息', 26)

  h.ctx.events.emit(EVENTS.inbound, inbound('现在几点了'))
  await waitFor(() => h.ends.length === 1, 'turn/end')

  const messages = h.state.requests[0].messages
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[0].content, PERSONA)

  const history = messages.slice(1, -1)
  assert.equal(history.length, 20)
  assert.deepEqual(
    history.map((message) => message.content),
    Array.from({ length: 20 }, (_, index) => `旧消息 ${index + 6}`),
  )

  const current = messages[messages.length - 1]
  assert.deepEqual(current, { role: 'user', content: '现在几点了' })

  // 两条新消息也进库：25 条历史 + 1 条别的会话 + 本轮 2 条
  assert.equal(h.state.messages().length, 28)
})

test('模型出错：兜底回复、turn/end 仍发出且 ok=false、历史照记', async () => {
  const h = await boot({ chunks: [], failWith: '模型路由不可用' })

  h.ctx.events.emit(EVENTS.inbound, inbound('帮我订个会议'))
  await waitFor(() => h.ends.length === 1, 'turn/end')

  const expected = '我这边出了点问题：模型路由不可用'
  assert.equal(h.chunks.length, 0)
  assert.deepEqual(h.ends[0], {
    sessionId: 's_conv-1',
    ok: false,
    text: expected,
    error: '模型路由不可用',
  })

  assert.deepEqual(
    h.state.messages().map((row) => [row.role, row.text]),
    [
      ['user', '帮我订个会议'],
      ['assistant', expected],
    ],
  )
  assert.deepEqual(h.state.sent[0].blocks, [{ type: 'text', text: expected }])
})

test('同一会话的两个回合串行执行，后一回合能看到前一回合的历史', async () => {
  const h = await boot({ chunks: ['一', '二', '三'], delayMs: 5 })

  h.ctx.events.emit(EVENTS.inbound, inbound('第一条'))
  h.ctx.events.emit(EVENTS.inbound, inbound('第二条'))
  await waitFor(() => h.ends.length === 2, '两个 turn/end')

  assert.equal(h.state.requests.length, 2)
  assert.equal(h.state.maxActive, 1, '同一会话不应并发调用模型')
  assert.deepEqual(
    h.ends.map((end) => end.text),
    ['一二三', '一二三'],
  )

  assert.deepEqual(h.state.requests[1].messages, [
    { role: 'system', content: PERSONA },
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '一二三' },
    { role: 'user', content: '第二条' },
  ])

  assert.deepEqual(
    h.state.messages().map((row) => [row.role, row.text]),
    [
      ['user', '第一条'],
      ['assistant', '一二三'],
      ['user', '第二条'],
      ['assistant', '一二三'],
    ],
  )
  assert.equal(h.state.sent.length, 2)
})

test('渠道发送失败：落库照做、turn/end 仍发出且 ok=false', async () => {
  const h = await boot({ chunks: ['好。'], failSend: '渠道离线' })

  h.ctx.events.emit(EVENTS.inbound, inbound('在吗'))
  await waitFor(() => h.ends.length === 1, 'turn/end')

  assert.deepEqual(h.ends[0], {
    sessionId: 's_conv-1',
    ok: false,
    text: '好。',
    error: '渠道发送失败：渠道离线',
  })
  assert.equal(h.state.sent.length, 0)
  assert.deepEqual(
    h.state.messages().map((row) => [row.role, row.text]),
    [
      ['user', '在吗'],
      ['assistant', '好。'],
    ],
  )
})

test('落库失败：回复照发、turn/end 仍发出且 ok=false', async () => {
  const h = await boot({ chunks: ['好。'], failInsert: '磁盘只读' })

  h.ctx.events.emit(EVENTS.inbound, inbound('在吗'))
  await waitFor(() => h.ends.length === 1, 'turn/end')

  assert.deepEqual(h.ends[0], {
    sessionId: 's_conv-1',
    ok: false,
    text: '好。',
    error: '写入会话记录失败：磁盘只读',
  })
  assert.equal(h.state.messages().length, 0)
  assert.equal(h.state.sent.length, 1)
  assert.deepEqual(h.state.sent[0].blocks, [{ type: 'text', text: '好。' }])
})
