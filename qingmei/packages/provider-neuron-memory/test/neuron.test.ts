import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as historyPlugin from '@qingmei/qm-history'
import * as memoryPlugin from '../src/index.ts'
import { tokenize } from '../src/index.ts'

const ORIGIN = { kind: 'channel' as const, id: 's_neuron' }

async function setup(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-neuron-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'memory.db') })
  await storeFiber
  const historyFiber = ctx.plugin(historyPlugin)
  await historyFiber
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

