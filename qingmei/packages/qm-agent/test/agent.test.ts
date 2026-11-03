/**
 * qm-agent 的回合行为测试。
 *
 * 用内存版 store、真实 service-channel + 假适配器、脚本化 llm 驱动真实的 cordis 容器，
 * 断言流式事件、上下文组装、落库（由 qm-history 负责）与渠道回投的实际内容。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import {
  EVENTS,
  GatewayService,
  StoreService,
  type ChannelAdapter,
  type ChannelCapabilities,
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
import {
  ConversationProfileService,
  IdentityService,
  MemoryService,
  type ConversationPolicy,
  type ConversationProfile,
  type MemoryRecord,
  type ProfileEntry,
  type RecallQuery,
  type RecallResult,
} from '@qingmei/core'

import * as channelPlugin from '@qingmei/service-channel'
import * as historyPlugin from '@qingmei/qm-history'
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
  memoryText: string
  profile: ProfileEntry[]
  profileCalls: { audience?: string }[]
  groupProfile: { note: string; maxChars: number; forbiddenTopics?: string[] } | null
  identityRole: 'owner' | 'guest' | 'none'
  recalls: RecallQuery[]
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
    memoryText: '',
    profile: [],
    profileCalls: [],
    groupProfile: null,
    identityRole: 'owner',
    recalls: [],
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

  // 走真实的 service-channel：qm/outbound 由它发出，qm-history 才能落库
  const adapter: ChannelAdapter = {
    id: 'web',
    capabilities: {
      markdown: true,
      card: true,
      button: true,
      image: true,
      voice: false,
      file: false,
      edit: false,
      thread: false,
      maxTextLength: 4000,
    },
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async send(envelope: OutboundEnvelope): Promise<SendResult> {
      if (options.failSend) throw new Error(options.failSend)
      state.sent.push(envelope)
      return { ok: true, platformMessageId: `out_${state.sent.length}` }
    },
  }

  class FakeMemory extends MemoryService {
    constructor(ctx: Context) {
      super(ctx)
    }
    async ingest(_records: MemoryRecord[]): Promise<{ created: string[]; merged: string[] }> {
      return { created: [], merged: [] }
    }
    async recall(query: RecallQuery): Promise<RecallResult> {
      state.recalls.push(query)
      return { facts: [], text: state.memoryText }
    }
    async profile(query?: { audience?: string }): Promise<ProfileEntry[]> {
      state.profileCalls.push(query ?? {})
      return state.profile
    }
    async forget(): Promise<number> {
      return 0
    }
  }

  class FakeProfile extends ConversationProfileService {
    constructor(ctx: Context) {
      super(ctx)
    }
    async get(channel: string, conversationId: string): Promise<ConversationProfile | null> {
      if (!state.groupProfile) return null
      return {
        id: `${channel}:${conversationId}`,
        channel: channel as ConversationProfile['channel'],
        platformConversationId: conversationId,
        title: '测试群',
        kind: 'group',
        tags: ['casual'],
        status: 'configured',
        discoveredAt: new Date(),
        lastActiveAt: null,
      }
    }
    async list(): Promise<ConversationProfile[]> {
      return []
    }
    async configure(): Promise<ConversationProfile> {
      throw new Error('not used')
    }
    policy(): ConversationPolicy {
      return {
        audiences: [],
        maxChars: state.groupProfile!.maxChars,
        tone: 'casual',
        proactive: false,
        forbiddenTopics: state.groupProfile!.forbiddenTopics ?? [],
      }
    }
    note(): string {
      return state.groupProfile!.note
    }
  }
  class FakeIdentity extends IdentityService {
    constructor(ctx: Context) {
      super(ctx)
    }
    private current(): { id: string; displayName: string; role: 'owner' | 'family' | 'guest' | 'stranger' } | null {
      if (state.identityRole === 'none') return null
      return { id: 'owner', displayName: '主人', role: state.identityRole }
    }
    async resolve(): Promise<{ id: string; displayName: string; role: 'owner' } | { id: string; displayName: string; role: 'guest' } | null> {
      return this.current() as never
    }
    async ensureOwner(): Promise<never> {
      return this.current() as never
    }
    async bind(): Promise<never> {
      throw new Error('not used')
    }
    async unbind(): Promise<number> {
      return 0
    }
    async actor(): Promise<null> {
      return null
    }
    async list(): Promise<[]> {
      return []
    }
  }
  return { state, adapter, FakeStore, FakeGateway, FakeLlm, FakeMemory, FakeProfile, FakeIdentity }
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
  await ctx.plugin(channelPlugin)
  await ctx.plugin(fakes.FakeGateway)
  await ctx.plugin(fakes.FakeLlm)
  await ctx.plugin(fakes.FakeMemory)
  await ctx.plugin(fakes.FakeProfile)
  await ctx.plugin(fakes.FakeIdentity)
  await ctx.plugin(historyPlugin)
  await ctx.plugin(agent, { persona: PERSONA })
  ctx.channel.register(fakes.adapter)

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

let inboundSeq = 0

function inbound(text: string, conversationId = 'conv-1'): InboundMessage {
  inboundSeq += 1
  return {
    platformMessageId: `pm_${inboundSeq}`,
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

/** 去掉本回合新加的 traceId/latencyMs，只比较业务字段；同时校验它们确实存在 */
function endView(end: TurnEnd): Omit<TurnEnd, 'traceId' | 'latencyMs'> {
  assert.match(end.traceId, /^turn_/)
  assert.equal(typeof end.latencyMs, 'number')
  assert.equal(typeof end.steps, 'number')
  assert.equal(typeof end.tokensIn, 'number')
  assert.equal(typeof end.tokensOut, 'number')
  const { traceId: _traceId, latencyMs: _latencyMs, steps: _steps, tokensIn: _in, tokensOut: _out, deviceId: _device, ...rest } = end
  return rest
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
  assert.deepEqual(agent.inject, ['llm', 'store', 'channel', 'gateway', 'memory'])
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
  assert.deepEqual(endView(h.ends[0]!), {
    sessionId: 's_conv-1',
    ok: true,
    text: '你好呀，我是青梅。',
    userText: '在吗',
  })

  // 交给模型的上下文：system + 当前 user（无历史）
  assert.equal(h.state.requests.length, 1)
  assert.deepEqual(h.state.requests[0].messages, [
    { role: 'system', content: PERSONA },
    { role: 'user', content: '在吗' },
  ])

  // 落库：user 与 assistant 各一条，带齐 P1 约定字段（qm-history 异步写入，等它落完）
  await waitFor(() => h.state.messages().length === 2, '落库两条')
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

  // 渠道回投完整回复（带上本回合的 traceId）
  assert.equal(h.state.sent.length, 1)
  const { traceId: sentTraceId, ...envelope } = h.state.sent[0]!
  assert.equal(sentTraceId, h.ends[0]!.traceId, '出站消息应带回合 traceId')
  assert.deepEqual(envelope, {
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
  await waitFor(() => h.state.messages().length === 28, '本轮两条落库')
  assert.equal(h.state.messages().length, 28)
})

test('模型出错：兜底回复、turn/end 仍发出且 ok=false、历史照记', async () => {
  const h = await boot({ chunks: [], failWith: '模型路由不可用' })

  h.ctx.events.emit(EVENTS.inbound, inbound('帮我订个会议'))
  await waitFor(() => h.ends.length === 1, 'turn/end')

  const expected = '我这边出了点问题：模型路由不可用'
  assert.equal(h.chunks.length, 0)
  assert.deepEqual(endView(h.ends[0]!), {
    sessionId: 's_conv-1',
    ok: false,
    text: expected,
    userText: '帮我订个会议',
    error: '模型路由不可用',
  })

  await waitFor(() => h.state.messages().length === 2, '落库两条')
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

  await waitFor(() => h.state.messages().length === 4, '两轮都落库')
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

test('渠道发送失败：只剩用户消息，turn/end 仍发出且 ok=false', async () => {
  const h = await boot({ chunks: ['好。'], failSend: '渠道离线' })

  h.ctx.events.emit(EVENTS.inbound, inbound('在吗'))
  await waitFor(() => h.ends.length === 1, 'turn/end')

  assert.deepEqual(endView(h.ends[0]!), {
    sessionId: 's_conv-1',
    ok: false,
    text: '好。',
    userText: '在吗',
    error: '渠道发送失败：渠道离线',
  })
  assert.equal(h.state.sent.length, 0)
  // 助手消息由 qm/outbound 落库，投递失败就没有这一条；用户消息在入站时已经写下
  await waitFor(() => h.state.messages().length === 1, '只有用户消息')
  assert.deepEqual(
    h.state.messages().map((row) => [row.role, row.text]),
    [['user', '在吗']],
  )
})

test('落库失败：回复照发、turn/end 仍为 ok（落库不再属于回合职责）', async () => {
  const h = await boot({ chunks: ['好。'], failInsert: '磁盘只读' })

  h.ctx.events.emit(EVENTS.inbound, inbound('在吗'))
  await waitFor(() => h.ends.length === 1, 'turn/end')

  assert.deepEqual(endView(h.ends[0]!), {
    sessionId: 's_conv-1',
    ok: true,
    text: '好。',
    userText: '在吗',
  })
  assert.equal(h.state.messages().length, 0)
  assert.equal(h.state.sent.length, 1)
  assert.deepEqual(h.state.sent[0].blocks, [{ type: 'text', text: '好。' }])
})

test('召回按会话视口走：私聊 owner、群聊 group:<id>', async () => {
  const h = await boot({ chunks: ['收到。'] })
  h.state.memoryText = '主人喜欢手冲咖啡'

  h.ctx.events.emit(EVENTS.inbound, inbound('我喜欢喝什么'))
  await waitFor(() => h.ends.length === 1, 'turn/end')
  assert.deepEqual(h.state.recalls.at(-1), { text: '我喜欢喝什么', audience: 'owner', sessionId: 's_conv-1' })

  const group = inbound('群里问一句')
  group.conversation = { kind: 'group', id: 'g1' }
  h.ctx.events.emit(EVENTS.inbound, group)
  await waitFor(() => h.ends.length === 2, '第二个 turn/end')
  assert.deepEqual(h.state.recalls.at(-1), { text: '群里问一句', audience: 'group:web:g1', sessionId: 's_g1' })
})

test('被控制指令消费的消息不进入对话回合，也不调用模型', async () => {
  const h = await boot({ chunks: ['不该出现'] })
  const message = inbound('批准') as InboundMessage
  message.handledBy = 'approval'
  h.ctx.events.emit(EVENTS.inbound, message)
  await delay(20)
  assert.equal(h.chunks.length, 0)
  assert.equal(h.ends.length, 0)
  assert.equal(h.state.requests.length, 0)
})

test('画像只注入私聊：owner 看到「关于主人」，群聊不调用 profile', async () => {
  const h = await boot({ chunks: ['收到。'] })
  h.state.profile = [
    { subject: '宠物', facts: [{ subject: '宠物', predicate: '是', object: '狗', confidence: 0.9 }] },
  ]

  h.ctx.events.emit(EVENTS.inbound, inbound('我养什么'))
  await waitFor(() => h.ends.length === 1, 'turn/end')
  const system = h.state.requests[0]!.messages[0]!
  assert.equal(system.role, 'system')
  assert.match(system.content, /【关于主人】/)
  assert.match(system.content, /宠物：是狗/)
  assert.deepEqual(h.state.profileCalls.at(-1), { audience: 'owner' })

  const group = inbound('群里问一句')
  group.conversation = { kind: 'group', id: 'g2' }
  h.ctx.events.emit(EVENTS.inbound, group)
  await waitFor(() => h.ends.length === 2, '第二个 turn/end')
  const groupSystem = h.state.requests.at(-1)!.messages[0]!
  assert.doesNotMatch(groupSystem.content, /【关于主人】/)
  assert.equal(h.state.profileCalls.length, 1, '群聊不应调用 profile')
})

test('群策略：规则进 prompt，回复按 maxChars 截断', async () => {
  const h = await boot({ chunks: ['这是一段很长很长的回复内容'] })
  h.state.groupProfile = { note: '本群标签：吹水群；回复不超过 10 字', maxChars: 10 }

  const group = inbound('群里说一句')
  group.conversation = { kind: 'group', id: 'g1' }
  h.ctx.events.emit(EVENTS.inbound, group)
  await waitFor(() => h.ends.length === 1, 'turn/end')

  const system = h.state.requests[0]!.messages[0]!
  assert.match(system.content, /【本群规则】/)
  assert.match(system.content, /吹水群/)

  const sent = h.state.sent.at(-1)!.blocks[0] as { text: string }
  assert.ok(sent.text.length <= 10, `回复应被截断到 10 字，实际 ${sent.text.length}`)
  assert.match(sent.text, /…$/)
})

test('后置校验：命中禁止话题时改成拒绝话术', async () => {
  const h = await boot({ chunks: ['任务进度 70%，卡在发布脚本'] })
  h.state.groupProfile = { note: '本群标签：工作群', maxChars: 300, forbiddenTopics: ['task'] }

  const group = inbound('进度到哪了')
  group.conversation = { kind: 'group', id: 'g1' }
  h.ctx.events.emit(EVENTS.inbound, group)
  await waitFor(() => h.ends.length === 1, 'turn/end')

  const sent = h.state.sent.at(-1)!.blocks[0] as { text: string }
  assert.equal(sent.text, '这个在群里不方便说，私聊我。')
})

test('groupPolicyViolation：禁止话题与敏感信息', () => {
  const policy = { audiences: [], maxChars: 100, tone: 'casual' as const, proactive: false, forbiddenTopics: ['task', 'memory'] }
  assert.equal(agent.groupPolicyViolation('任务进度 70%', policy), 'task')
  assert.equal(agent.groupPolicyViolation('我记得你养狗', policy), 'memory')
  assert.equal(agent.groupPolicyViolation('电话 13800138000', policy), 'sensitive')
  assert.equal(agent.groupPolicyViolation('今天天气不错', policy), null)
})

test('身份闸：陌生账号回「未授权」，不进入模型', async () => {
  const h = await boot({ chunks: ['不该出现'] })
  h.state.identityRole = 'guest'
  h.ctx.events.emit(EVENTS.inbound, inbound('在吗'))
  await delay(30)
  assert.equal(h.state.requests.length, 0)
  const sent = h.state.sent.at(-1)!.blocks[0] as { text: string }
  assert.match(sent.text, /未授权/)
})
