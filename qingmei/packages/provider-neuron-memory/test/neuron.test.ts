import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as historyPlugin from '@qingmei/qm-history'
import * as memoryPlugin from '../src/index.ts'
import { EmbeddingService } from '@qingmei/core'
import { cleanEntityName, tokenize } from '../src/index.ts'

const ORIGIN = { kind: 'channel' as const, id: 's_neuron' }

class FakeEmbedding extends EmbeddingService {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      if (/咖啡|饮料|苦/.test(text)) return [1, 0, 0]
      if (/茶|叶子|泡的水/.test(text)) return [0, 1, 0]
      if (/花生|坚果/.test(text)) return [0, 0, 1]
      return [0.2, 0.2, 0.2]
    })
  }
}

async function setup(config: Record<string, unknown> = {}, embedding = false) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-neuron-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'memory.db') })
  await storeFiber
  const historyFiber = ctx.plugin(historyPlugin)
  await historyFiber
  if (embedding) new FakeEmbedding(ctx)
  const memoryFiber = ctx.plugin(memoryPlugin, { limit: 5, ticks: 4, ...config })
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

test('tokenize：中文单字/双字与英文词都能成为感知单元', () => {
  const tokens = tokenize('主人喜欢手冲咖啡 pnpm')
  assert.ok(tokens.includes('咖啡'))
  assert.ok(tokens.includes('手冲'))
  assert.ok(tokens.includes('主人'))
  assert.ok(tokens.includes('pnpm'))
})

test('ingest：事实会生成神经元与绑定，不写 FTS', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      { kind: 'fact', subject: '主人', predicate: '喜欢', object: '手冲咖啡', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
    ])
    const store = ctx.reflect.get('store', false) as {
      collection(name: string): { find(): Promise<Record<string, unknown>[]> }
    }
    const neurons = await store.collection('qm_neuron').find()
    const bindings = await store.collection('qm_neuron_binding').find()
    assert.ok(neurons.length >= 3)
    assert.ok(bindings.length >= 3)
    assert.equal((await store.collection('qm_fact_fts').find?.())?.length ?? 0, 0)
  } finally {
    await dispose()
  }
})

test('Hebbian：共同激活会留下点触', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      { kind: 'fact', subject: '主人', predicate: '喜欢', object: '手冲咖啡', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
    ])
    const hit = await ctx.memory.recall({ text: '手冲咖啡' })
    assert.ok(hit.facts.length >= 1)
    const store = ctx.reflect.get('store', false) as {
      collection(name: string): { find(): Promise<Record<string, unknown>[]> }
    }
    const synapses = await store.collection('qm_synapse').find()
    assert.ok(synapses.length > 0)
    assert.ok(synapses.every((row) => Number(row.weight) > 0))
  } finally {
    await dispose()
  }
})

test('episode：事件文本会作为可召回记忆', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      {
        kind: 'episode',
        subject: 'session:s1',
        predicate: '说',
        object: '明天去杭州出差，记得带身份证',
        confidence: 0.95,
        sensitivity: 'private',
        origin: ORIGIN,
      },
    ])
    const hit = await ctx.memory.recall({ text: '杭州出差' })
    assert.ok(hit.facts.some((item) => item.kind === 'episode' && item.object.includes('杭州')))
  } finally {
    await dispose()
  }
})

test('沉淀：重复共现形成概念神经元并参与召回', async () => {
  const { ctx, dispose } = await setup()
  try {
    for (const text of ['早上喝手冲咖啡', '下午也喝手冲咖啡', '手冲咖啡很好喝']) {
      await ctx.memory.ingest([{
        kind: 'episode',
        subject: 'session:s1',
        predicate: '说',
        object: text,
        confidence: 0.9,
        sensitivity: 'private',
        origin: ORIGIN,
      }])
    }
    const report = await (ctx.memory as unknown as { consolidate(): Promise<{ concepts: number }> }).consolidate()
    assert.ok(report.concepts >= 1)
    const stats = await (ctx.memory as unknown as { stats(): Promise<{ concepts: number }> }).stats()
    assert.ok(stats.concepts >= 1)
    const hit = await ctx.memory.recall({ text: '手冲' })
    assert.ok(hit.facts.some((item) => item.kind === 'episode'))
  } finally {
    await dispose()
  }
})

test('概念变更：提案、评估、应用、回滚', async () => {
  const { ctx, dispose } = await setup()
  try {
    for (const text of ['手冲咖啡很好喝', '手冲咖啡早上喝', '手冲咖啡下午喝']) {
      await ctx.memory.ingest([{ kind: 'episode', subject: 'session:s1', predicate: '说', object: text, confidence: 0.9, sensitivity: 'private', origin: ORIGIN }])
    }
    await (ctx.memory as unknown as { consolidate(): Promise<unknown> }).consolidate()
    const memory = ctx.memory as unknown as {
      conceptProposals(): Promise<Array<{ id: string; kind: string; sourceId?: string; targetId?: string }>>
      evaluateConceptChange(p: unknown): Promise<{ canApply: boolean } | null>
      applyConceptChange(p: unknown): Promise<{ changeId: string } | null>
      rollbackConceptChange(id: string): Promise<boolean>
      stats(): Promise<{ concepts: number }>
    }
    const proposals = await memory.conceptProposals()
    const merge = proposals.find((item) => item.kind === 'merge')
    assert.ok(merge, '重复 episode 应产生合并提案')
    const evaluation = await memory.evaluateConceptChange(merge)
    assert.equal(evaluation?.canApply, true)
    const before = (await memory.stats()).concepts
    const applied = await memory.applyConceptChange(merge)
    assert.ok(applied?.changeId)
    assert.ok((await memory.stats()).concepts < before)
    assert.equal(await memory.rollbackConceptChange(applied!.changeId), true)
    assert.equal((await memory.stats()).concepts, before)
  } finally {
    await dispose()
  }
})

test('概念 split：跨 session 过载概念可安全拆分并回滚', async () => {
  const { ctx, dispose } = await setup()
  try {
    for (let i = 0; i < 9; i += 1) {
      await ctx.memory.ingest([{
        kind: 'episode',
        subject: i < 4 ? 'session:s1' : 'session:s2',
        predicate: '说',
        object: `手冲咖啡第${i}次`,
        confidence: 0.9,
        sensitivity: 'private',
        origin: ORIGIN,
      }])
    }
    const memory = ctx.memory as unknown as {
      consolidate(): Promise<unknown>
      conceptProposals(): Promise<Array<{ id: string; kind: string; conceptId?: string; payload?: { groups?: string[][] } }>>
      evaluateConceptChange(p: unknown): Promise<{ canApply: boolean } | null>
      applyConceptChange(p: unknown): Promise<{ changeId: string } | null>
      rollbackConceptChange(id: string): Promise<boolean>
      stats(): Promise<{ concepts: number }>
    }
    await memory.consolidate()
    const split = (await memory.conceptProposals()).find((item) => item.kind === 'split' && (item.payload?.groups?.length ?? 0) >= 2)
    assert.ok(split, '跨 session 概念应产生 split 提案')
    assert.equal((await memory.evaluateConceptChange(split))?.canApply, true)
    const before = (await memory.stats()).concepts
    const applied = await memory.applyConceptChange(split)
    assert.ok(applied?.changeId)
    assert.ok((await memory.stats()).concepts > before)
    assert.equal(await memory.rollbackConceptChange(applied!.changeId), true)
    assert.equal((await memory.stats()).concepts, before)
  } finally {
    await dispose()
  }
})

test('自动沉淀：低风险 merge 自动应用且可回滚', async () => {
  const { ctx, dispose } = await setup({ autoApplyConcepts: true })
  try {
    for (const text of ['手冲咖啡好喝', '手冲咖啡早上喝', '手冲咖啡下午喝']) {
      await ctx.memory.ingest([{ kind: 'episode', subject: 'session:s1', predicate: '说', object: text, confidence: 0.9, sensitivity: 'private', origin: ORIGIN }])
    }
    const memory = ctx.memory as unknown as {
      consolidate(): Promise<{ autoApplied: string | null }>
      conceptChanges(): Promise<Array<{ id: string; status: string }>>
      rollbackConceptChange(id: string): Promise<boolean>
    }
    const report = await memory.consolidate()
    assert.ok(report.autoApplied, '低风险概念变更应自动应用')
    const changes = await memory.conceptChanges()
    assert.ok(changes.some((item) => item.status === 'applied'))
    assert.equal(await memory.rollbackConceptChange(report.autoApplied!), true)
  } finally {
    await dispose()
  }
})

test('自动沉淀：重复跨 session 概念可自动 split 并回滚', async () => {
  const { ctx, dispose } = await setup({ autoApplyConcepts: true })
  try {
    for (let i = 0; i < 9; i += 1) {
      await ctx.memory.ingest([{ kind: 'episode', subject: i < 4 ? 'session:s1' : 'session:s2', predicate: '说', object: `手冲咖啡第${i}次`, confidence: 0.9, sensitivity: 'private', origin: ORIGIN }])
    }
    const memory = ctx.memory as unknown as {
      consolidate(): Promise<{ autoApplied: string | null }>
      conceptChanges(): Promise<Array<{ id: string; kind: string; status: string }>>
      rollbackConceptChange(id: string): Promise<boolean>
    }
    const report = await memory.consolidate()
    assert.ok(report.autoApplied)
    const change = (await memory.conceptChanges()).find((item) => item.id === report.autoApplied)
    assert.equal(change?.kind, 'split')
    assert.equal(await memory.rollbackConceptChange(report.autoApplied!), true)
  } finally {
    await dispose()
  }
})

test('stats：图规模可用于自治观察', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      { kind: 'fact', subject: '主人', predicate: '养', object: '猫', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
    ])
    const stats = await (ctx.memory as unknown as { stats(): Promise<Record<string, number>> }).stats()
    assert.ok(stats.neurons >= 2)
    assert.ok(stats.facts >= 1)
  } finally {
    await dispose()
  }
})

test('recall：时间窗过滤只返回窗口内的记忆', async () => {
  const { ctx, dispose } = await setup()
  try {
    const old = new Date(Date.now() - 60 * 86_400_000)
    await ctx.memory.ingest([
      { kind: 'fact', subject: '主人', predicate: '喜欢', object: '手冲咖啡', confidence: 0.9, sensitivity: 'private', origin: ORIGIN, occurredAt: old },
      { kind: 'fact', subject: '主人', predicate: '住在', object: '杭州', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
    ])
    const recent = await ctx.memory.recall({ text: '咖啡', since: new Date(Date.now() - 30 * 86_400_000) })
    assert.ok(!recent.text.includes('咖啡'), '60 天前的事实不该出现在最近 30 天里')
    const all = await ctx.memory.recall({ text: '咖啡' })
    assert.ok(all.text.includes('咖啡'))
  } finally {
    await dispose()
  }
})


test('consolidateEpisodes：按天/周/月压缩，保护高 salience 与决定类原文', async () => {
  const { ctx, dispose } = await setup()
  try {
    const now = new Date('2026-11-12T04:00:00Z')
    const ingest = (text: string, daysAgo: number, salience = 0.4) =>
      ctx.memory.ingest([
        {
          kind: 'episode',
          subject: 'session:s1',
          predicate: '对话',
          object: text,
          confidence: 0.8,
          salience,
          sensitivity: 'private',
          audience: 'owner',
          origin: { kind: 'channel', id: 's1' },
          occurredAt: new Date(now.getTime() - daysAgo * 86_400_000),
        },
      ])
    await ingest('讨论记忆分层', 31)
    await ingest('讨论了时间窗', 31)
    await ingest('三周前的对话', 95)
    await ingest('三个月前的对话', 400)
    await ingest('决定用 SQLite', 31)
    await ingest('最近的事', 1)
    await ingest('上周的细节', 8)
    await ingest('高显著细节', 100, 0.85)

    const report = await ctx.memory.consolidateEpisodes({ now })
    assert.ok(report.groups >= 3, `至少生成日/周/月三种摘要，实际 ${report.groups}`)
    assert.ok(report.merged >= 4)

    const store = ctx.reflect.get('store', false) as {
      collection(name: string): { find(): Promise<Record<string, unknown>[]> }
    }
    const rows = await store.collection('qm_episode').find()
    const summaries = rows.filter((row) => row.origin_kind === 'summary')
    assert.ok(summaries.length >= 3)
    assert.ok(summaries.every((row) => String(row.provenance ?? '').length > 0), '摘要要带来源')
    const protectedRow = rows.find((row) => row.text === '决定用 SQLite')
    assert.equal(protectedRow?.valid_to ?? null, null, '决定类原文不能被压缩')
    const recent = rows.find((row) => row.text === '最近的事')
    assert.equal(recent?.valid_to ?? null, null)
    const lastWeek = rows.find((row) => row.text === '上周的细节')
    assert.equal(lastWeek?.valid_to ?? null, null, '30 天内逐轮细节不压缩')
    const salient = rows.find((row) => row.text === '高显著细节')
    assert.equal(salient?.valid_to ?? null, null, 'salience ≥ 0.8 的逐轮细节永不被压缩')

    const again = await ctx.memory.consolidateEpisodes({ now })
    assert.equal(again.groups, 0, '重复跑不产生重复摘要')

    const recalled = await ctx.memory.recall({ text: '记忆分层' })
    assert.ok(recalled.text.includes('日摘要'), '压缩后的摘要仍可召回')
  } finally {
    await dispose()
  }
})

test('关系图：事实落边、两跳邻居、时间窗过滤，召回带「相关」', async () => {
  const { ctx, dispose } = await setup()
  try {
    const old = new Date(Date.now() - 90 * 86_400_000)
    await ctx.memory.ingest([
      { kind: 'fact', subject: '主人', predicate: '喜欢', object: '手冲咖啡', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
      { kind: 'fact', subject: '手冲咖啡', predicate: '产地', object: '云南', confidence: 0.8, sensitivity: 'public', origin: ORIGIN },
      { kind: 'fact', subject: '主人', predicate: '住在', object: '杭州', confidence: 0.9, sensitivity: 'private', origin: ORIGIN, occurredAt: old },
    ])

    const one = await ctx.memory.neighbors('主人', { depth: 1 })
    assert.ok(one.text.includes('主人 —喜欢→ 手冲咖啡'), one.text)
    assert.ok(!one.text.includes('云南'), '一跳不该出现两跳的边')

    const two = await ctx.memory.neighbors('主人', { depth: 2, limit: 20 })
    assert.ok(two.text.includes('云南'), two.text)

    const recent = await ctx.memory.neighbors('主人', { depth: 2, since: new Date(Date.now() - 30 * 86_400_000) })
    assert.ok(!recent.text.includes('杭州'), '90 天前的边不该出现在最近 30 天')

    const recalled = await ctx.memory.recall({ text: '咖啡' })
    assert.match(recalled.text, /【相关】/)
    assert.match(recalled.text, /手冲咖啡/)
  } finally {
    await dispose()
  }
})

test('cleanEntityName：长句、带标点、否定条目都不算实体', () => {
  assert.equal(cleanEntityName('手冲咖啡'), '手冲咖啡')
  assert.equal(cleanEntityName('不实：主人于 2026-11-06 明确否认，主人不养狗'), null)
  assert.equal(cleanEntityName('一个很长很长而且带标点，完全不像实体的句子'), null)
  assert.equal(cleanEntityName('否认养狗'), null)
  assert.equal(cleanEntityName('   '), null)
})

test('embedding：零字面重叠也能召回同义事实', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-neuron-emb-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'memory.db') })
  await storeFiber
  const historyFiber = ctx.plugin(historyPlugin)
  await historyFiber
  new FakeEmbedding(ctx)
  const memoryFiber = ctx.plugin(memoryPlugin, { limit: 5, ticks: 4 })
  await memoryFiber
  try {
    await ctx.memory.ingest([
      { kind: 'fact', subject: '主人', predicate: '喜欢', object: '手冲咖啡', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
      { kind: 'fact', subject: '主人', predicate: '爱喝', object: '龙井茶', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
    ])
    const dbgStore = ctx.reflect.get('store', false)
    const dbgRows = await dbgStore.collection('qm_mem_fact').find({})
    const recalled = await ctx.memory.recall({ text: '早上喝的那种黑色苦饮料', limit: 5 })
    assert.ok(recalled.text.includes('手冲咖啡'), recalled.text)
  } finally {
    await memoryFiber.dispose()
    await historyFiber.dispose()
    await storeFiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})




test('向量元数据与查询缓存：事实/事件都记 model，重复问题不再调 embedding', async () => {
  class CountingEmbedding extends EmbeddingService {
    calls = 0
    modelName() {
      return 'fake-model'
    }
    async embed(texts: string[]): Promise<number[][]> {
      this.calls += 1
      return texts.map(() => [1, 0, 0])
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'qm-neuron-vecmeta-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'memory.db') })
  await storeFiber
  const historyFiber = ctx.plugin(historyPlugin)
  await historyFiber
  const embedding = new CountingEmbedding(ctx)
  const memoryFiber = ctx.plugin(memoryPlugin, { limit: 5, ticks: 4 })
  await memoryFiber
  try {
    await ctx.memory.ingest([
      { kind: 'fact', subject: '主人', predicate: '住在', object: '杭州', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
      { kind: 'episode', subject: 'session:s1', predicate: '说', object: '聊到杭州的天气', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
    ])
    const store = ctx.reflect.get('store', false) as { collection(name: string): { find(): Promise<any[]> } }
    const facts = await store.collection('qm_mem_fact').find({})
    const episodes = await store.collection('qm_episode').find({})
    assert.equal(facts[0].vector_model, 'fake-model')
    assert.ok(facts[0].vector_json)
    assert.equal(episodes[0].vector_model, 'fake-model')
    assert.ok(episodes[0].vector_json)

    const callsBefore = embedding.calls
    await ctx.memory.recall({ text: '杭州天气', limit: 5 })
    const afterFirst = embedding.calls
    await ctx.memory.recall({ text: '杭州天气', limit: 5 })
    assert.equal(embedding.calls, afterFirst, '同一问题应命中缓存，不再调 embedding')
    assert.equal(afterFirst, callsBefore + 1)
  } finally {
    await memoryFiber.dispose()
    await historyFiber.dispose()
    await storeFiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('关系图别名：包含已有实体名的新说法并入同一节点', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      { kind: 'fact', subject: '主人', predicate: '在做项目', object: '三国', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
      { kind: 'fact', subject: '主人', predicate: '进度', object: '三国项目', confidence: 0.9, sensitivity: 'private', origin: ORIGIN },
    ])
    const neighbors = await ctx.memory.neighbors('三国', { depth: 1 })
    const entity = neighbors.entities.find((item) => item.name === '三国')
    assert.ok(entity)
    assert.ok(entity!.aliases.includes('三国项目'))
    assert.ok(neighbors.text.includes('主人 —在做项目→ 三国'))
  } finally {
    await dispose()
  }
})


