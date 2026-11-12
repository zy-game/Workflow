#!/usr/bin/env node
/**
 * 给已有事实补语义向量（升级/开启 embedding 后跑一次）。
 *
 * 需要环境变量：
 *   QM_EMBEDDING_URL / QM_EMBEDDING_KEY / QM_EMBEDDING_MODEL
 *
 * 用法：node scripts/backfill-vectors.mjs [--db data/qm.db]
 */
import path from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '../packages/provider-store-sqlite/src/index.ts'
import * as historyPlugin from '../packages/qm-history/src/index.ts'
import * as memoryPlugin from '../packages/provider-neuron-memory/src/index.ts'
import * as embeddingPlugin from '../packages/provider-embedding-http/src/index.ts'

const args = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}
const dbPath = path.resolve(argValue('--db', 'data/qm.db'))
const url = process.env.QM_EMBEDDING_URL
if (!url) {
  console.error('缺少 QM_EMBEDDING_URL：先配置 embedding 端点再回填')
  process.exitCode = 1
} else {
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: dbPath })
  await storeFiber
  const historyFiber = ctx.plugin(historyPlugin)
  await historyFiber
  await ctx.plugin(embeddingPlugin, { url, apiKey: process.env.QM_EMBEDDING_KEY, model: process.env.QM_EMBEDDING_MODEL })
  const memoryFiber = ctx.plugin(memoryPlugin, { limit: 8 })
  await memoryFiber
  try {
    const result = await ctx.memory.rebuildVectors()
    console.log(JSON.stringify({ db: dbPath, ...result }, null, 2))
  } finally {
    await memoryFiber.dispose()
    await historyFiber.dispose()
    await storeFiber.dispose()
  }
}
