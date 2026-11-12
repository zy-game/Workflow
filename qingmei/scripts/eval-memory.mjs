/**
 * 记忆质量评估：在临时 SQLite 中灌入固定事实，测 recall@1 / recall@3。
 *
 * 这是“可重复的回归集”，不是线上真实用户数据。
 * 运行：node scripts/eval-memory.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '../packages/provider-store-sqlite/src/index.ts'
import * as historyPlugin from '../packages/qm-history/src/index.ts'
import * as memoryPlugin from '../packages/provider-neuron-memory/src/index.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/memory-eval.json', import.meta.url), 'utf8'))
const dir = mkdtempSync(join(tmpdir(), 'qm-eval-memory-'))
const ctx = new Context()
const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'memory.db') })
await storeFiber
const historyFiber = ctx.plugin(historyPlugin)
await historyFiber
const memoryFiber = ctx.plugin(memoryPlugin, { limit: 8 })
await memoryFiber

try {
  await ctx.memory.ingest(fixture.facts.map((fact) => ({
    kind: 'fact',
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    confidence: 0.9,
    sensitivity: 'private',
    origin: { kind: 'manual', id: 'eval' },
  })))

  const results = []
  for (const query of fixture.queries) {
    // limit 8 与生产默认召回条数一致；同时记录前 1/3/8 名
    const hit = await ctx.memory.recall({ text: query.text, limit: 8 })
    const rank = hit.facts.findIndex((fact) => String(fact.object).includes(query.expect)) + 1
    results.push({ query: query.text, expect: query.expect, rank, top: hit.facts.slice(0, 3).map((fact) => fact.object) })
  }

  const at = (k) => results.filter((item) => item.rank >= 1 && item.rank <= k).length / results.length
  const report = { queries: results.length, recallAt1: at(1), recallAt3: at(3), recallAt8: at(8), results }
  console.log(JSON.stringify(report, null, 2))
  if (at(3) < 0.85) {
    console.error(`[eval-memory] recall@3 ${(at(3) * 100).toFixed(0)}% < 85%`)
    process.exitCode = 1
  }
} finally {
  await memoryFiber.dispose()
  await historyFiber.dispose()
  await storeFiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}
