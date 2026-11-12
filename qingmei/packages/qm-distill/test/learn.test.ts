/**
 * 教训 / 决策抽取的单元测试：只认明确句式，问句和假设不抽。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractLearnings } from '../src/learn.ts'

test('教训：以后/下次不要、踩坑与根因', () => {
  const items = extractLearnings('以后不要用 NSIS 了，问题太多。')
  assert.equal(items[0]?.kind, 'lesson')
  assert.match(items[0]!.text, /不要用 NSIS/)
  assert.equal(items[0]?.rule, 'lesson-do-not')

  const pitfall = extractLearnings('这次踩坑是因为没检查磁盘空间')
  assert.equal(pitfall[0]?.kind, 'lesson')
})

test('决策：决定/采用/选型', () => {
  const decided = extractLearnings('决定用 Inno Setup 做安装包')
  assert.equal(decided[0]?.kind, 'decision')
  assert.equal(decided[0]?.rule, 'decision-pick')

  const adopted = extractLearnings('方案定了，采用 SQLite 单文件')
  assert.ok(adopted.some((item) => item.kind === 'decision'))
})

test('问句与假设不抽', () => {
  assert.deepEqual(extractLearnings('以后要不要用 NSIS？'), [])
  assert.deepEqual(extractLearnings('如果决定用 NSIS 会怎样'), [])
})

test('一段话里多条教训按句切开', () => {
  const items = extractLearnings('以后不要晚上喝咖啡。决定早上喝。')
  assert.equal(items.length, 2)
})
