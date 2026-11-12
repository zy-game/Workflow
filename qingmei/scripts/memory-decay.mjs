#!/usr/bin/env node
/**
 * 记忆分层退化：把 7 天前的 episode 压成日摘要、28 天前压周摘要、90 天前压月摘要。
 *
 * 只做记忆，不动事实；原文软删（valid_to），摘要带 provenance，可回溯。
 * 服务器每天 04:00 跑一次（/etc/cron.d/qingmei-memory）。
 *
 * 用法：node scripts/memory-decay.mjs [--db data/qm.db] [--dry]
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
  const report = await ctx.memory.consolidateEpisodes()
  console.log(JSON.stringify({ db: dbPath, ...report }, null, 2))
} finally {
  await memoryFiber.dispose()
  await historyFiber.dispose()
  await storeFiber.dispose()
}
