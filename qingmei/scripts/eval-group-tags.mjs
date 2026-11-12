#!/usr/bin/env node
/**
 * 群画像标签建议的评估：用固定语料跑 classifySuggestion，算准确率与混淆矩阵。
 *
 * 这个建议只用于「提示主人」，不会自动打标签；但准确率太低会变成噪音，
 * 所以要有数字，而不是靠感觉。
 *
 * 运行：node scripts/eval-group-tags.mjs
 * 阈值：整体准确率 ≥ 80%，否则退出码 1（gate 会拦）。
 */
import { readFileSync } from 'node:fs'
import { classifySuggestion } from '../packages/qm-autonomy/src/modules/conversation-profile.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/group-tags-eval.json', import.meta.url), 'utf8'))
const TAGS = ['client', 'work', 'family', 'casual']
const THRESHOLD = 0.8

const confusion = Object.fromEntries(TAGS.map((tag) => [tag, Object.fromEntries(TAGS.map((other) => [other, 0]))]))
const results = []

for (const item of fixture.cases) {
  const suggestion = classifySuggestion(item.messages)
  confusion[item.expected][suggestion.tag] += 1
  results.push({
    id: item.id,
    expected: item.expected,
    predicted: suggestion.tag,
    correct: suggestion.tag === item.expected,
    evidence: suggestion.evidence,
  })
}

const total = results.length
const correct = results.filter((item) => item.correct).length
const accuracy = correct / total

const perTag = {}
for (const tag of TAGS) {
  const expectedCount = results.filter((item) => item.expected === tag).length
  const predictedCount = results.filter((item) => item.predicted === tag).length
  const truePositive = confusion[tag][tag]
  perTag[tag] = {
    support: expectedCount,
    precision: predictedCount > 0 ? Number((truePositive / predictedCount).toFixed(3)) : null,
    recall: expectedCount > 0 ? Number((truePositive / expectedCount).toFixed(3)) : null,
  }
}

const report = { cases: total, correct, accuracy: Number(accuracy.toFixed(3)), threshold: THRESHOLD, perTag, confusion, misses: results.filter((item) => !item.correct) }
console.log(JSON.stringify(report, null, 2))

if (accuracy < THRESHOLD) {
  console.error(`[eval-group-tags] 准确率 ${(accuracy * 100).toFixed(0)}% < ${THRESHOLD * 100}%`)
  process.exitCode = 1
}
