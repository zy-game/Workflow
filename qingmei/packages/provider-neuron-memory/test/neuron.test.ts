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

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-neuron-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'memory.db') })
  await storeFiber
  const historyFiber = ctx.plugin(historyPlugin)
  await historyFiber
  const memoryFiber = ctx.plugin(memoryPlugin, { limit: 5, ticks: 4 })
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
