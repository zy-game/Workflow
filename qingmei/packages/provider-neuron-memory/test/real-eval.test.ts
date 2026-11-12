import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/real-eval.json', import.meta.url), 'utf8'),
) as {
  questions: Array<{ question: string; expected: string[] }>
  facts: Array<{ subject: string; predicate: string; object: string }>
  generatedAt: string
}

test('真实问法评估集：问题与事实都来自生产导出', () => {
  assert.ok(fixture.questions.length >= 10, '至少 10 个真实问题')
  assert.ok(fixture.facts.length >= 50, '至少 50 条生产事实')
  assert.match(fixture.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.ok(fixture.questions.every((item) => typeof item.question === 'string' && Array.isArray(item.expected)))
})

test('真实问法评估集：至少 8 题有人工标注的期望', () => {
  const labeled = fixture.questions.filter((item) => item.expected.length > 0)
  assert.ok(labeled.length >= 8, `已标注 ${labeled.length} 题`)
  assert.ok(fixture.questions.some((item) => item.expected.length === 0), '保留“不该靠记忆回答”的负例')
})
