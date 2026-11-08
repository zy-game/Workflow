import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as historyPlugin from '@qingmei/qm-history'
import * as memoryPlugin from '../src/index.ts'
import { cosine, localEmbedding } from '../src/index.ts'
import type { MemoryRecord } from '@qingmei/core'

const ORIGIN: MemoryRecord['origin'] = { kind: 'channel', id: 's_owner' }

function fact(subject: string, predicate: string, object: string, confidence = 0.9): MemoryRecord {
  return { kind: 'fact', subject, predicate, object, confidence, sensitivity: 'private', origin: ORIGIN }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-mem-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'memory.db') })
  await storeFiber
  const historyFiber = ctx.plugin(historyPlugin)
  await historyFiber
  const memoryFiber = ctx.plugin(memoryPlugin, { limit: 5 })
  await memoryFiber
  return {
    ctx,
    async dispose() {
      await memoryFiber.dispose()
      await historyFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('ingest：写入事实，重复三元组合并而非新增', async () => {
  const { ctx, dispose } = await setup()
  try {
    const first = await ctx.memory.ingest([fact('主人', '下周三要去', '杭州')])
    assert.equal(first.created.length, 1)
    const second = await ctx.memory.ingest([fact('主人', '下周三要去', '杭州', 0.95)])
    assert.equal(second.created.length, 0)
    assert.equal(second.merged.length, 1)
  } finally {
    await dispose()
  }
})

test('recall：按关键词命中并格式化为可注入文本', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      fact('主人', '下周三要去', '杭州'),
      fact('主人', '喜欢', '手冲咖啡'),
    ])
    const hit = await ctx.memory.recall({ text: '我下周三去杭州，那边有什么好喝的' })
    assert.ok(hit.facts.length >= 1)
    assert.match(hit.text, /杭州/)
    assert.equal(hit.facts[0]?.subject, '主人')
  } finally {
    await dispose()
  }
})

test('recall：无关查询不返回任何事实', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([fact('主人', '喜欢', '手冲咖啡')])
    const miss = await ctx.memory.recall({ text: '今天天气怎么样' })
    assert.equal(miss.facts.length, 0)
    assert.equal(miss.text, '')
  } finally {
    await dispose()
  }
})

test('forget：软删除后不再召回，且可重复调用', async () => {
  const { ctx, dispose } = await setup()
  try {
    const created = await ctx.memory.ingest([fact('主人', '下周三要去', '杭州')])
    const id = created.created[0]!
    assert.equal(await ctx.memory.forget([id]), 1)
    assert.equal(await ctx.memory.forget([id]), 0)
    const after = await ctx.memory.recall({ text: '杭州' })
    assert.equal(after.facts.length, 0)
  } finally {
    await dispose()
  }
})

test('ingest：低于置信度阈值或字段不完整的记录被丢弃', async () => {
  const { ctx, dispose } = await setup()
  try {
    const result = await ctx.memory.ingest([
      fact('主人', '可能喜欢', '某种东西', 0.2),
      fact('', '喜欢', '咖啡'),
    ])
    assert.equal(result.created.length, 0)
    assert.equal(result.merged.length, 0)
  } finally {
    await dispose()
  }
})

test('ingest：同一 subject+predicate 的新值让旧值有效期末尾（软失效，不删除）', async () => {
  const { ctx, dispose } = await setup()
  try {
    const cat = await ctx.memory.ingest([fact('主人', '养', '猫')])
    const catId = cat.created[0]!

    const dog = await ctx.memory.ingest([fact('主人', '养', '狗')])
    assert.equal(dog.created.length, 1, '新值应新增一行')

    // 旧值仍在库里，只是 valid_to 被置位
    const rows = await ctx.store.collection('qm_mem_fact').find({})
    const catRow = rows.find((row) => row.id === catId)
    assert.ok(catRow, '旧事实不应被删除')
    assert.equal(typeof catRow.valid_to, 'number')
    assert.ok(catRow.valid_to > 0)

    const hit = await ctx.memory.recall({ text: '我养什么' })
    assert.equal(hit.facts.length, 1)
    assert.equal(hit.facts[0]?.object, '狗')
  } finally {
    await dispose()
  }
})

test('recall：群聊视口不注入 private，也不注入别的 audience', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      { ...fact('主人', '喜欢', '手冲咖啡'), sensitivity: 'private' },
      { ...fact('项目:青梅', '状态', '测试全绿'), sensitivity: 'public', audience: 'group:g1' },
      { ...fact('主人', '手机号', '138'), sensitivity: 'secret' },
    ])

    const owner = await ctx.memory.recall({ text: '咖啡 测试 手机号' })
    assert.deepEqual(
      owner.facts.map((item) => item.object),
      ['手冲咖啡'],
      '主人视口只给 audience=owner 的非 secret 记忆（secret 永不注入 prompt）',
    )

    const group = await ctx.memory.recall({ text: '咖啡 测试 手机号', audience: 'group:g1' })
    assert.deepEqual(
      group.facts.map((item) => item.object),
      ['测试全绿'],
      '群聊只给该群 public 事实，private/secret 零注入',
    )

    const otherGroup = await ctx.memory.recall({ text: '测试', audience: 'group:g2' })
    assert.equal(otherGroup.facts.length, 0, '别的群看不到 g1 的记忆')
  } finally {
    await dispose()
  }
})

test('profile：按 subject 聚合、只含有效 owner 事实，群聊视口为空', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      fact('主人', '喜欢', '手冲咖啡', 0.9),
      fact('主人', '养', '猫', 0.8),
      fact('主人', '养', '狗', 0.95),
      fact('工作', '在', '腾讯', 0.7),
    ])

    const profile = await ctx.memory.profile({ audience: 'owner' })
    const bySubject = new Map(profile.map((entry) => [entry.subject, entry.facts.map((item) => `${item.predicate}${item.object}`)]))
    assert.ok(bySubject.get('主人')?.includes('养狗'))
    assert.equal(bySubject.get('主人')?.some((item) => item.includes('猫')), false, '被覆盖的旧值不应出现')
    assert.ok(bySubject.get('工作')?.includes('在腾讯'))

    assert.deepEqual(await ctx.memory.profile({ audience: 'group:g1' }), [])
  } finally {
    await dispose()
  }
})

test('联想召回：共同出现后建立突触，单关键词也能带回邻居', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      fact('主人', '养', '狗'),
      fact('狗', '叫', '豆豆'),
    ])
    const first = await ctx.memory.recall({ text: '主人 狗 豆豆' })
    assert.equal(first.facts.length, 2, '两个事实都应被召回')
    await new Promise((resolve) => setTimeout(resolve, 30))

    const second = await ctx.memory.recall({ text: '我养什么' })
    const objects = second.facts.map((item) => item.object)
    assert.ok(objects.includes('狗'), '关键词命中养狗')
    assert.ok(objects.includes('豆豆'), '通过突触扩散带回豆豆')
  } finally {
    await dispose()
  }
})

test('召回打分：同相似度时显著度高的排前面', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      { ...fact('主人', '喜欢', '咖啡'), salience: 0.9 },
      { ...fact('同事', '喜欢', '咖啡'), salience: 0.1 },
    ])
    const hit = await ctx.memory.recall({ text: '咖啡' })
    assert.equal(hit.facts[0]?.subject, '主人', '显著度高的应先召回')
  } finally {
    await dispose()
  }
})

test('多跳扩散：两跳外的邻居也能被带回', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      fact('主人', '养', '狗'),
      fact('狗', '叫', '豆豆'),
      fact('豆豆', '玩', '玩具'),
    ])
    await ctx.memory.recall({ text: '主人 狗 豆豆' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await ctx.memory.recall({ text: '狗 豆豆 玩具' })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const hit = await ctx.memory.recall({ text: '我养什么', limit: 10 })
    const objects = hit.facts.map((item) => item.object)
    assert.ok(objects.includes('狗'), '一跳：关键词命中')
    assert.ok(objects.includes('豆豆'), '两跳：狗 → 豆豆')
    assert.ok(objects.includes('玩具'), '三跳：豆豆 → 玩具')
  } finally {
    await dispose()
  }
})

test('剪枝：弱且长期未共同激活的突触被删除，强突触保留', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([fact('主人', '养', '狗'), fact('狗', '叫', '豆豆')])
    const store = (ctx as unknown as { reflect: { get(name: string, required: false): unknown } }).reflect.get('store', false) as {
      collection(name: string): {
        insert(value: Record<string, unknown>): Promise<unknown>
        get(id: string): Promise<unknown>
      }
    }
    const synapses = store.collection('qm_mem_synapse')
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000
    await synapses.insert({ id: 'weak', from_id: 'a', to_id: 'b', kind: 'associative', weight: 0.01, co_activated: 1, last_fired_at: old })
    await synapses.insert({ id: 'strong', from_id: 'c', to_id: 'd', kind: 'associative', weight: 0.8, co_activated: 1, last_fired_at: old })

    const memory = ctx.memory as unknown as { prune(now?: number): Promise<number> }
    const removed = await memory.prune()
    assert.equal(removed, 1)
    assert.equal(await synapses.get('weak'), null)
    assert.ok(await synapses.get('strong'))
  } finally {
    await dispose()
  }
})

test('工作记忆：同一会话上一轮点亮的事实，下一轮无关键词也能召回', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([fact('主人', '养', '狗')])

    const first = await ctx.memory.recall({ text: '狗', sessionId: 's1' })
    assert.equal(first.facts.length, 1)

    const next = await ctx.memory.recall({ text: '它叫什么', sessionId: 's1' })
    assert.ok(next.facts.some((item) => item.object === '狗'), '工作记忆应带回上一轮的事实')

    const other = await ctx.memory.recall({ text: '它叫什么', sessionId: 's2' })
    assert.equal(other.facts.length, 0, '其他会话不继承')
  } finally {
    await dispose()
  }
})

test('巩固：每个 subject 保留价值最高的 5 条，其余软压缩不删除', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest(
      Array.from({ length: 8 }, (_, index) => fact('主人', `偏好${index}`, `值${index}`, 0.6)),
    )
    const report = await ctx.memory.consolidate()
    assert.equal(report.scanned, 8)
    assert.equal(report.compressed.length, 3)

    const hit = await ctx.memory.recall({ text: '偏好', limit: 10 })
    assert.equal(hit.facts.length, 5, '召回只剩 5 条有效事实')

    const store = (ctx as unknown as { reflect: { get(name: string, required: false): unknown } }).reflect.get('store', false) as {
      collection(name: string): { find(): Promise<{ valid_to: number | null }[]> }
    }
    const rows = await store.collection('qm_mem_fact').find()
    assert.equal(rows.length, 8, '压缩是软失效，不删除')
    assert.equal(rows.filter((row) => row.valid_to !== null).length, 3)
  } finally {
    await dispose()
  }
})

test('多源印证：不同来源提升置信度，同一来源重复不重复加权', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([{ ...fact('主人', '喜欢', '咖啡', 0.7), origin: { kind: 'channel', id: 'm1' } }])
    const store = (ctx as unknown as { reflect: { get(name: string, required: false): unknown } }).reflect.get('store', false) as {
      collection(name: string): { find(): Promise<Record<string, unknown>[]> }
    }
    const facts = store.collection('qm_mem_fact')
    const provenance = store.collection('qm_mem_provenance')

    const first = (await facts.find())[0]!.confidence as number
    await ctx.memory.ingest([{ ...fact('主人', '喜欢', '咖啡', 0.7), origin: { kind: 'harness', id: 'task:1' } }])
    const second = (await facts.find())[0]!.confidence as number
    assert.ok(second > first, '第二来源应提升置信度')

    await ctx.memory.ingest([{ ...fact('主人', '喜欢', '咖啡', 0.7), origin: { kind: 'channel', id: 'm1' } }])
    const third = (await facts.find())[0]!.confidence as number
    assert.equal(third, second, '同一来源重复上报不应继续加权')

    assert.equal((await provenance.find()).length, 2, '两个来源各一条 provenance')
  } finally {
    await dispose()
  }
})

test('幂等事件：同一 idempotencyKey 只应用一次', async () => {
  const { ctx, dispose } = await setup()
  try {
    const record = { ...fact('主人', '喜欢', '咖啡', 0.8), idempotencyKey: 'evt_1' }
    await ctx.memory.ingest([record])
    await ctx.memory.ingest([record])

    const store = (ctx as unknown as { reflect: { get(name: string, required: false): unknown } }).reflect.get('store', false) as {
      collection(name: string): { find(): Promise<Record<string, unknown>[]> }
    }
    assert.equal((await store.collection('qm_mem_fact').find()).length, 1)
    assert.equal((await store.collection('qm_memory_event').find()).length, 1)
    assert.equal((await store.collection('qm_mem_provenance').find()).length, 1)
  } finally {
    await dispose()
  }
})

test('summarize：从 qm_message 生成会话摘要；episode 单独落库', async () => {
  const { ctx, dispose } = await setup()
  try {
    const store = ctx.reflect.get('store', false) as {
      collection: (name: string) => { insert: (row: Record<string, unknown>) => Promise<unknown>; find: () => Promise<Record<string, unknown>[]> }
    }
    const messages = store.collection('qm_message')
    const now = Date.now()
    await messages.insert({ id: 'm1', role: 'user', text: '明天去杭州出差', session_id: 's_chat', created_at: now - 3000 })
    await messages.insert({ id: 'm2', role: 'assistant', text: '好的，我记下了', session_id: 's_chat', created_at: now - 2000 })
    await messages.insert({ id: 'm3', role: 'user', text: '提醒我带身份证', session_id: 's_chat', created_at: now - 1000 })

    const summary = await ctx.memory.summarize('chat')
    assert.match(summary, /最近 2 轮/)
    assert.match(summary, /杭州出差/)
    assert.match(summary, /带身份证/i)

    const created = await ctx.memory.ingest([
      {
        kind: 'episode',
        subject: 'session:chat',
        predicate: 'summary',
        object: '用户要去杭州出差，并提醒带身份证',
        confidence: 0.9,
        sensitivity: 'private',
        origin: ORIGIN,
      },
    ])
    assert.equal(created.created.length, 1)
    const episodes = await store.collection('qm_mem_episode').find()
    assert.equal(episodes.length, 1)
    assert.match(String((episodes[0] as { summary: string }).summary), /杭州/)
  } finally {
    await dispose()
  }
})

test('记忆页：listFacts / updateFact 支持人工修正', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([fact('主人', '喜欢', '黑咖啡')])
    const listed = await ctx.memory.listFacts()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.object, '黑咖啡')

    const updated = await ctx.memory.updateFact(listed[0]!.id, { object: '加奶咖啡', salience: 0.9 })
    assert.equal(updated, true)
    const after = await ctx.memory.listFacts()
    assert.equal(after[0]?.object, '加奶咖啡')
    assert.equal(after[0]?.salience, 0.9)
  } finally {
    await dispose()
  }
})

test('本地向量：归一化、相似度，以及无关键词时的向量召回', async () => {
  const a = localEmbedding('black coffee')
  const b = localEmbedding('black coffee')
  const c = localEmbedding('杭州出差')
  assert.ok(cosine(a, b) > 0.999)
  assert.ok(cosine(a, c) < 0.5)

  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([fact('主人', 'drinks', 'coffee')])
    const result = await ctx.memory.recall({ text: 'coffees', limit: 5 })
    assert.equal(result.facts.length, 1, 'bigram 向量应在无完整词命中时召回')
  } finally {
    await dispose()
  }
})

test('远端 embedding 服务存在时优先使用其向量', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-mem-emb-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'mem.db') })
  await storeFiber
  const { EmbeddingService } = await import('@qingmei/core')
  class FakeEmbedding extends EmbeddingService {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => (text.includes('coffee') ? [1, 0, 0] : [0, 1, 0]))
    }
  }
  new FakeEmbedding(ctx)
  const memoryFiber = ctx.plugin(memoryPlugin)
  await memoryFiber
  try {
    await ctx.memory.ingest([fact('主人', 'drinks', 'coffee')])
    const store = ctx.reflect.get('store', false) as { collection: (name: string) => { find: (q?: object) => Promise<Record<string, unknown>[]> } }
    const rows = await store.collection('qm_mem_fact').find({})
    const vector = JSON.parse(String(rows[0]?.embedding_json)) as number[]
    assert.deepEqual(vector, [1, 0, 0])
  } finally {
    await memoryFiber.dispose()
    await storeFiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('情节巩固：同会话同日多条 episode 合并成一条摘要', async () => {
  const { ctx, dispose } = await setup()
  try {
    for (const text of ['讨论了杭州行程', '确认了酒店', '需要带身份证']) {
      await ctx.memory.ingest([
        {
          kind: 'episode',
          subject: 'session:chat',
          predicate: 'summary',
          object: text,
          confidence: 0.9,
          sensitivity: 'private',
          origin: ORIGIN,
        },
      ])
    }
    const report = await ctx.memory.consolidateEpisodes()
    assert.equal(report.scanned, 3)
    assert.equal(report.merged, 3)
    const store = ctx.reflect.get('store', false) as {
      collection: (name: string) => { find: (q?: object) => Promise<Record<string, unknown>[]> }
    }
    const episodes = await store.collection('qm_mem_episode').find({})
    const merged = episodes.find((row) => row.origin_kind === 'self' && row.origin_id === 'consolidate')
    assert.ok(merged, '应生成合并后的情节')
    assert.match(String(merged.summary), /杭州/)
    assert.equal(episodes.filter((row) => row.archived_at).length, 3)
  } finally {
    await dispose()
  }
})

test('设备域：同设备事实召回加权', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      { ...fact('主人', '在桌面端说', '今天写代码'), device: 'desktop' },
      { ...fact('主人', '在网页端说', '今天写代码'), device: 'web' },
    ])
    const result = await ctx.memory.recall({ text: '今天写代码', device: 'desktop' })
    assert.equal(result.facts.length, 2)
    assert.equal(result.facts[0]?.device, 'desktop')
  } finally {
    await dispose()
  }
})

test('情节巩固：同会话跨日相似情节按 embedding 合并', async () => {
  const { ctx, dispose } = await setup()
  try {
    const store = ctx.reflect.get('store', false) as {
      collection: (name: string) => { insert: (row: Record<string, unknown>) => Promise<unknown> }
    }
    const episodes = store.collection('qm_mem_episode')
    const now = Date.now()
    for (const [days, summary] of [
      [1, '杭州出差行程确认'],
      [2, '杭州出差酒店确认'],
    ] as const) {
      await episodes.insert({
        id: `ep_day_${days}`,
        kind: 'episode',
        session_id: 'chat',
        summary,
        subject: 'session:chat',
        predicate: 'summary',
        audience: 'owner',
        salience: 0.5,
        confidence: 0.9,
        origin_kind: 'channel',
        origin_id: 'test',
        created_at: now - days * 24 * 60 * 60 * 1000,
        archived_at: null,
      })
    }
    const report = await ctx.memory.consolidateEpisodes()
    assert.equal(report.groups, 1)
    assert.equal(report.merged, 2)
  } finally {
    await dispose()
  }
})

test('召回解释：fact 带命中信号，便于记忆页解释', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([fact('主人', '养了', '一只叫豆豆的狗')])
    const result = await ctx.memory.recall({ text: '豆豆' })
    assert.ok(result.facts.length > 0)
    assert.ok((result.facts[0]!.reasons ?? []).length > 0)
    assert.ok(result.facts[0]!.reasons!.some((reason) => reason.startsWith('关键词')))
    assert.ok(result.facts[0]!.reasons!.includes('FTS'))
  } finally {
    await dispose()
  }
})
