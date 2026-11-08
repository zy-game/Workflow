import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFacts } from '../src/index.ts'

test('parseFacts：解析纯 JSON 数组', () => {
  const records = parseFacts(
    '[{"subject":"主人","predicate":"下周三要去","object":"杭州","confidence":0.9}]',
    's_owner',
    0.6,
    5,
  )
  assert.equal(records.length, 1)
  assert.equal(records[0]?.subject, '主人')
  assert.equal(records[0]?.object, '杭州')
  assert.deepEqual(records[0]?.origin, { kind: 'channel', id: 's_owner' })
})

test('parseFacts：容忍 ```json 围栏与前后废话', () => {
  const raw = '好的，结果如下：\n```json\n[{"subject":"主人","predicate":"喜欢","object":"咖啡","confidence":0.8}]\n```\n希望有帮助'
  const records = parseFacts(raw, 's1', 0.6, 5)
  assert.equal(records.length, 1)
})

test('parseFacts：低置信度、缺字段、非数组都安全丢弃', () => {
  assert.equal(parseFacts('[]', 's', 0.6, 5).length, 0)
  assert.equal(parseFacts('not json at all', 's', 0.6, 5).length, 0)
  assert.equal(
    parseFacts('[{"subject":"主人","predicate":"喜欢","object":"咖啡","confidence":0.3}]', 's', 0.6, 5).length,
    0,
  )
  assert.equal(parseFacts('[{"subject":"","predicate":"喜欢","object":"咖啡"}]', 's', 0.6, 5).length, 0)
})

test('parseFacts：遵守 maxFacts 上限', () => {
  const many = JSON.stringify(
    Array.from({ length: 10 }, (_, i) => ({
      subject: '主人',
      predicate: '记住',
      object: `第${i}件事`,
      confidence: 0.9,
    })),
  )
  assert.equal(parseFacts(many, 's', 0.6, 3).length, 3)
})
