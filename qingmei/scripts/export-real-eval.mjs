#!/usr/bin/env node
/**
 * 从生产/本地数据库导出「真实问法」评估候选。
 *
 * 只做导出，不做判定：questions 来自真实用户消息，facts 来自真实记忆；
 * 期望答案由人标注（expected 为空表示“这题不该靠记忆回答”）。
 *
 * 用法：
 *   node scripts/export-real-eval.mjs --db data/qm.db --out packages/provider-neuron-memory/test/fixtures/real-eval.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const dbPath = arg('--db', 'data/qm.db')
const outPath = arg('--out', 'packages/provider-neuron-memory/test/fixtures/real-eval.json')
const db = new DatabaseSync(dbPath, { readOnly: true })

const messages = db
  .prepare("SELECT json FROM records WHERE name='qm_message' ORDER BY rowid ASC")
  .all()
  .map((row) => JSON.parse(row.json))
const facts = db
  .prepare("SELECT json FROM records WHERE name='qm_mem_fact' ORDER BY rowid ASC")
  .all()
  .map((row) => JSON.parse(row.json))
  .filter((fact) => !fact.valid_to)

const questions = messages
  .filter((message) => message.role === 'user' && /[?？]|怎么|什么|哪|多少|有没有/.test(String(message.text)))
  .map((message) => String(message.text).trim().slice(0, 200))
  .filter((text, index, list) => text && list.indexOf(text) === index)
  .slice(-40)

const fixture = {
  generatedAt: new Date().toISOString(),
  source: dbPath,
  questions: questions.map((question) => ({ question, expected: [] })),
  facts: facts.map((fact) => ({
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    createdAt: fact.created_at,
  })),
}

writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
console.log(`[real-eval] 导出 ${fixture.questions.length} 个真实问题、${fixture.facts.length} 条事实 → ${outPath}`)
console.log('下一步：人工给 questions[].expected 填期望包含的 object 片段；留空表示不依赖记忆。')
void readFileSync
