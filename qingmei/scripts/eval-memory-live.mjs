/**
 * 生产记忆评估：真实服务 + 人工查询集。
 *
 * 不提交个人 fixture；默认用 example：
 *   QM_URL=https://... QM_TOKEN=... node scripts/eval-memory-live.mjs
 * 或：
 *   QM_MEMORY_EVAL=/path/to/memory-eval-live.json ...
 *
 * 查询集格式：
 *   { "queries": [{ "text": "...", "expect": "..." }] }
 */
import { readFileSync } from 'node:fs'

const base = String(process.env.QM_URL ?? 'http://127.0.0.1:7410').replace(/\/+$/, '')
const token = String(process.env.QM_TOKEN ?? '')
const fixturePath = process.env.QM_MEMORY_EVAL ?? new URL('./fixtures/memory-eval-live.example.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const queries = Array.isArray(fixture.queries) ? fixture.queries : []
if (queries.length === 0) throw new Error('评估集没有 queries')

const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
const results = []
for (const query of queries) {
  const url = `${base}/api/v1/memory?q=${encodeURIComponent(query.text)}&limit=3`
  const res = await fetch(url, { headers, cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${query.text}`)
  const body = await res.json()
  const facts = Array.isArray(body?.facts) ? body.facts : []
  const rank = facts.findIndex((fact) => String(fact.object).includes(query.expect)) + 1
  results.push({ query: query.text, expect: query.expect, rank, top: facts.map((fact) => fact.object) })
}

const at1 = results.filter((item) => item.rank === 1).length / results.length
const at3 = results.filter((item) => item.rank >= 1 && item.rank <= 3).length / results.length
console.log(JSON.stringify({ queries: results.length, recallAt1: at1, recallAt3: at3, results }, null, 2))
if (at3 < 0.8) {
  console.error(`[eval-memory-live] recall@3 ${(at3 * 100).toFixed(0)}% < 80%`)
  process.exitCode = 1
}
