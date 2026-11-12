#!/usr/bin/env node
/**
 * 时间锚定的记忆评估：每条事实有发生时间，问题带时间窗。
 * 验证「最近清楚、久远有摘要」是否真的可检索，而不是只验证词面匹配。
 *
 * 运行：node scripts/eval-memory-time.mjs
 * 阈值：recall@5 ≥ 80%，否则退出码 1。
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '../packages/provider-store-sqlite/src/index.ts'
import * as historyPlugin from '../packages/qm-history/src/index.ts'
import * as memoryPlugin from '../packages/provider-neuron-memory/src/index.ts'

const DAY = 86_400_000
const fixture = JSON.parse(readFileSync(new URL('./fixtures/memory-time-eval.json', import.meta.url), 'utf8'))
const now = new Date()
const dir = mkdtempSync(join(tmpdir(), 'qm-mem-time-'))
const ctx = new Context()
const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'eval.db') })
await storeFiber
const historyFiber = ctx.plugin(historyPlugin)
await historyFiber
const memoryFiber = ctx.plugin(memoryPlugin, { limit: 8 })
await memoryFiber

const results = []
try {
  for (const [index, item] of fixture.cases.entries()) {
    await ctx.memory.ingest([
      {
        kind: 'fact',
        subject: '主人',
        predicate: `事实${index}`,
        object: item.expected,
        confidence: 0.9,
        sensitivity: 'private',
        origin: { kind: 'manual', id: 'time-eval' },
        occurredAt: new Date(now.getTime() - item.factDaysAgo * DAY),
      },
    ])
  }

  for (const item of fixture.cases) {
    const recalled = await ctx.memory.recall({
      text: item.question,
      limit: 5,
      since: new Date(now.getTime() - item.sinceDaysAgo * DAY),
      until: new Date(now.getTime() - item.untilDaysAgo * DAY),
    })
    const hit = recalled.text.includes(item.expected)
    results.push({ id: item.id, hit, top: recalled.facts.slice(0, 3).map((fact) => fact.object) })
  }
} finally {
  await memoryFiber.dispose()
  await historyFiber.dispose()
  await storeFiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}

const hitCount = results.filter((item) => item.hit).length
const recall = hitCount / results.length
console.log(JSON.stringify({ cases: results.length, hit: hitCount, recallAt5: Number(recall.toFixed(3)), misses: results.filter((item) => !item.hit) }, null, 2))

if (recall < 0.8) {
  console.error(`[eval-memory-time] recall@5 ${(recall * 100).toFixed(0)}% < 80%`)
  process.exitCode = 1
}
