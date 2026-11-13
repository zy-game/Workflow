#!/usr/bin/env node
/**
 * 真实问法评估：fixture 里的 questions 来自生产用户消息，facts 来自生产记忆。
 * 期望由人标注（expected 为空 = 这题不该靠记忆回答，只检查不崩）。
 *
 * 用法：
 *   node scripts/eval-real-questions.mjs [--embedding] [--debug]
 * 输出每题命中情况与总体命中率；没有 embedding key 时按词面召回跑。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '../packages/provider-store-sqlite/src/index.ts'
import * as historyPlugin from '../packages/qm-history/src/index.ts'
import * as memoryPlugin from '../packages/provider-neuron-memory/src/index.ts'
import * as embeddingPlugin from '../packages/provider-embedding-http/src/index.ts'

const debug = process.argv.includes('--debug')
const minArg = process.argv.find((arg) => arg.startsWith('--min='))
const minRate = minArg ? Number(minArg.slice('--min='.length)) : 0
const fixtureArg = process.argv.find((arg) => arg.startsWith('--fixture='))
const fixturePath = fixtureArg
  ? path.resolve(fixtureArg.slice('--fixture='.length))
  : new URL('../packages/provider-neuron-memory/test/fixtures/real-eval.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const dir = mkdtempSync(join(tmpdir(), 'qm-real-eval-'))
const ctx = new Context()
const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'eval.db') })
await storeFiber
const historyFiber = ctx.plugin(historyPlugin)
await historyFiber
const withEmbedding = process.argv.includes('--embedding') && Boolean(process.env.QM_EMBEDDING_URL)
if (withEmbedding) {
  await ctx.plugin(embeddingPlugin, {
    url: process.env.QM_EMBEDDING_URL,
    apiKey: process.env.QM_EMBEDDING_KEY,
    model: process.env.QM_EMBEDDING_MODEL ?? 'embedding-3',
  })
}
const memoryFiber = ctx.plugin(memoryPlugin, { limit: 16 })
await memoryFiber

try {
  for (const fact of fixture.facts) {
    await ctx.memory.ingest([
      {
        kind: 'fact',
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        confidence: 0.9,
        sensitivity: 'private',
        origin: { kind: 'manual', id: 'real-eval' },
        occurredAt: fact.createdAt ? new Date(fact.createdAt) : undefined,
      },
    ])
  }

  const scored = []
  for (const item of fixture.questions) {
    const result = await ctx.memory.recall({ text: item.question, limit: 16 })
    const text = result.text
    const hit = item.expected.length === 0 ? null : item.expected.some((needle) => text.includes(needle))
    scored.push({ question: item.question, expected: item.expected, hit })
    if (debug) {
      console.log(`\nQ: ${item.question}`)
      console.log(`expected: ${item.expected.join(' / ') || '（不依赖记忆）'} -> ${hit === null ? 'skip' : hit ? 'HIT' : 'MISS'}`)
      console.log(result.facts.slice(0, 3).map((fact) => `- ${fact.object}`).join('\n'))
    }
  }

  const judged = scored.filter((item) => item.hit !== null)
  const hits = judged.filter((item) => item.hit).length
  for (const item of judged) console.log(`${item.hit ? '✔' : '✘'} ${item.question}`)
  const rate = judged.length === 0 ? 0 : hits / judged.length
  console.log(`\n[real-eval] ${hits}/${judged.length}（${Math.round(rate * 100)}%）embedding=${withEmbedding ? 'on' : 'off'}`)
  if (judged.length > 0 && rate < Math.max(0.5, minRate)) process.exitCode = 1
} finally {
  await memoryFiber.dispose()
  await historyFiber.dispose()
  await storeFiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}








