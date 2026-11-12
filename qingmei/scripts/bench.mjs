#!/usr/bin/env node
/**
 * 性能基线：给「数据量上来之后会不会卡」一个可复跑的数字。
 *
 * 不测模型、不测网络，只测本机 SQLite 上的三件慢事：
 *   1. store 的 JSON 查询（有 where/limit 时下推成 SQL，没有就全表扫）；
 *   2. 日程 tick 的扫描成本（tick 每次 `collection.find()` 全表）；
 *   3. 神经元记忆召回的延迟（2000 条事实）。
 *
 * 运行：node scripts/bench.mjs [--rows 20000] [--facts 2000]
 * 输出 JSON；数字写进 docs/32-性能基线.md。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '../packages/provider-store-sqlite/src/index.ts'
import * as historyPlugin from '../packages/qm-history/src/index.ts'
import * as memoryPlugin from '../packages/provider-neuron-memory/src/index.ts'

const args = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 ? Number(args[index + 1]) : fallback
}
const ROWS = argValue('--rows', 20_000)
const FACTS = argValue('--facts', 2_000)

const dir = mkdtempSync(join(tmpdir(), 'qm-bench-'))
const ctx = new Context()
const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'bench.db') })
await storeFiber
await ctx.store.ready()
const rows = ctx.store.collection('qm_bench_row')

async function time(fn) {
  const started = process.hrtime.bigint()
  const value = await fn()
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, value }
}

// 1) store：批量写入 + 两种查询
const writeStarted = process.hrtime.bigint()
for (let index = 0; index < ROWS; index += 1) {
  await rows.insert({
    id: `row_${index}`,
    status: index % 3 === 0 ? 'queued' : 'done',
    group: `g${index % 50}`,
    created_at: index,
  })
}
const writeMs = Number(process.hrtime.bigint() - writeStarted) / 1e6

const pushdown = await time(() => rows.find({ where: { status: 'queued' }, limit: 20 }))
const orderLimit = await time(() => rows.find({ order: [{ field: 'created_at', dir: 'desc' }], limit: 20 }))
const fullScan = await time(() => rows.find({}))
const countWhere = await time(() => rows.count({ where: { status: 'queued' } }))

// 2) 日程 tick 的扫描成本：tick 里就是一次 collection.find()
const schedules = ctx.store.collection('qm_schedule')
for (let index = 0; index < Math.min(ROWS, 10_000); index += 1) {
  await schedules.insert({
    id: `sch_${index}`,
    text: `提醒 ${index}`,
    next_at: Date.now() + 86_400_000,
    fired_at: null,
    paused_at: null,
  })
}
const tickScan = await time(() => schedules.find())

// 3) 记忆召回：2000 条事实 + 20 次查询
const memoryCtx = new Context()
const memoryStore = memoryCtx.plugin(storePlugin, { path: join(dir, 'memory.db') })
await memoryStore
const historyFiber = memoryCtx.plugin(historyPlugin)
await historyFiber
const memoryFiber = memoryCtx.plugin(memoryPlugin, { limit: 8 })
await memoryFiber

const subjects = ['主人', '李四', '王五', '项目', '青梅']
const objects = ['手冲咖啡', '杭州出差', '每周跑步', 'SQLite 数据库', 'DeepSeek Harness', '龙井茶', '键盘', '显示器']
await memoryCtx.memory.ingest(
  Array.from({ length: FACTS }, (_, index) => ({
    kind: 'fact',
    subject: subjects[index % subjects.length],
    predicate: `事实${index % 37}`,
    object: `${objects[index % objects.length]}#${index}`,
    confidence: 0.9,
    sensitivity: 'private',
    origin: { kind: 'manual', id: 'bench' },
  })),
)

const queries = ['手冲咖啡', '杭州出差', '数据库', '执行器', '龙井', '键盘', '跑步', '显示器']
const recallStarted = process.hrtime.bigint()
for (let index = 0; index < 20; index += 1) {
  await memoryCtx.memory.recall({ text: queries[index % queries.length], limit: 8 })
}
const recallMs = Number(process.hrtime.bigint() - recallStarted) / 1e6 / 20

const report = {
  at: new Date().toISOString(),
  store: {
    rows: ROWS,
    writeMs: Number(writeMs.toFixed(0)),
    pushdownFindMs: Number(pushdown.ms.toFixed(2)),
    orderLimitMs: Number(orderLimit.ms.toFixed(2)),
    fullScanMs: Number(fullScan.ms.toFixed(2)),
    countWhereMs: Number(countWhere.ms.toFixed(2)),
  },
  schedule: { rows: Math.min(ROWS, 10_000), tickScanMs: Number(tickScan.ms.toFixed(2)) },
  memory: { facts: FACTS, avgRecallMs: Number(recallMs.toFixed(2)) },
}
console.log(JSON.stringify(report, null, 2))

await memoryFiber.dispose()
await historyFiber.dispose()
await memoryStore.dispose()
await storeFiber.dispose()
rmSync(dir, { recursive: true, force: true })
