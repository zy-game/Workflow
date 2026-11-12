#!/usr/bin/env node
/**
 * 关系图回填：把已有事实与 episode 转成实体/边（幂等）。
 * 新数据在 ingest 时自动落图；这个脚本只用于升级后补历史。
 *
 * 用法：node scripts/backfill-graph.mjs [--db data/qm.db]
 */
import path from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '../packages/provider-store-sqlite/src/index.ts'
import * as historyPlugin from '../packages/qm-history/src/index.ts'
import * as memoryPlugin from '../packages/provider-neuron-memory/src/index.ts'

const args = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}
const dbPath = path.resolve(argValue('--db', 'data/qm.db'))

const ctx = new Context()
const storeFiber = ctx.plugin(storePlugin, { path: dbPath })
await storeFiber
const historyFiber = ctx.plugin(historyPlugin)
await historyFiber
const memoryFiber = ctx.plugin(memoryPlugin, { limit: 8 })
await memoryFiber

try {
  const result = await ctx.memory.rebuildGraph({ reset: args.includes('--reset') })
  console.log(JSON.stringify({ db: dbPath, ...result }, null, 2))
} finally {
  await memoryFiber.dispose()
  await historyFiber.dispose()
  await storeFiber.dispose()
}

