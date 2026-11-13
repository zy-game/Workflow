/**
 * qm-agent 的回合行为测试。
 *
 * 用内存版 store、真实 service-channel + 假适配器、脚本化 llm 驱动真实的 cordis 容器，
 * 断言流式事件、上下文组装、落库（由 qm-history 负责）与渠道回投的实际内容。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from 'cordis'
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
import { LlmService, type ChatRequest, type ChatStreamChunk } from '@qingmei/core'
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
  withHarness?: boolean
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
  /** 不注册 llm，模拟「DSH 不可用且没有备用模型」 */
  withoutLlm?: boolean
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

class FakeDevices extends Service {
  constructor(ctx: Context) { super(ctx, 'devices') }
  async list() {
    return [{ id: 'dev-1', name: 'Windows 桌面', workspaces: [{ id: 'ws-sanguo', title: '重生三国之修仙传', path: 'E:\\\\重生三国之修仙传' }] }]
  }
}

class FakeTaskService extends Service {
  readonly created: any[] = []
  constructor(ctx: Context) { super(ctx, 'task') }
  async list() { return [] }
  async get() { return null }
  async create(input: any) {
    this.created.push(input)
    return { id: 'run_fake_1', title: input.title, status: 'queued', createdAt: new Date() }
  }
}

class FakeHarness extends Service {
  reply = ''
  readonly conversations: string[] = []
  constructor(ctx: Context) { super(ctx, 'harness') }
  async available() { return true }
  async *run(req: { conversationId?: string }) {
    this.conversations.push(String(req.conversationId ?? ''))
    if (this.reply) yield { type: 'text', text: this.reply }
    yield { type: 'done' }
  }
  async close() {}
}

class FakePsyche extends Service {
  constructor(ctx: Context) { super(ctx, 'psyche') }
  async context() { return '' }
  async journals() { return [{ day: '2026-11-12', text: '昨天整理了笔记。' }] }
  async relation() { return { events: [{ text: '一起完成：修好登录', kind: 'done' }] } }
  async writeJournal() { return { day: '2026-11-13', text: 'x' } }
  async writeNote() { return { day: '2026-11-13', kind: 'plan', text: 'x' } }
}
class FakePortrait extends Service {
  groupRules: { blocked?: string[]; note?: string } | null = null
  constructor(ctx: Context) { super(ctx, 'portrait') }
  async self() { return null }
  async person() { return null }
  async group(id: string) {
    return id === 'g1' && this.groupRules ? { name: '测试群', rules: this.groupRules } : null
  }
}

class FakeApproval extends Service {
  readonly created: any[] = []
  constructor(ctx: Context) { super(ctx, 'approval') }
  async create(input: any) {
    const request = { id: 'ap_' + String(this.created.length + 1), ...input, status: 'pending' }
    this.created.push(request)
    return request
  }
}

class FakeCost extends Service {
  constructor(ctx: Context) {
    super(ctx, 'cost')
  }
  async summary() {
    return { text: '【今日用量】余额 1.00 CNY' }
  }
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
  if (!options.withoutLlm) await ctx.plugin(fakes.FakeLlm)
  await ctx.plugin(fakes.FakeMemory)
  await ctx.plugin(fakes.FakeProfile)
  await ctx.plugin(fakes.FakeIdentity)
  await ctx.plugin(FakeCost)
  await ctx.plugin(FakeApproval)
  await ctx.plugin(FakePortrait)
  await ctx.plugin(FakePsyche)
  if (options.withHarness) await ctx.plugin(FakeHarness)
  await ctx.plugin(FakeDevices)
  await ctx.plugin(FakeTaskService)
  await ctx.plugin(historyPlugin)
  await ctx.plugin(agent, { persona: PERSONA, ...(options.agentConfig ?? {}) })
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
function endView(end: TurnEnd): Omit<TurnEnd, 'traceId' | 'latencyMs' | 'audience'> {
  assert.match(end.traceId, /^turn_/)
  assert.equal(typeof end.latencyMs, 'number')
  assert.equal(typeof end.steps, 'number')
  assert.equal(typeof end.tokensIn, 'number')
  assert.equal(typeof end.tokensOut, 'number')
  // 可见范围是给下游（会话凝练）用的，不影响回合本身的形状断言
  assert.ok(end.audience === 'owner' || end.audience === undefined || String(end.audience).startsWith('group:'))
  const { traceId: _traceId, latencyMs: _latencyMs, steps: _steps, tokensIn: _in, tokensOut: _out, deviceId: _device, audience: _audience, ...rest } = end
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
  assert.deepEqual(agent.inject, ['channel', 'gateway', 'memory'])
})

test('一次 inbound：chunk 事件、turn/end、store 两条消息、渠道回投', async () => {
  const h = await boot({ chunks: ['你好呀', '，我是青梅', '。'] })

  h.ctx.events.emit(EVENTS.inbound, inbound('在吗'))
  await waitFor(() => h.ends.length === 1, 'turn/end')

  // 流式事件
  assert.deepEqual(h.chunks.map((chunk) => chunk.text), ['你好呀', '，我是青梅', '。'])
  assert.ok(h.chunks.every((chunk) => chunk.sessionId === 's_conv-1'))

  // 网关广播与 chunk 事件同源同内容（另外会有 memory-recall 信号）
  const publishedChunks = h.state.published.filter((event) => event.type === 'chunk')
  assert.equal(publishedChunks.length, 3)
  assert.deepEqual(
    publishedChunks.map((event) => (event.data as TurnChunk).text),
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

  // 交给模型的上下文：system（人格 + 行动协议）+ 当前 user（无历史）
  assert.equal(h.state.requests.length, 1)
  const [systemMessage, ...restMessages] = h.state.requests[0].messages
  assert.match(String(systemMessage?.content), new RegExp(PERSONA))
  assert.match(String(systemMessage?.content), /【行动协议】/)
  assert.deepEqual(restMessages, [{ role: 'user', content: '在吗' }])

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
  assert.match(String(messages[0].content), new RegExp(PERSONA))
  assert.match(String(messages[0].content), /【行动协议】/)

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

test('DSH 不可用且没配 LLM：明确失败文案，不静默假装成功', async () => {
  const h = await boot({ chunks: [], withoutLlm: true })

  h.ctx.events.emit(EVENTS.inbound, inbound('帮我整理会议纪要'))
  await waitFor(() => h.ends.length === 1, 'turn/end')

  assert.equal(h.chunks.length, 0, '没有执行器就不该有流式输出')
  assert.equal(h.ends[0]?.ok, false)
  assert.match(h.ends[0]?.text ?? '', /没有可用的执行器/)
  const sent = h.state.sent.at(-1)
  const text = (sent?.blocks ?? []).map((block) => ('text' in block ? block.text : '')).join('')
  assert.match(text, /没有可用的执行器/, '用户要看到明确原因，而不是空白或假成功')
})

test('turn/end 带 audience：私聊 owner、群聊 group:<渠道>:<id>', async () => {
  const h = await boot({ chunks: ['好。'] })
  h.ctx.events.emit(EVENTS.inbound, inbound('在吗'))
  await waitFor(() => h.ends.length === 1, '私聊 turn/end')
  assert.equal(h.ends[0]?.audience, 'owner')

  const group = inbound('大家好')
  group.conversation = { kind: 'group', id: 'g1' }
  h.ctx.events.emit(EVENTS.inbound, group)
  await waitFor(() => h.ends.length === 2, '群聊 turn/end')
  assert.match(String(h.ends[1]?.audience), /^group:/)
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

  const [secondSystem, ...secondRest] = h.state.requests[1].messages
  assert.match(String(secondSystem?.content), new RegExp(PERSONA))
  assert.match(String(secondSystem?.content), /【行动协议】/)
  assert.deepEqual(secondRest, [
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
  assert.deepEqual(h.state.recalls.at(-1), { text: '我喜欢喝什么', audience: 'owner', sessionId: 's_conv-1', limit: 16 })

  const group = inbound('群里问一句')
  group.conversation = { kind: 'group', id: 'g1' }
  h.ctx.events.emit(EVENTS.inbound, group)
  await waitFor(() => h.ends.length === 2, '第二个 turn/end')
  assert.deepEqual(h.state.recalls.at(-1), { text: '群里问一句', audience: 'group:web:g1', sessionId: 's_g1', limit: 16 })
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

test('用量命令：直连 cost 服务，不调用模型', async () => {
  const h = await boot()
  h.ctx.events.emit(EVENTS.inbound, inbound('今日用量', 'owner'))
  await waitFor(() => h.ends.length === 1, 'turn/end')
  assert.equal(h.state.requests.length, 0, '用量命令不应调用模型')
  const sent = h.state.sent.at(-1)
  const text = (sent?.blocks ?? []).map((block) => ('text' in block ? block.text : '')).join('')
  assert.match(text, /今日用量/)
  assert.match(text, /余额/)
})

test('项目问题：唯一工作区先问确认，确认后派任务到设备工作区', async () => {
  const h = await boot()
  h.ctx.events.emit(EVENTS.inbound, inbound('三国项目进度怎么样，有 bug 吗', 'owner'))
  await waitFor(() => h.ends.length === 1, '第一轮')
  const ask = h.state.sent.at(-1)?.blocks?.map((block) => ('text' in block ? block.text : '')).join('') ?? ''
  assert.match(ask, /找到工作区/)
  assert.match(ask, /回复「派」/)

  h.ctx.events.emit(EVENTS.inbound, inbound('派', 'owner'))
  await waitFor(() => h.ends.length === 2, '第二轮')
  const created = (h.ctx.reflect.get('task', false) as unknown as { created: any[] }).created
  assert.equal(created.length, 1)
  assert.equal(created[0].target.executorId, 'device:dev-1')
  assert.equal(created[0].target.workspaceId, 'ws-sanguo')
  const reply = h.state.sent.at(-1)?.blocks?.map((block) => ('text' in block ? block.text : '')).join('') ?? ''
  assert.match(reply, /已派/)
})



test('任务完成回投：映射落库，重启后也能通知', async () => {
  const h = await boot()
  const store = h.ctx.reflect.get('store', false) as {
    collection(name: string): { insert(value: unknown): Promise<unknown> }
  }
  await store.collection('qm_pending_result').insert({
    id: 'run_persist',
    channel: 'web',
    conversation_id: 'conv-1',
    title: '三国检查',
    at: Date.now(),
  })
  h.ctx.events.emit(EVENTS.taskFinished, { id: 'run_persist', status: 'done', result: '发现两个 bug' } as never)
  await waitFor(() => h.state.sent.length === 1, '回投消息')
  const text = (h.state.sent[0].blocks ?? []).map((block) => ('text' in block ? block.text : '')).join('')
  assert.match(text, /三国检查/)
  assert.match(text, /发现两个 bug/)
})

test('行动块：明确任务直接建任务，正文不显示行动块', async () => {
  const h = await boot({
    chunks: [
      '好，我去整理。',
      '<qm-action>{"kind":"task.create","title":"整理资料","prompt":"整理明天出行的资料"}</qm-action>',
    ],
  })
  h.ctx.events.emit(EVENTS.inbound, inbound('帮我整理一下明天出行的资料', 'owner'))
  await waitFor(() => h.ends.length === 1, 'turn/end')
  const created = (h.ctx.reflect.get('task', false) as unknown as { created: any[] }).created
  assert.equal(created.length, 1)
  assert.equal(created[0].title, '整理资料')
  const text = (h.state.sent.at(-1)?.blocks ?? []).map((block) => ('text' in block ? block.text : '')).join('')
  assert.equal(text, '好，我去整理。')
  assert.ok(!text.includes('qm-action'))
})

test('行动块：模糊愿望走审批，不直接建任务', async () => {
  const h = await boot({
    chunks: [
      '听起来两个都不错。',
      '<qm-action>{"kind":"approval.request","action":"qm.plan","prompt":"要不要我帮你规划明天出行计划和路线？"}</qm-action>',
    ],
  })
  h.ctx.events.emit(EVENTS.inbound, inbound('明天想去看演唱会，但是又想去看电影', 'owner'))
  await waitFor(() => h.ends.length === 1, 'turn/end')
  const approval = (h.ctx.reflect.get('approval', false) as unknown as { created: any[] }).created
  assert.equal(approval.length, 1)
  assert.equal(approval[0].action, 'qm.plan')
  const tasks = (h.ctx.reflect.get('task', false) as unknown as { created: any[] }).created
  assert.equal(tasks.length, 0)
  const text = (h.state.sent.at(-1)?.blocks ?? []).map((block) => ('text' in block ? block.text : '')).join('')
  assert.equal(text, '听起来两个都不错。')
})

test('明确动作：审查项目进度直接派任务，不再多问一句', async () => {
  const h = await boot()
  h.ctx.events.emit(EVENTS.inbound, inbound('审查一下三国的进度', 'owner'))
  await waitFor(() => h.ends.length === 1, 'turn/end')
  const created = (h.ctx.reflect.get('task', false) as unknown as { created: any[] }).created
  assert.equal(created.length, 1)
  assert.equal(created[0].target.executorId, 'device:dev-1')
  const text = (h.state.sent.at(-1)?.blocks ?? []).map((block) => ('text' in block ? block.text : '')).join('')
  assert.match(text, /已派/)
})

test('任务结束：用同一个 owner 会话做一次内部思考，行动块直接建任务', async () => {
  const h = await boot({ withHarness: true })
  const harness = h.ctx.reflect.get('harness', false) as {
    reply: string
    conversations: string[]
  }
  harness.reply = '<qm-action>{"kind":"task.create","title":"跟进失败","prompt":"看看刚才失败的原因"}</qm-action>'
  h.ctx.events.emit(EVENTS.taskFinished, {
    id: 'run_failed',
    status: 'failed',
    title: '检查三国',
    error: 'timeout',
    result: null,
  } as never)
  await waitFor(() => (h.ctx.reflect.get('task', false) as unknown as { created: any[] }).created.length === 1, '内部任务')
  const created = (h.ctx.reflect.get('task', false) as unknown as { created: any[] }).created
  assert.equal(created[0].title, '跟进失败')
  assert.deepEqual(harness.conversations, ['s_owner'])
})

test('群画像：命中禁提词不发群，转 group.send 审批', async () => {
  const h = await boot({ chunks: ['三国项目现在在跑，进度正常。'] })
  const portrait = h.ctx.reflect.get('portrait', false) as { groupRules: { blocked: string[] } | null }
  portrait.groupRules = { blocked: ['三国'], note: '聊天群不能提项目' }
  h.ctx.events.emit(EVENTS.inbound, {
    platformMessageId: 'pm_group',
    channel: 'web',
    accountId: 'account-1',
    conversation: { kind: 'group', id: 'g1' },
    sender: { platformUserId: 'user-1', displayName: '测试用户' },
    blocks: [{ type: 'text', text: '三国那边怎么样' }],
    receivedAt: new Date(),
  })
  await waitFor(() => h.ends.length === 1, 'turn/end')
  const approval = (h.ctx.reflect.get('approval', false) as unknown as { created: any[] }).created
  assert.equal(approval.length, 1)
  assert.equal(approval[0].action, 'group.send')
  assert.equal(h.state.sent.length, 0, '命中禁提词不应直接发群')
})




test('extractActions：代码块里的自我目标也能解析并从正文移除', () => {
  const raw = [
    '今天先做三件小事。',
    '```action',
    '{"taskKind":"goal","origin":"self","title":"建立开口前的自检判据","detail":"写一份判据并在对话里执行"}',
    '```',
  ].join('\n')
  const parsed = agent.extractActions(raw)
  assert.equal(parsed.actions.length, 1)
  assert.equal(parsed.actions[0].kind, 'task.create')
  assert.equal(parsed.actions[0].taskKind, 'goal')
  assert.equal(parsed.actions[0].origin, 'self')
  assert.match(parsed.actions[0].prompt ?? '', /判据/)
  assert.ok(!parsed.visible.includes('taskKind'))
})

test('extractActions：XML 风格 action 也解析成自我目标', () => {
  const raw = '今天先归档旧笔记。\n<action taskKind="goal" origin="self">\nobjective: 把已结束的行程归档\n</action>'
  const parsed = agent.extractActions(raw)
  assert.equal(parsed.actions.length, 1)
  assert.equal(parsed.actions[0].taskKind, 'goal')
  assert.equal(parsed.actions[0].origin, 'self')
  assert.match(parsed.actions[0].prompt ?? '', /归档/)
  assert.ok(!parsed.visible.includes('<action'))
})

test('extractActions：代码块里的 key=value 目标也能解析', () => {
  const raw = '先做三件事。\n```action\ntaskKind=goal\norigin=self\nobjective=归档旧行程并写检查清单\n```\n好。'
  const parsed = agent.extractActions(raw)
  assert.equal(parsed.actions.length, 1)
  assert.equal(parsed.actions[0].taskKind, 'goal')
  assert.match(parsed.actions[0].prompt ?? '', /归档旧行程/)
  assert.ok(!parsed.visible.includes('taskKind'))
})

test('自我目标：goal 行动块建 proposed 任务，不直接执行', async () => {
  const h = await boot({
    chunks: [
      '我想给自己留个活。',
      '<action taskKind="goal" origin="self">objective: 整理旧笔记并建立索引</action>',
    ],
  })
  h.ctx.events.emit(EVENTS.inbound, inbound('今天还好吗', 'owner'))
  await waitFor(() => h.ends.length === 1, 'turn/end')
  const created = (h.ctx.reflect.get('task', false) as unknown as { created: any[] }).created
  assert.equal(created.length, 1)
  assert.equal(created[0].kind, 'goal')
  assert.equal(created[0].origin, 'self')
  assert.equal(created[0].status, 'proposed')
})

test('内部心跳：伪造入站事件走管线，但不发给用户', async () => {
  const h = await boot({ withHarness: true })
  const harness = h.ctx.reflect.get('harness', false) as { reply: string; conversations: string[] }
  harness.reply = '今日计划：先把笔记归档。'
  h.ctx.events.emit(EVENTS.inbound, {
    platformMessageId: 'ritual_test_plan',
    channel: 'web',
    accountId: 'ritual',
    conversation: { kind: 'dm', id: 'owner' },
    sender: { platformUserId: 'ritual', displayName: '青梅' },
    blocks: [{ type: 'text', text: '【晨间计划】写今天的计划' }],
    receivedAt: new Date(),
    internal: true,
    internalKind: 'plan',
  })
  await waitFor(() => harness.conversations.length > 0, 'harness 被调用')
  await delay(50)
  assert.equal(h.state.sent.length, 0, '内部事件不应发到用户')
  assert.equal(harness.conversations[0], 's_owner')
})


test('主动消息：晨间计划会发到 owner 聊天（免打扰关闭时）', async () => {
  const h = await boot({
    withHarness: true,
    chunks: [],
    agentConfig: { quietStart: 0, quietEnd: 0, proactiveMaxPerDay: 3 },
  })
  const harness = h.ctx.reflect.get('harness', false) as { reply: string; conversations: string[] }
  harness.reply = '早上好，今天先把笔记归档。'
  h.ctx.events.emit(EVENTS.inbound, {
    platformMessageId: 'ritual_plan_proactive',
    channel: 'web',
    accountId: 'ritual',
    conversation: { kind: 'dm', id: 'owner' },
    sender: { platformUserId: 'ritual', displayName: '青梅' },
    blocks: [{ type: 'text', text: '【晨间计划】写今天的计划' }],
    receivedAt: new Date(),
    internal: true,
    internalKind: 'plan',
  })
  await waitFor(() => h.state.sent.length > 0, '主动消息')
  const text = (h.state.sent[0].blocks[0] as { text?: string }).text ?? ''
  assert.match(text, /早上好/)
})

test('主动消息：空闲聊天也会发到 owner 聊天（免打扰关闭时）', async () => {
  const h = await boot({
    withHarness: true,
    chunks: [],
    agentConfig: { quietStart: 0, quietEnd: 0, proactiveMaxPerDay: 3 },
  })
  const harness = h.ctx.reflect.get('harness', false) as { reply: string; conversations: string[] }
  harness.reply = '在忙吗？刚看到窗外下雨了。'
  h.ctx.events.emit(EVENTS.inbound, {
    platformMessageId: 'idle_proactive',
    channel: 'web',
    accountId: 'idle',
    conversation: { kind: 'dm', id: 'owner' },
    sender: { platformUserId: 'idle', displayName: '青梅' },
    blocks: [{ type: 'text', text: '【主动聊天】主动说一句' }],
    receivedAt: new Date(),
    internal: true,
    internalKind: 'chat',
  })
  await waitFor(() => h.state.sent.length > 0, '主动聊天消息')
  assert.match((h.state.sent[0].blocks[0] as { text?: string }).text ?? '', /在忙吗/)
})

test('隔一阵回来：注入「最近的自己」，不靠文件交接', async () => {
  const h = await boot({ chunks: ['在。'] })
  h.ctx.events.emit(EVENTS.inbound, inbound('我回来了'))
  await waitFor(() => h.ends.length === 1, 'turn/end')
  const system = h.state.requests[0]!.messages[0]!
  assert.equal(system.role, 'system')
  assert.match(system.content, /最近的自己/)
  assert.match(system.content, /昨天整理了笔记/)
  assert.match(system.content, /一起完成：修好登录/)
})

test('心跳配额：每三次插一次自主活动，额度用完就停', () => {
  assert.equal(agent.heartbeatKindFor(0, 0, 12, 3), 'chat')
  assert.equal(agent.heartbeatKindFor(2, 0, 12, 3), 'play')
  assert.equal(agent.heartbeatKindFor(3, 1, 12, 3), 'chat')
  assert.equal(agent.heartbeatKindFor(12, 0, 12, 3), 'play')
  assert.equal(agent.heartbeatKindFor(12, 3, 12, 3), null)
})
