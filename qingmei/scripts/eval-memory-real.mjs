#!/usr/bin/env node
/**
 * 真实数据记忆评估：生产事实（overlap）+ 换词重述（near）+ 语义同义但零字面重叠（zero）。
 *
 * 目的不是刷高总分，而是把「词面匹配能做到多少、语义缺口有多大」量出来。
 *
 * 运行：node scripts/eval-memory-real.mjs [--debug]
 * 门槛：overlap ≥ 80%（真实数据可用性）；zero 只报告、不设门槛（当前能力达不到）。
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '../packages/provider-store-sqlite/src/index.ts'
import * as historyPlugin from '../packages/qm-history/src/index.ts'
import * as memoryPlugin from '../packages/provider-neuron-memory/src/index.ts'
import * as embeddingPlugin from '../packages/provider-embedding-http/src/index.ts'

const debug = process.argv.includes('--debug')
const fixture = JSON.parse(readFileSync(new URL('./fixtures/memory-real-eval.json', import.meta.url), 'utf8'))
const dir = mkdtempSync(join(tmpdir(), 'qm-mem-real-'))
const ctx = new Context()
const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'eval.db') })
await storeFiber
const historyFiber = ctx.plugin(historyPlugin)
await historyFiber
if (process.argv.includes('--embedding') && process.env.QM_EMBEDDING_URL) {
  await ctx.plugin(embeddingPlugin, {
    url: process.env.QM_EMBEDDING_URL,
    apiKey: process.env.QM_EMBEDDING_KEY,
    model: process.env.QM_EMBEDDING_MODEL ?? 'embedding-3',
  })
}
const memoryFiber = ctx.plugin(memoryPlugin, { limit: 8 })
await memoryFiber

const results = []
try {
  for (const item of fixture.cases) {
    await ctx.memory.ingest([
      {
        kind: 'fact',
        subject: item.fact.subject,
        // 评估时每条事实用独立 predicate：同一 subject+predicate 的不同 object 会互相 supersede，
        // 这是记忆的正确语义，但会让评估互相污染
        predicate: `${item.fact.predicate}#${item.id}`,
        object: item.fact.object,
        confidence: 0.9,
        sensitivity: 'private',
        origin: { kind: 'manual', id: 'real-eval' },
      },
    ])
  }
  if (debug) {
    const store = ctx.reflect.get('store', false)
    const live = (await store.collection('qm_mem_fact').find({})).filter((row) => !row.valid_to)
    console.log(`[debug] live facts: ${live.length}`)
    for (const question of ['我平时爱喝什么咖啡', '咖啡', '我的手冲咖啡呢']) {
      const probe = await ctx.memory.recall({ text: question, limit: 5 })
      console.log('[debug]', question, '->', probe.facts.length, JSON.stringify(probe.facts.map((fact) => fact.object)))
    }
  }
  for (const item of fixture.cases) {
    const recalled = await ctx.memory.recall({ text: item.question, limit: 5 })
    if (debug && item.id === 'n02') console.log('[debug] n02 facts', recalled.facts.length, JSON.stringify(recalled.text))
    results.push({
      id: item.id,
      subset: item.subset,
      hit: recalled.text.includes(item.fact.object),
      top: recalled.facts.slice(0, 3).map((fact) => fact.object),
    })
  }
} finally {
  await memoryFiber.dispose()
  await historyFiber.dispose()
  await storeFiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}

const summary = {}
for (const subset of ['overlap', 'near', 'zero']) {
  const items = results.filter((item) => item.subset === subset)
  const hits = items.filter((item) => item.hit).length
  summary[subset] = { cases: items.length, hit: hits, recallAt5: items.length > 0 ? Number((hits / items.length).toFixed(3)) : null }
}
console.log(JSON.stringify({ summary, misses: results.filter((item) => !item.hit) }, null, 2))

if ((summary.overlap?.recallAt5 ?? 0) < 0.8) {
  console.error(`[eval-memory-real] overlap recall@5 ${(summary.overlap.recallAt5 * 100).toFixed(0)}% < 80%`)
  process.exitCode = 1
}



